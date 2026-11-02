// Session discovery, client leases and lifecycle markers.
//
// Client leases track ginger connections per session so the shutdown prompt
// only fires for the last one. Lifecycle markers let other clients see an
// in-flight --snap/--stop (which are operations, not connections).

import fs from "node:fs";
import path from "node:path";

import { LABEL_PREFIX, cacheDir, fail, sdk } from "./config.mjs";
import { parseLabel } from "./spec.mjs";
import { isAlive } from "./ui.mjs";

const LEASE_HEARTBEAT_MS = 5_000;
const LEASE_STALE_MS = 15_000;

function leaseDirFor(sessionId) {
  return path.join(cacheDir, "sessions", sessionId, "clients");
}

/**
 * One ginger client's claim on a session. A file named after the client pid
 * is rewritten (heartbeat) while the client is connected; liveness is judged
 * by pid + fresh mtime so stale slots and reused pids don't count.
 */
export class ClientLease {
  constructor(sessionId) {
    this.file = path.join(leaseDirFor(sessionId), String(process.pid));
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const touch = () =>
      fs.writeFileSync(
        this.file,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );
    touch();
    this.timer = setInterval(touch, LEASE_HEARTBEAT_MS);
    this.timer.unref();
    // ginger exits via process.exit(), which skips finally blocks — the
    // 'exit' event is the reliable hook (fires on process.exit, normal
    // completion and uncaught exceptions; not on SIGKILL, see gcLeases).
    process.once("exit", () => this.release());
    // Default signal termination also skips 'exit' handlers — route the
    // common ones through process.exit() so the lease is released promptly
    // instead of waiting for GC. (SIGINT is left alone: interactive clients
    // may want their own Ctrl-C handling; SIGKILL can't be caught.)
    for (const sig of ["SIGTERM", "SIGHUP"])
      process.once(sig, () => process.exit(128 + { SIGTERM: 15, SIGHUP: 1 }[sig]));
  }

  release() {
    if (this.timer) clearInterval(this.timer);
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // already gone — fine
    }
  }

  /** Count other ginger clients with a live, recently-heartbeating lease. */
  static liveOthers(sessionId) {
    let files = [];
    try {
      files = fs.readdirSync(leaseDirFor(sessionId));
    } catch {
      return 0;
    }
    let n = 0;
    for (const f of files) {
      const pid = Number(f);
      if (!Number.isInteger(pid) || pid === process.pid || !isAlive(pid)) continue;
      try {
        const age = Date.now() - fs.statSync(path.join(leaseDirFor(sessionId), f)).mtimeMs;
        if (age < LEASE_STALE_MS) n++;
      } catch {
        // vanished between readdir and stat — ignore
      }
    }
    return n;
  }
}

/** Remove lease files left by dead clients and empty session dirs. */
export function gcLeases() {
  const root = path.join(cacheDir, "sessions");
  let ids = [];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const id of ids) {
    const dir = path.join(root, id, "clients");
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      // no clients dir — nothing to sweep there
    }
    for (const f of files) {
      const file = path.join(dir, f);
      const pid = Number(f);
      let stale = !Number.isInteger(pid) || !isAlive(pid);
      if (!stale) {
        try {
          stale = Date.now() - fs.statSync(file).mtimeMs > LEASE_STALE_MS;
        } catch {
          // vanished — stale
          stale = true;
        }
      }
      if (stale) fs.rmSync(file, { force: true });
    }
    // Drop a stale lifecycle marker (its client died or timed out mid-op).
    const markerPath = path.join(root, id, "lifecycle");
    if (fs.existsSync(markerPath) && activeLifecycleOp(id) === null) {
      fs.rmSync(markerPath, { force: true });
    }
    // Prune the dirs once empty.
    try {
      fs.rmdirSync(dir);
    } catch {
      // not empty — live leases remain
    }
    try {
      fs.rmdirSync(path.join(root, id));
    } catch {
      // not empty
    }
  }
}

/**
 * Drop session dirs (spec.json, lifecycle markers, leases) for sessions that
 * are no longer live — e.g. a VM that crashed or was killed out-of-band,
 * where stop/snap never ran to clean up.
 *
 * Only call with a SUCCESSFUL live-session list: a failed fetch must not be
 * treated as "no sessions". Dirs touched within the last minute are left
 * alone so we never race a session that registered between the caller's
 * listSessions() and this sweep.
 */
export function gcSessionDirs(liveIds) {
  const root = path.join(cacheDir, "sessions");
  let ids = [];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const id of ids) {
    if (liveIds.includes(id) || activeLifecycleOp(id)) continue;
    const dir = path.join(root, id);
    let newest = 0;
    try {
      for (const f of fs.readdirSync(dir))
        newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs);
    } catch {
      continue; // vanished — fine
    }
    if (Date.now() - newest < 60_000) continue; // be conservative
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Drop a session's lease dir entirely. Only call once the session itself is
 * gone (shut down / snapshotted) — mirrors the SDK removing its session
 * metadata on unregister. Late release() calls from other clients' exit
 * handlers are harmless (rmSync force tolerates the missing path).
 */
