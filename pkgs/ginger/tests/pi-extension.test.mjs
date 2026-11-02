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
fs.writeFileSync(
  path.join(GUEST_PI, "skills", "demo", "SKILL.md"),
  "guest skill content\n",
);
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
  assert.ok(
    !readOut.includes("must never be served"),
    "host agent dir content is never exposed",
  );
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

fs.rmSync(ROOT, { recursive: true, force: true });
console.log("ALL PI-EXTENSION E2E ASSERTIONS PASSED");
