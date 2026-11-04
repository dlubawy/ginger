// E2E test for ../pi/extensions/ginger.ts (the pi extension).
//
// Runs the REAL extension + REAL ginger src modules against a stub gondolin
// SDK (./sdk-stub.mjs) and a mock pi ExtensionAPI. No VM, no network — safe
// to run in any nix build sandbox:
//
//   PI_SDK_DIR=/path/to/pi-monorepo node pkgs/ginger/tests/pi-extension.test.mjs
//   nix build .#checks.<system>.pi-extension-check
//
// Env:
//   PI_SDK_DIR  optional — directory of the pi-coding-agent package (the
//     .../lib/node_modules/pi-monorepo path). When set, the extension is run
//     from a temp tree with a node_modules symlink to it (needed when the
//     checkout itself has no node_modules, e.g. a nix store copy). Without
//     it, the extension is imported in place and relies on local resolution.
//
// Asserts:
//   A. spec from .pi/ginger.json reaches VM.create options
//   B. owner features applied after create (ingress for listen, direnv allow)
//   C. ingress URL recorded in access.json AND surfaced in notification +
//      system prompt + /ginger status
//   D. login env captured once at start; direnv envrc evaluated ONCE (not
//      per command); merged env injected into tool execs; bash argv is
//      non-login (a login shell would clobber the injected PATH)
//   E. /reload-direnv re-captures and subsequent execs see the new env
//   F. shutdown snapshots only when the session JSONL exists on disk
//   G. control: no profile -> no ingress, no direnv capture
//   H. host pi config paths (skills) resolve to the guest-local /etc/pi/agent
//      copy — never the host dir's content; symlink created for shell use
//   I. fork inheritance ACROSS extension instances: pi re-invokes the
//      factory on every session replacement, so a fork adopts the parent's
//      running VM via module-scope state (no snapshot, no second VM),
//      labels/snapshots keyed by the tree's ROOT id
//   J. /new snapshots in the BACKGROUND (handler returns while the qcow is
//      still in flight) under a lifecycle marker that keeps `ginger ls`'s GC
//      away from the session dir mid-snapshot; sidecar written on completion
//   K. resume of a forked tree finds the root's snapshot; pre-boot cleanup
//      drops the tree's older snapshots

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.join(TESTS, "..", "pi", "extensions", "ginger.ts");
const GINGER_SRC = path.join(TESTS, "..", "src");
const STUB = path.join(TESTS, "sdk-stub.mjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ginger-pi-e2e-"));
const WS = path.join(ROOT, "ws");

fs.mkdirSync(path.join(WS, ".pi"), { recursive: true });
fs.writeFileSync(
  path.join(WS, ".pi", "ginger.json"),
  JSON.stringify({ direnv: true, listen: true }, null, 2),
);

// Host agent dir (stands in for ~/.pi/agent) — must NEVER be served to the
// guest. The guest's own curated copy lives at /etc/pi/agent (image-baked),
// stood in for by GUEST_PI below.
const HOST_AGENT = path.join(ROOT, "host-agent");
const GUEST_PI = path.join(ROOT, "guest-pi-agent");
fs.mkdirSync(path.join(HOST_AGENT, "skills", "demo"), { recursive: true });
fs.writeFileSync(
  path.join(HOST_AGENT, "skills", "demo", "SKILL.md"),
  "host skill content (must never be served)\n",
);
fs.mkdirSync(path.join(GUEST_PI, "skills", "demo"), { recursive: true });
fs.writeFileSync(path.join(GUEST_PI, "skills", "demo", "SKILL.md"), "guest skill content\n");
process.env.PI_CODING_AGENT_DIR = HOST_AGENT; // read by the extension at import

// The extension refuses to run where GINGER_VERSION is set (guest guard).
delete process.env.GINGER_VERSION;
process.chdir(WS); // extension captures process.cwd() as localCwd

// The extension statically imports @earendil-works/pi-coding-agent. In a dev
// checkout that resolves via local node_modules; from a nix store copy it
// cannot (store paths are read-only), so with PI_SDK_DIR set we run the
// extension from a temp tree whose node_modules symlinks the pi package.
let EXT = EXT_SRC;
if (process.env.PI_SDK_DIR) {
  const tree = path.join(ROOT, "ext-tree", "pi", "extensions");
  fs.mkdirSync(tree, { recursive: true });
  fs.copyFileSync(EXT_SRC, path.join(tree, "ginger.ts"));
  const nm = path.join(tree, "node_modules", "@earendil-works");
  fs.mkdirSync(nm, { recursive: true });
  fs.symlinkSync(process.env.PI_SDK_DIR, path.join(nm, "pi-coding-agent"), "dir");
  EXT = path.join(tree, "ginger.ts");
}

