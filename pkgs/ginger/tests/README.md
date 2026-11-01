# Ginger tests

Two end-to-end test suites, both plain node scripts (node ≥ 23.6, which has
native TypeScript type stripping — no build step).

## `pi-extension.test.mjs` — pi extension E2E (hermetic)

Runs the **real** extension (`../pi/extensions/ginger.ts`) and the **real**
ginger src modules against a faithful stub of the gondolin host SDK
(`sdk-stub.mjs`) and a mock pi `ExtensionAPI`. No VM, no network — safe in
any nix build sandbox.

Covers: spec → `VM.create` options; owner features (ingress for `listen`,
`direnv allow`); ingress URL surfacing (access.json, notification, system
prompt, `/ginger` status); login-env + direnv env capture-once semantics and
per-exec injection; non-login bash argv; `/reload-direnv`; snapshotting only
when the session JSONL exists on disk.

```sh
# PI_SDK_DIR is optional; when set, the extension runs from a temp tree with
# a node_modules symlink to it (needed for nix store copies). Without it the
# extension is imported in place and needs local module resolution.
PI_SDK_DIR=/path/to/pi-monorepo node pkgs/ginger/tests/pi-extension.test.mjs
```

The stub deliberately models SDK output-mode semantics: in `stdout: "pipe"`
mode the resolved result's stdout is empty (chunks only flow through
`.output()`). That exact mismatch caused a real bug where env captures came
back empty.

## `real-vm.test.mjs` — full VM lifecycle (real guest)

Boots a genuinely tiny guest (256M RAM, 1 CPU, the SDK's built-in default
image — no image build) and exercises: create → exec (stdout capture, exit
codes, cwd, per-exec env injection) → checkpoint → close → resume → state
persistence → close. Runs on bare metal, in a dev shell, or nested inside a
ginger guest. Without KVM it uses TCG — slower, but fine for this size.

```sh
GONDOLIN_SDK=/path/to/@gondolin/host/dist/src/index.js \
  QEMU_BIN_DIR=/path/to/qemu/bin \
  node pkgs/ginger/tests/real-vm.test.mjs
```

From inside a ginger guest (nested VM), for example:

```sh
GONDOLIN_SDK=$(ls -d /nix/store/*-gondolin-*/lib/node_modules/@gondolin/host/dist/src/index.js | head -1) \
  QEMU_BIN_DIR=$(ls -d /nix/store/*-qemu-*/bin | head -1) \
  node pkgs/ginger/tests/real-vm.test.mjs
```

## Flake checks

| Check | What it runs | Systems | Notes |
| ---------------------- | --------------------- | ---------- | ------------------------------------ |
| `pi-extension-check` | the hermetic E2E | all | fast, sandbox-safe |
| `real-vm-check` | the real VM lifecycle | Linux only | `__noChroot` (qemu); slow under TCG |

```sh
nix build .#checks.aarch64-linux.pi-extension-check
nix build --impure --option sandbox false .#checks.aarch64-linux.real-vm-check
# or everything:
nix flake check
```

Notes on `real-vm-check`:

- `--option sandbox false` (or a nix config with `sandbox = false/auto`) is
  needed because qemu cannot run in the build sandbox; on hosts where
  `sandbox = true` is forced, use the manual invocation above.
- `--impure` propagates `NODE_EXTRA_CA_CERTS` from your environment when it
  is set (TLS-intercepting proxies); harmless otherwise.
- The guest downloads its assets to `$TMPDIR`/`/tmp` at boot — make sure
  there is a few hundred MB of space there.
- On darwin the check is not part of the flake; run the script manually as
  above.