export function removeSessionLeases(sessionId) {
  try {
    fs.rmSync(path.join(cacheDir, "sessions", sessionId), {
      recursive: true,
      force: true,
    });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Lifecycle markers — let other clients see an in-flight --snap/--stop
// ---------------------------------------------------------------------------

const LIFECYCLE_STALE_MS = 30 * 60_000;

function lifecyclePath(sessionId) {
  return path.join(cacheDir, "sessions", sessionId, "lifecycle");
}

/** Mark this client as running a lifecycle op ("snap"/"stop") on the session. */
export function setLifecycleOp(sessionId, op) {
  try {
    fs.mkdirSync(path.dirname(lifecyclePath(sessionId)), { recursive: true });
    fs.writeFileSync(
      lifecyclePath(sessionId),
      JSON.stringify({ op, pid: process.pid, at: new Date().toISOString() }),
    );
  } catch {
    // best effort — the marker only improves messaging
  }
}

/**
 * Return "snap"/"stop" if another live client is mid-lifecycle-op on the
 * session, else null (missing, dead pid, or stale marker).
 */
export function activeLifecycleOp(sessionId) {
  try {
    const { op, pid, at } = JSON.parse(fs.readFileSync(lifecyclePath(sessionId), "utf8"));
    if (typeof op !== "string") return null;
    if (!Number.isInteger(pid) || pid === process.pid || !isAlive(pid)) return null;
    if (Date.now() - new Date(at).getTime() > LIFECYCLE_STALE_MS) return null;
    return op;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Live ginger sessions from the SDK registry. */
export async function gingerSessions() {
  await sdk.gcSessions().catch(() => {});
  const sessions = await sdk.listSessions();
  return sessions.filter((s) => s.alive && (s.label ?? "").startsWith(LABEL_PREFIX));
}

/**
 * Match a session query: exact id, custom name (label name=) or workspace
 * path (label ws=) first, then a unique prefix of any of those.
 */
export function matchSession(sessions, query) {
  const keys = (s) => {
    const { ws, name } = parseLabel(s.label);
    return [s.id, name, ws, ws ? path.basename(ws) : null];
  };
  const exact = sessions.filter((s) => keys(s).some((k) => k === query));
  if (exact.length > 0) {
    if (exact.length > 1)
      fail(
        `'${query}' is ambiguous (${exact.length} sessions match: ${exact
          .map((s) => s.id)
          .join(", ")})`,
      );
    return exact[0];
  }
  const prefix = sessions.filter((s) => keys(s).some((k) => k?.startsWith(query)));
  if (prefix.length === 0) fail(`no active ginger session matching '${query}'`);
  if (prefix.length > 1)
    fail(
      `'${query}' is ambiguous (${prefix.length} sessions match: ${prefix
        .map((s) => s.id)
        .join(", ")})`,
    );
  return prefix[0];
}

// ---------------------------------------------------------------------------
// Session spec persistence — the owner records the exact spec it started
// the VM with, so later clients (attach/exec/snap) don't need to re-supply
// -w/-l/env just to describe a session that already exists.
// ---------------------------------------------------------------------------

function sessionSpecPath(sessionId) {
  return path.join(cacheDir, "sessions", sessionId, "spec.json");
}

/** Persist the spec for a session (called by the owner once the VM exists). */
export function writeSessionSpec(sessionId, spec) {
  try {
    fs.mkdirSync(path.dirname(sessionSpecPath(sessionId)), { recursive: true });
    // Mode 0600: specs may carry secret values (--host-secret) and SSH
    // passphrases.
    fs.writeFileSync(sessionSpecPath(sessionId), JSON.stringify(spec, null, 2), { mode: 0o600 });
  } catch {
    // best effort — clients fall back to their own spec
  }
}

/** Read the persisted spec for a session, or null if none (older ginger). */
export function readSessionSpec(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionSpecPath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Access status — the owner is the only process that can enable the ingress
// gateway and the SSH forwarder (it holds the sandbox controller connection),
// so it records each outcome here for the client to report.
// ---------------------------------------------------------------------------

function sessionAccessPath(sessionId) {
  return path.join(cacheDir, "sessions", sessionId, "access.json");
}

/** Merge one access entry ({ url }|{ command,... }|{ error }) under `key`. */
export function writeSessionAccess(sessionId, key, info) {
  try {
    const p = sessionAccessPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let all = {};
    try {
      all = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      // first entry
    }
    all[key] = info;
    fs.writeFileSync(p, JSON.stringify(all, null, 2));
  } catch {
    // best effort — the client times out with a pointer to the owner log
  }
}

/** Read the recorded access entries, or null if the owner wrote none yet. */
export function readSessionAccess(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionAccessPath(sessionId), "utf8"));
  } catch {
    return null;
  }
}
