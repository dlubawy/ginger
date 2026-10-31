/**
 * Auto-Nudge Extension
 *
 * Watches for the end of an agent's turn (one full response to a user prompt)
 * and decides whether the agent truly needs human input before it can go on,
 * or whether a light nudge ("Continue your work.") would get it back to work.
 *
 * State machine:
 *   - AGENT_TURN_COMPLETED starts as `false` whenever a real user prompts the
 *     agent (reset on every interactive/rpc input event).
 *   - When the agent's turn ends (`agent_end`) and AGENT_TURN_COMPLETED is
 *     still `false`, whether the agent needs human input is decided:
 *       1. Primary: the provider's classifier endpoint (POST <baseUrl>/systemone,
 *          same API key as the LLM). The returned "yes" probability (noul)
 *          >= NUDGE_THRESHOLD means done; below it means nudge. The text sent
 *          is truncated to fit the endpoint's 1024-token context window.
 *       2. Fallback: if the classifier is unavailable or fails, the last few
 *          assistant messages are evaluated with keyword heuristics (question,
 *          request for confirmation, or an explicit "all done" report).
 *     If judged as needing human input -> AGENT_TURN_COMPLETED = true and the
 *     turn ends. Otherwise a nudge user message is sent, which restarts the
 *     agent loop. After MAX_NUDGES consecutive nudges we give up and set
 *     AGENT_TURN_COMPLETED = true to avoid infinite loops.
 *   - If the turn was interrupted by the user (e.g. ESC, stopReason
 *     "aborted"), no nudge is sent: the interruption is a deliberate stop,
 *     so AGENT_TURN_COMPLETED is set to true and the turn ends.
 *   - The next real user prompt resets AGENT_TURN_COMPLETED to `false` and the
 *     cycle starts over.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_NUDGES = 3;
const NUDGE_TEXT = "[Automation: /etc/pi/agent/extensions/auto-nudge.ts]\n[Incomplete work detected]\nContinue your work.";
const EVALUATION_WINDOW = 3; // how many recent assistant messages to inspect

// Classifier settings. The /systemone endpoint has a hard 1024-token context
// window, so the text we send it must stay well under that once the question,
// criteria and JSON scaffolding are counted.
const CLASSIFIER_ENDPOINT =
  process.env.AUTO_NUDGE_CLASSIFIER_URL ?? "/systemone";
const CLASSIFIER_MODEL = process.env.AUTO_NUDGE_CLASSIFIER_MODEL ?? "default";
const NUDGE_THRESHOLD = Number(
  process.env.AUTO_NUDGE_CLASSIFIER_THRESHOLD ?? 0.5,
);
// ~200-250 tokens of text; leaves comfortable headroom inside the 1024 window.
const CLASSIFIER_TEXT_LIMIT = Number(
  process.env.AUTO_NUDGE_CLASSIFIER_CHARS ?? 800,
);

// Classifier prompt. Tuned so "done" requires an explicit end-of-conversation
// signal, and any hint of remaining or interrupted work counts as not done.
const CLASSIFIER_INSTRUCTIONS =
  "Is this AI agent completely finished with its tasks, such that it cannot continue without new human input?";
const CLASSIFIER_TRUE_CRITERIA =
  "It asks the user a question, requests confirmation, approval, or a choice, or reports all work as finished in a final summary. No pending or upcoming actions are described.";
const CLASSIFIER_FALSE_CRITERIA =
  "It leaves work unfinished: describes ongoing or interrupted activity (e.g. 'was in the middle of', cut-off sentences, trailing ellipsis), states upcoming steps ('next I will', 'then I'll'), lists remaining tasks, or stops without a clear final summary.";

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

/**
 * Core boolean state. `false` while the agent is expected to keep working
 * after a user prompt, `true` once the turn is genuinely finished and may end.
 */
let AGENT_TURN_COMPLETED = false;

/** Number of consecutive nudges sent for the current user prompt. */
let nudgesSent = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shape of the message fields this extension cares about. */
type MessageLike = {
  role?: string;
  content?: unknown;
  stopReason?: string;
};

