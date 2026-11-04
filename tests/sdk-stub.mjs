// Stub gondolin host SDK for E2E-testing the pi extension without a VM.
//
// Faithful where it matters: in "pipe" output mode chunks only flow through
// .output() and the resolved result's stdout/stderr are EMPTY (the real SDK
// builds the result from buffered chunks, which pipe mode never fills). A
// stub that ignores this silently produces empty env captures — a real bug
// we shipped once.
//
// vm.fs models the SDK's MountRouterProvider: paths route by longest mount
// prefix; anything unmatched is ENOENT (the router has no guest-rootfs
// fallback). The guest's /etc/pi/agent content is served from `guestPi.dir`
// (a test hook) so tests can assert what skill/config paths actually
// resolve to.

import fsSync from "node:fs";
import { promises as fsp } from "node:fs";
import pathMod from "node:path";

export const calls = { create: [], resume: [], ingress: [], ssh: [] };
export const vms = [];
export let dumpCount = 0;
/** Directory standing in for the guest's /etc/pi/agent (image-baked copy). */
export const guestPi = { dir: null };
/**
 * Test hooks. checkpointHook(p, vm) is awaited DURING vm.checkpoint() —
 * before the qcow file appears — so tests can hold a snapshot in flight and
 * observe the window (lifecycle marker present, no qcow yet).
 * createHook(vm) is awaited DURING VM.create — before the vm is registered
 * — so tests can hold a boot in flight.
 */
export const control = { checkpointHook: null, createHook: null };
/**
 * Host dir standing in for the guest's /workspace/<basename> mount (the
 * workspace hostfs provider). When set, vm.fs serves /workspace/<basename>/…
 * from it — enough for tests to assert host→guest path translation end to
 * end through a real pi tool.
 */
control.workspaceHost = null;

function makeFs() {
  const enoent = (p) => {
    const e = new Error(`ENOENT: no such file or directory: ${p}`);
    e.code = "ENOENT";
    return e;
  };
  const serve = async (p) => {
    if (guestPi.dir && p.startsWith("/etc/pi/agent")) {
      const rel = p.slice("/etc/pi/agent".length).replace(/^\//, "");
      if (!rel) throw enoent(p);
      return fsp.readFile(pathMod.join(guestPi.dir, rel), "utf8");
    }
    if (control.workspaceHost) {
      const mount = `/workspace/${pathMod.basename(control.workspaceHost)}`;
      if (p === mount || p.startsWith(mount + "/")) {
        const rel = p.slice(mount.length).replace(/^\//, "");
        try {
          return await fsp.readFile(pathMod.join(control.workspaceHost, rel), "utf8");
        } catch {
          throw enoent(p);
        }
      }
    }
    throw enoent(p);
  };
  return {
    readFile: serve,
    access: async (p) => {
      await serve(p);
    },
  };
}

function makeProc(result, opts = {}) {
  const effective = { ...result };
  if (opts.stdout === "pipe") effective.stdout = "";
  if (opts.stderr === "pipe") effective.stderr = "";
  const p = Promise.resolve(effective);
  p.output = async function* () {
    if (result.stdout) yield { data: Buffer.from(result.stdout, "utf8") };
    if (result.stderr) yield { data: Buffer.from(result.stderr, "utf8") };
  };
  return p;
}

export class VM {
  static async create(options) {
    calls.create.push(options);
    const vm = makeVm(options);
    if (control.createHook) await control.createHook(vm);
    vms.push(vm);
    return vm;
  }
}

export class VmCheckpoint {
  static load(path) {
    return {
      resume: (options) => {
        calls.resume.push({ path, options });
        const vm = makeVm(options, true);
        vms.push(vm);
        return vm;
      },
    };
  }
}

function makeVm(options, resumed = false) {
  const execCalls = [];
  const checkpointCalls = [];
  return {
    id: resumed ? "stub-vm-resumed" : `stub-vm-${vms.length + 1}`,
    options,
    execCalls,
    checkpointCalls,
    closed: false,
    fs: makeFs(),
    exec(cmd, opts = {}) {
      execCalls.push({ cmd, opts });
      const flat = Array.isArray(cmd) ? cmd.join(" ") : String(cmd);
      if (flat.includes("command -v bash"))
        return makeProc({ exitCode: 0, stdout: "/bin/bash\n", stderr: "" }, opts);
      if (flat === "direnv allow") return makeProc({ exitCode: 0, stdout: "", stderr: "" }, opts);
      if (flat === "/bin/bash -lc env -0 | base64") {
        const payload =
          "PATH=/root/.nix-profile/bin:/usr/local/sbin:/usr/bin\0NIX_BASE=yes\0_=/bin/env\0";
        return makeProc(
          {
            exitCode: 0,
            stdout: Buffer.from(payload, "utf8").toString("base64") + "\n",
            stderr: "",
          },
          opts,
        );
      }
      if (flat === "direnv exec . /bin/sh -c env -0 | base64") {
        dumpCount++;
        const payload = `PATH=/opt/devshell${dumpCount}/bin:/usr/bin\0GINGER_TEST_VAR=run${dumpCount}\0HOME=/root\0`;
        return makeProc(
          {
            exitCode: 0,
            stdout: Buffer.from(payload, "utf8").toString("base64") + "\n",
            stderr: "",
          },
          opts,
        );
      }
      return makeProc({ exitCode: 0, stdout: `ran:${flat}\n`, stderr: "" }, opts);
    },
    async enableIngress(o) {
      calls.ingress.push(o);
      return { url: "http://127.0.0.1:4711/" };
    },
    async enableSsh(o) {
      calls.ssh.push(o);
      return { command: "ssh stub", host: o.listenHost, port: o.listenPort, user: o.user };
    },
    async checkpoint(p) {
      checkpointCalls.push(p);
      if (control.checkpointHook) await control.checkpointHook(p, this);
      // The real checkpoint leaves the qcow on disk when it resolves.
      fsSync.mkdirSync(pathMod.dirname(p), { recursive: true });
      fsSync.writeFileSync(p, "stub-qcow");
    },
    async close() {
      this.closed = true;
    },
  };
}

export class RealFSProvider {
  constructor(root) {
    this.root = root;
  }
}
export class ReadonlyProvider {
  constructor(inner) {
    this.inner = inner;
  }
}
export class ShadowProvider {
  constructor(inner, opts) {
    this.inner = inner;
    this.opts = opts;
  }
}
export class MemoryProvider {}
export function createShadowPathPredicate(paths) {
  return (p) => paths.includes(p);
}
export function makePlaceholderFunc({ length }) {
  return () => "x".repeat(length);
}
// Session registry: mirrors the real SDK — one entry per created/resumed VM,
// alive while it is not closed, addressable by exact or prefix id. The
// label comes from the create options (sessionLabel), like the real SDK.
export async function listSessions() {
  return vms
    .filter((v) => !v.closed)
    .map((v) => ({
      id: v.id,
      pid: process.pid,
      socketPath: `/tmp/${v.id}.sock`,
      label: v.options?.sessionLabel ?? null,
      alive: true,
    }));
}
export async function findSession(query) {
  const all = await listSessions();
  return all.find((s) => s.id === query || s.id.startsWith(query)) ?? null;
}
/** No-op in the stub — no cross-process stale entries to reap. */
export async function gcSessions() {}
export function connectToSession() {
  throw new Error("not supported in stub");
}