const { default: ext } = await import(EXT);
const sdkStub = await import(STUB);
sdkStub.guestPi.dir = GUEST_PI;

function makePi() {
  const handlers = {};
  const tools = [];
  const commands = {};
  return {
    handlers,
    tools,
    commands,
    api: {
      on: (ev, fn) => {
        handlers[ev] = fn;
      },
      registerTool: (t) => {
        tools.push(t);
      },
      registerCommand: (name, def) => {
        commands[name] = def;
      },
    },
  };
}

function makeCtx(notifications) {
  return {
    ui: {
      notify: (msg, kind) => notifications.push([kind, msg]),
      setStatus: () => {},
      theme: { fg: (_c, s) => s },
    },
    sessionManager: {
      getSessionId: () => "pi-e2e-1",
      getSessionFile: () => path.join(ROOT, "session.jsonl"),
    },
    model: { provider: "test-provider", id: "test-model" },
  };
}

// doLoadGinger reads these when the VM starts (not at extension load).
function setGingerEnv() {
  process.env.GINGER_SRC = GINGER_SRC;
  process.env.GONDOLIN_SDK = STUB;
  process.env.GINGER_VERSION = "0.0.1-e2e";
  process.env.GINGER_CACHE_DIR = path.join(ROOT, "cache");
}

async function startScenario() {
  delete process.env.GINGER_VERSION; // guest guard at ext() time
  const notifications = [];
  const pi = makePi();
  ext(pi.api);
  setGingerEnv();
  const ctx = makeCtx(notifications);
  await pi.handlers.session_start({}, ctx);
  return { pi, ctx, notifications, vm: sdkStub.vms.at(-1) };
}

async function runBash(pi, ctx, id) {
  const bashTool = pi.tools.find((t) => t.name === "bash");
  assert.ok(bashTool, "bash tool registered");
  await bashTool.execute(
    id,
    { command: "echo hello" },
    new AbortController().signal,
    () => {},
    ctx,
  );
}

