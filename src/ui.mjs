// Output helpers: command runner, progress spinner, log persistence, small
// formatting utilities and an interactive prompt helper.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

import { logDir } from "./config.mjs";

export const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True if pid refers to a running process. kill(0) also succeeds for
 * zombies, and macOS does not reap orphaned zombies promptly — so after the
 * signal probe we check the process state where we can (a zombie is not
 * alive: it holds no leases and runs no lifecycle ops).
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (os.platform() === "linux") {
      // /proc/<pid>/stat: "pid (comm) state ..." — comm may contain spaces/parens
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat
        .slice(stat.lastIndexOf(")") + 1)
        .trimStart()
        .startsWith("Z");
    }
    const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout.trim()) return !r.stdout.trimStart().startsWith("Z");
  } catch {
    // vanished or unreadable — fall through
  }
  return true; // exists and state unknown — count it as alive
}

export function formatAge(createdAt) {
  const diffMs = Math.max(0, Date.now() - new Date(createdAt).getTime());
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function tail(text, lines = 30) {
  return text.split("\n").slice(-lines).join("\n");
}

/**
 * Run a command. With capture: true, output is buffered and only printed if
 * the command fails — quiet on success, full log on error (suppress the
 * failure banner with quiet: true when the caller handles errors itself).
 * With onLine, complete lines are also streamed live as they arrive.
 */
export async function run(cmd, args, { capture = false, quiet = false, onLine = null } = {}) {
  const child = spawn(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!capture) {
    return await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  }
  let output = ""; // unflushed remainder (fed to onLine as lines complete)
  let full = ""; // everything seen so far (returned as out)
  const feed = (d) => {
    output += d;
    full += d;
    if (onLine) {
      let idx;
      while ((idx = output.indexOf("\n")) >= 0) {
        onLine(output.slice(0, idx));
        output = output.slice(idx + 1);
      }
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  const code = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  if (code !== 0 && !quiet) {
    console.error(
      `\n✗ ${path.basename(cmd)} ${args.join(" ")} failed (exit ${code}):\n${full.trim()}\n`,
    );
  }
  return { code, out: full };
}

// ---------------------------------------------------------------------------
// Progress UI — spinner on a TTY, plain lines when piped
// ---------------------------------------------------------------------------

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
export const paint = {
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  warn: (s) => (useColor ? `\x1b[1;33m${s}\x1b[0m` : s), // bold yellow
};

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * A progress step: animated spinner with elapsed time on a TTY, or a plain
 * header line when piped. Child output passed to note() is shown indented
 * and dimmed under the step.
 */
export class Step {
  constructor(label) {
    this.label = label;
    this.t0 = Date.now();
    this.frame = 0;
    if (process.stderr.isTTY) {
      const draw = () => {
        const f = SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length];
        process.stderr.write(`\r\x1b[2K${f} ${label} (${formatElapsed(Date.now() - this.t0)})`);
      };
      this.timer = setInterval(draw, 80);
      draw();
    } else {
      console.error(`${label}...`);
    }
  }

  /** Show one line of child output, indented and dimmed. */
  note(line) {
    if (!line.trim()) return;
    if (this.timer) process.stderr.write("\r\x1b[2K");
    for (const l of String(line).split("\n")) process.stderr.write(`  ${paint.dim(l)}\n`);
  }

  succeed(detail = this.label) {
    this.finish(true, detail);
  }

  fail(detail = this.label) {
    this.finish(false, detail);
  }

  finish(ok, detail) {
    if (this.timer) {
      clearInterval(this.timer);
      process.stderr.write("\r\x1b[2K");
      this.timer = null;
    }
    const elapsed = formatElapsed(Date.now() - this.t0);
    console.error(ok ? `✓ ${detail} (${elapsed})` : `✗ ${detail} (${elapsed})`);
  }
}

/** Persist a full command log; returns the path for error messages. */
export function saveLog(name, content) {
  fs.mkdirSync(logDir, { recursive: true });
  const p = path.join(logDir, `${name}-${Date.now()}.log`);
  fs.writeFileSync(p, content);
  return p;
}

/** Poll for a file to appear (used to observe checkpoint writes). */
export async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await waitFor(500);
  }
  return false;
}

/** Ask a question on the TTY; resolves to the trimmed answer. */
export async function ask(question, stream = process.stderr) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: stream,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
