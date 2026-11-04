// Interactive selection across live sessions and saved snapshots.

import path from "node:path";

import { fail } from "./config.mjs";
import { derivedPiName, parseLabel } from "./spec.mjs";
import { ask, formatAge } from "./ui.mjs";

/**
 * Display title for a session or checkpoint: an explicit custom name first,
 * then the derived pi title (pi= + ws= — pi sessions no longer store a
 * name=), then the workspace basename, then a short id (sessions) or
 * auto-name (snapshots).
 */
export function targetTitle(kind, t) {
  const { ws, name } = parseLabel(t.label);
  if (name) return name;
  const derived = derivedPiName(t.label);
  if (derived) return derived;
  if (ws) return path.basename(ws);
  return kind === "session" ? t.id.slice(0, 8) : t.name;
}

/** Secondary details shown after the title in the picker. */
export function targetDetail(kind, t) {
  const { ws, name } = parseLabel(t.label);
  const bits = [];
  if (name && ws) bits.push(`ws=${path.basename(ws)}`);
  if (kind === "session") bits.push(`${formatAge(t.createdAt)} ago`);
  else bits.push(new Date(t.createdAt).toLocaleString());
  return bits.join("  ");
}

/**
 * Pick a target across live sessions and saved snapshots.
 *
 * With fresh: true a "start a new session" entry is offered (the attach
 * flow); stop/snap only ever pick live sessions.
 *
 * Returns { type: "session", target }, { type: "checkpoint", target } or
 * { type: "fresh" }.
 */
export async function pickTarget(sessions, checkpoints, { fresh = false } = {}) {
  const items = [
    ...sessions.map((s) => ({ kind: "session", t: s })),
    ...(fresh ? checkpoints.map((m) => ({ kind: "checkpoint", t: m })) : []),
  ];

  // Non-interactive: a single live session wins (snapshots never do), no
  // sessions means fresh; anything else is ambiguous for a piped caller.
  if (!process.stdin.isTTY) {
    if (sessions.length === 1) return { type: "session", target: sessions[0] };
    if (sessions.length === 0) return { type: "fresh" };
    console.error("Multiple ginger sessions active:");
    for (const s of sessions) console.error(`  ${s.id}  ${targetTitle("session", s)}  ${s.label}`);
    fail("pass --session ID to choose one");
  }

  if (items.length === 0) {
    if (!fresh) fail("no active ginger sessions");
    return { type: "fresh" };
  }

  console.error("\nActive sessions:");
  let n = 0;
  for (const s of sessions)
    console.error(`  ${++n}. ${targetTitle("session", s)}  ${targetDetail("session", s)}`);
  if (fresh && checkpoints.length > 0) {
    console.error("\nSnapshots:");
    for (const m of checkpoints)
      console.error(`  ${++n}. ${targetTitle("checkpoint", m)}  ${targetDetail("checkpoint", m)}`);
  }

  const def = sessions.length > 0 ? "1" : "n";
  if (fresh) console.error(`\n  n) start a new session`);
  const answer = (await ask(`Select [${def}]: `, process.stderr)).toLowerCase();
  if (fresh && (answer === "n" || answer === "new")) return { type: "fresh" };
  if (answer === "")
    return sessions.length > 0 ? { type: "session", target: sessions[0] } : { type: "fresh" };
  const idx = Number(answer) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) fail("invalid selection");
  const { kind, t } = items[idx];
  return kind === "session" ? { type: "session", target: t } : { type: "checkpoint", target: t };
}