// ---- Scenario 1: profile with direnv + listen -----------------------------
{
  const { pi, ctx, notifications, vm } = await startScenario();

  // A. spec reached VM.create
  assert.equal(sdkStub.calls.create.length, 1, "VM.create called once");
  const opts = sdkStub.calls.create[0];
  assert.match(opts.sessionLabel, /pi=pi-e2e-1/, "label carries pi session id");
  assert.ok(opts.env.includes("GINGER_VERSION=0.0.1-e2e"), "spec env seeded");
  assert.ok(opts.vfs.mounts["/workspace/ws"], "workspace mounted at /workspace/ws");

  // B. owner features applied after create
  assert.equal(sdkStub.calls.ingress.length, 1, "enableIngress called once");
  const allow = vm.execCalls.find((c) => c.cmd === "direnv allow");
  assert.ok(allow, "direnv allow executed");
  assert.equal(allow.opts.cwd, "/workspace/ws", "direnv allow in spec cwd");

  // C. ingress URL surfaced everywhere
  const access = JSON.parse(
    fs.readFileSync(path.join(ROOT, "cache", "sessions", vm.id, "access.json"), "utf8"),
  );
  assert.equal(access.ingress.url, "http://127.0.0.1:4711/", "access.json ingress url");
  assert.ok(
    notifications.some(
      ([k, m]) => k === "info" && m.includes("Ingress enabled: http://127.0.0.1:4711/"),
    ),
    "feature notification emitted",
  );

  // D. login + direnv env captured once at start, injected per exec
  assert.equal(sdkStub.dumpCount, 1, "envrc evaluated exactly once at start");
  await runBash(pi, ctx, "exec-1");
  let last = vm.execCalls.at(-1);
  assert.deepEqual(
    last.cmd,
    ["/bin/bash", "-c", "echo hello"],
    "bash argv is non-login (no profile clobbering)",
  );
  assert.equal(last.opts.cwd, "/workspace/ws", "bash cwd is guest spec cwd");
  assert.equal(last.opts.env.GINGER_TEST_VAR, "run1", "captured direnv env injected");
  assert.ok((last.opts.env.PATH ?? "").startsWith("/opt/devshell1/bin:"), "devshell PATH injected");
  assert.equal(last.opts.env.PI_SESSION_ID, "pi-e2e-1", "pi session vars still present");
  assert.equal(last.opts.env.NIX_BASE, "yes", "login baseline layered under direnv env");
  assert.equal(last.opts.env._, undefined, "volatile _ var stripped from captures");

  // system prompt carries ingress url + direnv hint
  const res = await pi.handlers.before_agent_start(
    { systemPrompt: `Current working directory: ${WS}` },
    ctx,
  );
  assert.match(
    res.systemPrompt,
    /ingress: http:\/\/127\.0\.0\.1:4711\//,
    "system prompt has ingress url",
  );
  assert.match(res.systemPrompt, /\/reload-direnv/, "system prompt mentions /reload-direnv");

  // /ginger status shows ingress URL + env state on demand
  assert.ok(pi.commands["ginger"], "ginger command registered");
  await pi.commands["ginger"].handler("", ctx);
  const statusMsg = notifications.at(-1)?.[1] ?? "";
  assert.match(statusMsg, /Ingress: http:\/\/127\.0\.0\.1:4711\//, "/ginger shows ingress url");
  assert.match(statusMsg, /Login env: captured \(2 vars\)/, "/ginger shows login env state");
  assert.match(statusMsg, /Direnv: environment loaded \(3 vars\)/, "/ginger shows direnv state");

  // H. host pi config paths resolve to the guest-local copy
  const readTool = pi.tools.find((t) => t.name === "read");
  assert.ok(readTool, "read tool registered");
  const readRes = await readTool.execute(
    "read-1",
    { path: `${HOST_AGENT}/skills/demo/SKILL.md` },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const readOut = JSON.stringify(readRes);
  assert.match(readOut, /guest skill content/, "host skill path served from guest copy");
  assert.ok(!readOut.includes("must never be served"), "host agent dir content is never exposed");
  // literal host paths also work in shell commands via the guest symlink
  const ln = vm.execCalls.find(
    (c) => Array.isArray(c.cmd) && c.cmd[0] === "ln" && c.cmd.includes(HOST_AGENT),
  );
  assert.ok(ln, "guest symlink created for the host agent dir path");
  assert.deepEqual(ln.cmd.slice(1), ["-sfn", "/etc/pi/agent", HOST_AGENT]);

  // E. /reload-direnv re-captures; next exec sees the new env
  assert.ok(pi.commands["reload-direnv"], "reload-direnv command registered");
  await pi.commands["reload-direnv"].handler("", ctx);
  assert.equal(sdkStub.dumpCount, 2, "reload re-evaluated the envrc");
  await runBash(pi, ctx, "exec-2");
  last = vm.execCalls.at(-1);
  assert.equal(last.opts.env.GINGER_TEST_VAR, "run2", "reloaded env visible to next exec");

  // F. shutdown WITH a real transcript on disk -> snapshot taken
  const sessionFile = path.join(ROOT, "session.jsonl");
  fs.writeFileSync(sessionFile, '{"type":"message"}\n');
  await pi.handlers.session_shutdown({}, ctx);
  assert.equal(vm.checkpointCalls.length, 1, "snapshot taken when JSONL exists");
  assert.ok(vm.closed, "VM closed after snapshot");

  console.log("scenario 1 (profile): PASS");
}

// ---- Scenario 2: control — no profile -------------------------------------
{
  for (const k of Object.keys(sdkStub.calls)) sdkStub.calls[k].length = 0;
  fs.rmSync(path.join(ROOT, "cache"), { recursive: true, force: true });
  fs.rmSync(path.join(WS, ".pi"), { recursive: true, force: true });

  const { pi, ctx, notifications, vm } = await startScenario();
  const dumpsBefore = sdkStub.dumpCount;

  assert.equal(sdkStub.calls.create.length, 1, "VM created");
  assert.equal(sdkStub.calls.ingress.length, 0, "no ingress without listen");
  assert.ok(!notifications.some(([, m]) => m.includes("Ingress")), "no ingress notification");
  assert.ok(
    !vm.execCalls.some((c) => c.cmd === "direnv allow"),
    "no direnv allow without spec.direnv",
  );

  await runBash(pi, ctx, "exec-3");
  const last = vm.execCalls.at(-1);
  assert.deepEqual(
    last.cmd,
    ["/bin/bash", "-c", "echo hello"],
    "bash argv non-login without direnv",
  );
  assert.equal(last.opts.env.GINGER_TEST_VAR, undefined, "no direnv env injected");
  assert.equal(sdkStub.dumpCount, dumpsBefore, "no envrc evaluation without spec.direnv");
  assert.equal(last.opts.env.NIX_BASE, "yes", "login baseline injected even without direnv");
  assert.equal(
    last.opts.env.PATH,
    "/root/.nix-profile/bin:/usr/local/sbin:/usr/bin",
    "baseline PATH (nix-profile prefix) preserved for non-direnv VMs",
  );

  // /ginger status has no ingress line without listen
  await pi.commands["ginger"].handler("", ctx);
  const statusMsg2 = notifications.at(-1)?.[1] ?? "";
  assert.ok(!statusMsg2.includes("Ingress:"), "/ginger has no ingress line without listen");

  // F. shutdown WITHOUT a transcript file -> closed, no snapshot
  fs.rmSync(path.join(ROOT, "session.jsonl"), { force: true });
  await pi.handlers.session_shutdown({}, ctx);
  assert.equal(vm.checkpointCalls.length, 0, "no snapshot without JSONL on disk");
  assert.ok(vm.closed, "VM closed without snapshot");

  // reload-direnv refuses cleanly when direnv is off
  await pi.commands["reload-direnv"].handler("", ctx);
  assert.ok(
    notifications.some(([k, m]) => k === "error" && m.includes("direnv is not enabled")),
    "reload without direnv reports an error",
  );
  console.log("scenario 2 (no profile): PASS");
}

// ---- Scenario 3: fork inheritance + background snapshot + GC race --------
{
  for (const k of Object.keys(sdkStub.calls)) sdkStub.calls[k].length = 0;
  fs.rmSync(path.join(ROOT, "cache"), { recursive: true, force: true });
  const vmsBefore = sdkStub.vms.length; // vms is append-only across scenarios

  // A pi session tree on disk: root-1 <- child-1 <- grand-1. Each header's
  // parentSession is a PATH to the parent session file (pi's real format).
  const rootFile = path.join(ROOT, "root-session.jsonl");
  const childFile = path.join(ROOT, "child-session.jsonl");
  const grandFile = path.join(ROOT, "grand-session.jsonl");
  fs.writeFileSync(rootFile, JSON.stringify({ type: "session", id: "root-1" }) + "\n");
  fs.writeFileSync(
    childFile,
    JSON.stringify({ type: "session", id: "child-1", parentSession: rootFile }) + "\n",
  );
  fs.writeFileSync(
    grandFile,
    JSON.stringify({ type: "session", id: "grand-1", parentSession: childFile }) + "\n",
  );

  const mkCtx = (file, id) => {
    const notifications = [];
    const ctx = makeCtx(notifications);
    ctx.sessionManager.getSessionId = () => id;
    ctx.sessionManager.getSessionFile = () => file;
    return { ctx, notifications };
  };

  // pi invalidates a replaced session's ctx: every property access on it
  // then throws (assertActive). Anything an async flow still needs —
  // notably the ui object — must have been captured while the ctx was live.
  const invalidateCtx = (ctx) => {
    for (const key of Object.getOwnPropertyNames(ctx)) {
      Object.defineProperty(ctx, key, {
        configurable: true,
        get: () => {
          throw new Error("This extension ctx is stale after session replacement or reload");
        },
      });
    }
  };

  // pi re-invokes the extension factory on every session replacement (new
  // runtime → new closure). Each session below gets its own extension
  // instance; state can only cross the boundary via module scope — exactly
  // the shape of the real /fork bug (a second VM was created because the
  // fresh instance's closure had no knowledge of the parent's VM).
  // The guest guard bails when GINGER_VERSION is set (it is seeded inside
  // guests); the test sets it for spec assertions, so mask it around each
  // factory invocation.
  const newExt = () => {
    const saved = process.env.GINGER_VERSION;
    delete process.env.GINGER_VERSION;
    try {
      const p = makePi();
      ext(p.api);
      return p;
    } finally {
      if (saved !== undefined) process.env.GINGER_VERSION = saved;
    }
  };

  // I. The root session starts a fresh VM; the label is keyed by the ROOT.
  setGingerEnv();
  const rootPi = newExt();
  const { ctx: rootCtx } = mkCtx(rootFile, "root-1");
  await rootPi.handlers.session_start({ reason: "startup" }, rootCtx);
  const vm = sdkStub.vms.at(-1);
  assert.equal(sdkStub.calls.create.length, 1, "root starts a VM");
  assert.match(sdkStub.calls.create[0].sessionLabel, /pi=root-1/, "label keyed by ROOT id");

  // A fork hands the running VM to the child: no snapshot, no second VM —
  // and the child is a NEW extension instance (fresh closure).
  await rootPi.handlers.session_shutdown({ reason: "fork" }, rootCtx);
  assert.equal(vm.checkpointCalls.length, 0, "fork does not snapshot");
  assert.ok(!vm.closed, "fork leaves the VM running for the child");

  const childPi = newExt();
  const { ctx: childCtx } = mkCtx(childFile, "child-1");
  await childPi.handlers.session_start({ reason: "fork" }, childCtx);
  assert.equal(sdkStub.calls.create.length, 1, "fork does NOT start a second VM");
  assert.equal(sdkStub.vms.length, vmsBefore + 1, "still exactly one VM in the tree");

  // A deep fork (two hops from the root) must walk the parentSession chain.
  await childPi.handlers.session_shutdown({ reason: "fork" }, childCtx);
  const grandPi = newExt();
  const { ctx: grandCtx, notifications: grandNotices } = mkCtx(grandFile, "grand-1");
  await grandPi.handlers.session_start({ reason: "fork" }, grandCtx);
  assert.equal(sdkStub.calls.create.length, 1, "deep fork still shares the VM");

  // J. /new from the grandchild: background snapshot. Hold the checkpoint in
  // flight and inspect the window.
  sdkStub.control.checkpointHook = () =>
    new Promise((r) => (sdkStub.control.releaseCheckpoint = r));
  const newFile = path.join(ROOT, "new-session.jsonl");
  fs.writeFileSync(newFile, JSON.stringify({ type: "session", id: "new-1" }) + "\n");
  const { ctx: newCtx } = mkCtx(newFile, "new-1");

  await grandPi.handlers.session_shutdown({ reason: "new" }, grandCtx);
  // pi replaces the session right after this handler — from now on every
  // property access on grandCtx throws. The in-flight background snapshot
  // must complete using only what it captured (its ui object).
  invalidateCtx(grandCtx);
  // The handler returned without waiting for the checkpoint (the hook holds
  // it forever); poll until the background flow reaches vm.checkpoint().
  const startedBy = Date.now() + 5000;
  while (vm.checkpointCalls.length === 0 && Date.now() < startedBy)
    await new Promise((r) => setTimeout(r, 25));
  assert.equal(vm.checkpointCalls.length, 1, "/new snapshots the tree's VM in the background");
  assert.ok(!vm.closed, "handler returned while the snapshot is still in flight");

  const sdir = path.join(ROOT, "cache", "sessions", vm.id);
  const lifecycleFile = path.join(sdir, "lifecycle");
  assert.ok(fs.existsSync(lifecycleFile), "lifecycle marker present mid-snapshot");
  assert.equal(JSON.parse(fs.readFileSync(lifecycleFile, "utf8")).op, "snap", "marker op is snap");

  // Backdate the session dir's other files: a `ginger ls` GC running now must
  // not remove the dir (fresh marker mtime + live marker) mid-snapshot.
  fs.writeFileSync(path.join(sdir, "spec.json"), "{}");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(path.join(sdir, "spec.json"), old, old);
  const { gcSessionDirs } = await import(`${GINGER_SRC}/sessions.mjs`);
  gcSessionDirs([]);
  assert.ok(fs.existsSync(path.join(sdir, "spec.json")), "session dir survives ginger GC mid-snapshot");

  // Release the checkpoint; the background flow must finish on its own:
  // qcow + sidecar, marker released, VM closed.
  sdkStub.control.releaseCheckpoint();
  const cdir = path.join(ROOT, "cache", "checkpoints");
  const deadline = Date.now() + 5000;
  let metas = [];
  while (Date.now() < deadline) {
    metas = fs.existsSync(cdir)
      ? fs.readdirSync(cdir).filter((f) => f.endsWith(".json"))
      : [];
    if (metas.length > 0 && vm.closed) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(metas.length, 1, "background snapshot wrote its metadata sidecar");
  const meta = JSON.parse(fs.readFileSync(path.join(cdir, metas[0]), "utf8"));
  assert.match(meta.label, /pi=root-1/, "snapshot labeled with the ROOT id");
  assert.ok(!fs.existsSync(lifecycleFile), "lifecycle marker released after snapshot");
  assert.ok(vm.closed, "VM closed after background snapshot");
  assert.ok(
    grandNotices.some(([kind, msg]) => kind === "info" && /snapshot saved/.test(msg)),
    "background snapshot reported via the captured ui (stale ctx never touched)",
  );
  assert.ok(
    !grandNotices.some(([, msg]) => /stale/.test(String(msg))),
    "no stale-ctx error surfaced",
  );
  sdkStub.control.checkpointHook = null;

  // The brand-new root (/new) starts its own fresh VM (again a NEW instance)
  // — it does NOT inherit the old tree's snapshot.
  const newPi = newExt();
  await newPi.handlers.session_start({ reason: "new" }, newCtx);
  assert.equal(sdkStub.calls.create.length, 2, "a new root gets a fresh VM");
  assert.match(
    sdkStub.calls.create[1].sessionLabel,
    /pi=new-1/,
    "new root's label keyed by its own id",
  );

  // K. Resuming a member of the OLD tree (a new fork of child-1) finds the
  // root's snapshot — and pre-boot cleanup drops the tree's older ones.
  const specMod = await import(`${GINGER_SRC}/spec.mjs`);
  const stalePath = path.join(cdir, "ginger-stale.qcow2");
  fs.writeFileSync(stalePath, "stale-qcow");
  fs.writeFileSync(
    `${stalePath}.json`,
    JSON.stringify({
      name: "ginger-stale",
      path: stalePath,
      label: specMod.makeLabel({ ws: WS, name: "pi:root-1 -- ws", pi: "root-1" }),
      spec: { label: "stale", cwd: "/workspace/ws" },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  const fork2File = path.join(ROOT, "fork2-session.jsonl");
  fs.writeFileSync(
    fork2File,
    JSON.stringify({ type: "session", id: "child-2", parentSession: rootFile }) + "\n",
  );
  // Leave the new root's session first (pi fires shutdown for the session
  // being left) — its VM must not be adopted by the old tree's member.
  await newPi.handlers.session_shutdown({ reason: "quit" }, newCtx);
  assert.ok(sdkStub.vms.at(-1).closed, "new root's VM closed on quit");
  const fork2Pi = newExt();
  const { ctx: fork2Ctx } = mkCtx(fork2File, "child-2");
  await fork2Pi.handlers.session_start({ reason: "resume" }, fork2Ctx);
  assert.equal(sdkStub.calls.resume.length, 1, "tree member resumes the ROOT's snapshot");
  assert.equal(sdkStub.calls.resume[0].path, meta.path, "resumed from the newest root snapshot");
  assert.ok(!fs.existsSync(stalePath), "older tree snapshot removed pre-boot");
  assert.ok(!fs.existsSync(`${stalePath}.json`), "older tree snapshot's sidecar removed pre-boot");

  // The lifecycle marker protocol itself: visible to other pids, invisible
  // to its own pid, and it expires when the heartbeat stops.
  const { activeLifecycleOp } = await import(`${GINGER_SRC}/sessions.mjs`);
  const { spawn: spawnProc } = await import("node:child_process");
  const sleeper = spawnProc("sleep", ["30"]);
  try {
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      lifecycleFile,
      JSON.stringify({ op: "snap", pid: sleeper.pid, at: new Date().toISOString() }),
    );
    assert.equal(activeLifecycleOp(vm.id), "snap", "other live pid's marker is visible");
    fs.writeFileSync(
      lifecycleFile,
      JSON.stringify({ op: "snap", pid: process.pid, at: new Date().toISOString() }),
    );
    assert.equal(activeLifecycleOp(vm.id), null, "own pid's marker is ignored");
    fs.writeFileSync(
      lifecycleFile,
      JSON.stringify({ op: "snap", pid: sleeper.pid, at: new Date().toISOString() }),
    );
    fs.utimesSync(lifecycleFile, old, old);
    assert.equal(activeLifecycleOp(vm.id), null, "stale (unrefreshed) marker expires");
  } finally {
    sleeper.kill();
    try {
      fs.rmSync(lifecycleFile, { force: true });
    } catch {}
  }

  console.log("scenario 3 (fork + background snapshot): PASS");
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log("ALL PI-EXTENSION E2E ASSERTIONS PASSED");
