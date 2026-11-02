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

import { promises as fsp } from "node:fs";
import pathMod from "node:path";

export const calls = { create: [], resume: [], ingress: [], ssh: [] };
export const vms = [];
export let dumpCount = 0;
/** Directory standing in for the guest's /etc/pi/agent (image-baked copy). */
export const guestPi = { dir: null };

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
  static create(options) {
    calls.create.push(options);
    const vm = makeVm(options);
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
export async function listSessions() {
  return [];
}
export async function findSession() {
  return null;
}
export function connectToSession() {
  throw new Error("not supported in stub");
}
