/**
 * Forbidden Actions Extension
 *
 * Monitors tool calls for dangerous or bypass attempts:
 * - Setting PREK_ALLOW_NO_CONFIG (pre-commit bypass)
 * - Running git with --no-verify (pre-commit hook bypass)
 * - Other known bypass patterns
 *
 * When detected, blocks the tool call with an informative message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Patterns that indicate bypass attempts or dangerous pre-commit manipulation
const FORBIDDEN_PATTERNS = [
  {
    pattern: /PREK_ALLOW_NO_CONFIG\s*=/,
    description: "Setting PREK_ALLOW_NO_CONFIG disables config validation checks",
    risk: "High",
  },
  {
    pattern: /PRE_COMMIT_ALLOW_NO_CONFIG\s*=/,
    description: "Setting PRE_COMMIT_ALLOW_NO_CONFIG disables config validation checks",
    risk: "High",
  },
  {
    pattern: /git\s+commit\s+.*--no-verify/,
    description: "Using git commit --no-verify to skip pre-commit hooks",
    risk: "High",
  },
  {
    pattern: /git\s+commit\s+.*-n(?!\w)/,
    description: "Using git commit -n to skip pre-commit hooks",
    risk: "High",
  },
  {
    pattern: /NO_VERIFY\s*=/,
    description: "Setting NO_VERIFY environment variable to skip validation",
    risk: "High",
  },
  {
    pattern: /SKIP_PRECOMMIT\s*=/,
    description: "Setting SKIP_PRECOMMIT environment variable to skip pre-commit",
    risk: "High",
  },
  {
    pattern: /PREK_SKIP\s*=/,
    description: "Setting PREK_SKIP environment variable to skip prek",
    risk: "High",
  },
  {
    pattern: /SKIP\s*=/,
    description: "Setting SKIP environment variable to skip pre-commit",
    risk: "High",
  },
  {
    pattern: /SKIP_HOOKS\s*=/,
    description: "Setting SKIP_HOOKS environment variable to skip git hooks",
    risk: "High",
  },
];

/**
 * Check if a command string contains any forbidden patterns.
 * Returns the first matching forbidden pattern or null.
 */
function checkForbiddenPatterns(
  command: string,
): { pattern: RegExp; description: string; risk: string } | null {
  for (const { pattern, description, risk } of FORBIDDEN_PATTERNS) {
    if (pattern.test(command)) {
      return { pattern, description, risk };
    }
  }
  return null;
}

/**
 * Extract the command string from various tool calls.
 */
function extractCommand(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case "bash":
      return args.command as string;
    case "write":
    case "edit":
      return args.content as string;
    default:
      return null;
  }
}

export default function forbiddenActionsExtension(pi: ExtensionAPI): void {
  let reportCount = 0;

  pi.on("tool_call", async (event) => {
    const command = extractCommand(event.toolName, event.input);
    if (!command || typeof command !== "string") {
      return;
    }

    const forbidden = checkForbiddenPatterns(command);
    if (!forbidden) {
      return;
    }

    reportCount++;

    // Build a helpful error message
    const label = event.toolName === "bash" ? "Command" : "Content";
    const message = [
      `\u26d4 Forbidden action detected! (${forbidden.risk} risk)`,
      "",
      `Pattern: ${forbidden.description}`,
      "",
      `Tool: ${event.toolName}`,
      `${label}: ${command.length > 100 ? command.slice(0, 100) + "..." : command}`,
      "",
      "Pre-commit hooks and config validation are important safeguards.",
      "If you need to skip hooks for debugging, do so interactively",
      "after understanding the risks.",
      "",
      `This attempt has been logged (report #${reportCount}).`,
    ].join("\n");

    // Block the tool call with the informative message
    return {
      block: true,
      reason: message,
    };
  });
}