/** Pull plain text out of a message whose content is a string or block array. */
function extractText(message: MessageLike): string {
  if (message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

/** Signals the agent is waiting on the human. Checked anywhere in the message. */
const AWAITING_USER = [
  // Direct questions to the user
  /\bwould you like\b/i,
  /\bshall i\b/i,
  /\bshould i\b/i,
  /\bdo you want\b/i,
  /\bwhat would you (prefer|like)\b/i,
  /\bwhich (option|approach|one)\b/i,
  // Requests for confirmation / review / a decision
  /\bplease confirm\b/i,
  /\bplease review\b/i,
  /\blet me know\b/i,
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bawaiting (your|the)\b/i,
];

/** Explicit completion reports. Only matched near the end of the message so
 *  mid-work phrasing like "All set up, now running tests..." doesn't count. */
const FINISHED_WORKING = [
  /\bi'?ve (completed|finished)\b/i,
  /\ball done\b/i,
  /\btask is (complete|done|finished)\b/i,
  /\beverything is (done|complete|finished)\b/i,
  /\bnothing else to do\b/i,
];

const TAIL_LENGTH = 140; // characters at the end of a message checked for completion

/**
 * True when the turn ended because the user interrupted it (e.g. pressed
 * ESC). Aborted assistant messages carry stopReason "aborted".
 */
function wasAborted(messages: readonly MessageLike[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    return message.stopReason === "aborted";
  }
  return false;
}

/**
 * Fallback heuristic: evaluate the last few assistant messages and return
 * true when the agent appears to need human input (or has genuinely
 * finished), false when it looks like it stopped mid-work and could be
 * nudged along.
 */
function needsHumanInput(messages: readonly MessageLike[]): boolean {
  const recentTexts = messages
    .map(extractText)
    .filter((text) => text.trim().length > 0)
    .slice(-EVALUATION_WINDOW);

  if (recentTexts.length === 0) {
    // No assistant text at all: something is off, a nudge is the safe bet.
    return false;
  }

  const last = recentTexts[recentTexts.length - 1];

  for (const pattern of AWAITING_USER) {
    if (pattern.test(last)) return true;
  }

  // A trailing question mark on the final line usually means the agent is
  // asking the user something it cannot answer itself.
  const lastLine = last.trim().split(/\r?\n/).pop() ?? "";
  if (/\?\s*$/.test(lastLine)) return true;

  // Completion reports only count when they land at the end of the message.
  const tail = last.slice(-TAIL_LENGTH);
  for (const pattern of FINISHED_WORKING) {
    if (pattern.test(tail)) return true;
  }

  return false;
}

/**
 * Ask the provider's classifier endpoint whether the agent is done.
 *
 * POSTs to `<baseUrl><endpoint>` using the same API key as the LLM (resolved
 * via the model registry) and returns the "yes" probability from the
 * `answers.nudge.noul` field, or `undefined` when the classifier cannot be
 * reached or understood (caller should fall back to heuristics).
 */
async function classifyNeedsHumanInput(
  ctx: ExtensionContext,
  stateText: string,
): Promise<number | undefined> {
  const model = ctx.model as Model<"openai-completions"> | undefined;
  if (!model?.baseUrl) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  // The tail of the message matters most for a turn-ending decision, so we
  // keep the final characters rather than the beginning.
  const state =
    stateText.length > CLASSIFIER_TEXT_LIMIT
      ? `...${stateText.slice(-CLASSIFIER_TEXT_LIMIT)}`
      : stateText;

  const url = model.baseUrl.replace(/\/+$/, "") + CLASSIFIER_ENDPOINT;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      // getApiKeyAndHeaders only adds an Authorization header for providers
      // configured with authHeader; the classifier always wants Bearer auth,
      // so set it explicitly from the resolved API key.
      headers: {
        "Content-Type": "application/json",
        ...auth.headers,
        Authorization: `Bearer ${auth.apiKey}`,
      },
      body: JSON.stringify({
        state,
        model: CLASSIFIER_MODEL,
        questions: {
          nudge: {
            type: "noul",
            instructions: CLASSIFIER_INSTRUCTIONS,
            criteria: {
              true: CLASSIFIER_TRUE_CRITERIA,
              false: CLASSIFIER_FALSE_CRITERIA,
            },
          },
        },
      }),
      signal: ctx.signal,
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    if (ctx.hasUI)
      ctx.ui.notify(
        `Auto-nudge: classifier HTTP ${response.status}, falling back to heuristics.`,
        "warning",
      );
    return undefined;
  }

  try {
    const data = (await response.json()) as {
      answers?: { nudge?: { noul?: unknown } };
    };
    const noul = data.answers?.nudge?.noul;
    return typeof noul === "number" ? noul : undefined;
  } catch {
    return undefined;
  }
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const label = AGENT_TURN_COMPLETED
    ? "auto-nudge: completed"
    : `auto-nudge: active (${nudgesSent}/${MAX_NUDGES})`;
  ctx.ui.setStatus("auto-nudge", label);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // A real user prompt (typed or via RPC) resets the state machine.
  // Nudges we send ourselves arrive with source "extension" and must NOT
  // reset the nudge counter, or we could loop forever.
  pi.on("input", (event, ctx) => {
    if (event.source === "interactive" || event.source === "rpc") {
      AGENT_TURN_COMPLETED = false;
      nudgesSent = 0;
      updateStatus(ctx);
    }
  });

  // Fires once per user prompt, after the agent loop has fully settled.
  pi.on("agent_end", async (event, ctx) => {
    if (AGENT_TURN_COMPLETED) {
      // Turn already judged finished: allow it to end.
      return;
    }

    const messages = (event.messages ?? []) as readonly MessageLike[];
    const lastAssistantText =
      [...messages]
        .reverse()
        .map(extractText)
        .find((text) => text.trim().length > 0) ?? "";

    if (wasAborted(messages)) {
      // The user interrupted the turn (e.g. ESC). That is a deliberate stop,
      // not a mid-work stall: never nudge, just let it end.
      AGENT_TURN_COMPLETED = true;
      updateStatus(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          "Auto-nudge: turn interrupted by user, skipping nudge.",
          "info",
        );
      return;
    }

    // Primary detection: the provider's classifier. noul >= threshold means
    // the agent is done (no nudge). Any failure falls back to heuristics.
    let needsInput: boolean | undefined;
    if (lastAssistantText) {
      const noul = await classifyNeedsHumanInput(ctx, lastAssistantText);
      if (noul !== undefined) {
        needsInput = noul >= NUDGE_THRESHOLD;
        if (ctx.hasUI)
          ctx.ui.notify(
            `Auto-nudge: classifier says done=${needsInput} (noul=${noul.toFixed(2)})`,
            "info",
          );
      }
    }
    if (needsInput === undefined) {
      needsInput = needsHumanInput(messages);
    }

    if (needsInput) {
      // The agent is genuinely waiting on the human or has finished.
      AGENT_TURN_COMPLETED = true;
      updateStatus(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          "Auto-nudge: turn completed, awaiting your input.",
          "info",
        );
      return;
    }

    if (nudgesSent >= MAX_NUDGES) {
      // Safety valve: stop nudging so we can't loop forever.
      AGENT_TURN_COMPLETED = true;
      updateStatus(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          `Auto-nudge: gave up after ${MAX_NUDGES} nudges, ending turn.`,
          "warning",
        );
      return;
    }

    // The agent stopped without asking for anything — nudge it back to work.
    nudgesSent += 1;
    updateStatus(ctx);
    if (ctx.hasUI)
      ctx.ui.notify(
        `Auto-nudge: nudging agent (${nudgesSent}/${MAX_NUDGES})...`,
        "info",
      );

    if (ctx.isIdle()) {
      pi.sendUserMessage(NUDGE_TEXT);
    } else {
      pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
    }
  });

  // Manual inspection / control.
  pi.registerCommand("nudge-status", {
    description:
      "Show auto-nudge state: AGENT_TURN_COMPLETED and nudges sent for the current prompt",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Auto-nudge: AGENT_TURN_COMPLETED=${AGENT_TURN_COMPLETED}, nudges this prompt: ${nudgesSent}/${MAX_NUDGES}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Fresh session: start in the "not completed" state.
    AGENT_TURN_COMPLETED = false;
    nudgesSent = 0;
    updateStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    AGENT_TURN_COMPLETED = false;
    nudgesSent = 0;
  });
}
