// Real VM lifecycle test against the gondolin host SDK.
//
// Boots a genuinely tiny guest (256M RAM, 1 CPU, the SDK's built-in default
// image — no image build required) and exercises the full lifecycle:
// create -> exec (stdout/exit codes/cwd/env injection) -> checkpoint ->
// close -> resume -> state persistence -> close.
//
// Runs on bare metal, in a dev shell, inside a ginger guest (nested VM), or
// as a flake check on Linux (`nix build .#checks.<system>.real-vm-check`,
// which runs unsandboxed). Under TCG without KVM it is slow but works.
//
// Usage:
//   GONDOLIN_SDK=/path/to/@gondolin/host/dist/src/index.js \
//     node pkgs/ginger/tests/real-vm.test.mjs
//
// Env:
//   GONDOLIN_SDK  required — entry point of the gondolin host SDK
//   QEMU_BIN_DIR  optional — prepended to PATH (the SDK spawns qemu-system-*)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const sdkPath = process.env.GONDOLIN_SDK;
if (!sdkPath) {
  console.error("GONDOLIN_SDK env var is required (path to the host SDK entry point)");
  process.exit(2);
}
if (process.env.QEMU_BIN_DIR) {
  process.env.PATH = `${process.env.QEMU_BIN_DIR}:${process.env.PATH}`;
}

const sdk = await import(pathToFileURL(sdkPath).href);
const { VM, VmCheckpoint } = sdk;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ginger-real-vm-"));
const t0 = Date.now();
const log = (...a) => console.log("[real-vm]", ...a, `${((Date.now() - t0) / 1000).toFixed(1)}s`);

let vm;
try {
  // 1. create a tiny VM
  vm = await VM.create({ memory: "256M", cpus: 1 });
  log("created", vm.id);

  // 2. basic exec: stdout capture + exit code
  let r = await vm.exec(["/bin/sh", "-c", "echo hello-from-vm"]);
  assert.equal(r.exitCode, 0, "exec exits 0");
  assert.match(String(r.stdout), /hello-from-vm/, "stdout captured");

  // 3. cwd option + file write/read round trip
  await vm.exec(["/bin/sh", "-c", "echo marker-123 > .marker-test"], { cwd: "/" });
  r = await vm.exec(["/bin/sh", "-c", "cat .marker-test && pwd"], { cwd: "/" });
  assert.match(String(r.stdout), /marker-123/, "file written via exec is readable");
  assert.match(String(r.stdout), /^\/\s*$/m, "exec ran in the requested cwd");

  // 4. per-exec env injection reaches the command
  r = await vm.exec(
    ["/bin/sh", "-c", 'echo "$GINGER_TEST_INJECT"'],
    { env: { GINGER_TEST_INJECT: "injected-ok" } },
  );
  assert.equal(r.exitCode, 0);
  assert.match(String(r.stdout), /injected-ok/, "per-exec env reaches the command");

  // 5. non-zero exit codes propagate
  r = await vm.exec(["/bin/sh", "-c", "exit 7"]);
  assert.equal(r.exitCode, 7, "non-zero exit code propagates");

  // 6. checkpoint -> close -> resume -> state persists
  const snap = path.join(tmp, "test.qcow2");
  await vm.checkpoint(snap);
  log("checkpointed to", snap);
  await vm.close();

  const cp = VmCheckpoint.load(snap);
  vm = await cp.resume({ memory: "256M", cpus: 1 });
  log("resumed", vm.id);
  r = await vm.exec(["/bin/sh", "-c", "cat /.marker-test"]);
  assert.match(String(r.stdout), /marker-123/, "state persists across checkpoint/resume");
} finally {
  if (vm) await vm.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

log("PASS — full VM lifecycle verified");
