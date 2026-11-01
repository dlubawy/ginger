# ginger

A spicy root for coding agents.

ginger gives an LLM coding agent a complete, self-contained development
environment it has full control over: a real filesystem, its own toolchain,
its own network egress policy, and a shell that behaves like one — all
inside a micro VM that the agent (or you) can snapshot, resume, and carry
between machines.

The name is deliberate: ginger is a root, and it's spicy. The project's goal
is to hand the agent an environment hot enough to do real work in, without
giving it your machine.

## Why a micro VM?

Containers share the host kernel; a compromised or simply over-eager agent
process can still see too much. ginger builds on
[gondolin](https://github.com/earendil-works/gondolin) micro VMs because:

- **Real isolation** — each session is its own guest with its own kernel,
  disk, and memory. The workspace is mounted in; the host is not.
- **Secret injection without exposure** — egress is allow-listed per host,
  and secrets can be routed to specific upstreams only (`--host-secret`),
  so an agent can authenticate to your services without ever holding a
  credential it shouldn't see.
- **Ingress on demand** — a localhost gateway exposes guest services (dev
  servers, dashboards) to the host when you ask for it, and nothing when
  you don't.

The primary consumer is the [pi](https://github.com/earendil-works/pi) coding
agent: ginger's pi extension routes pi's built-in tools (bash, read, write,
edit, grep, find, ls) into the VM, so the agent's entire world — commands,
files, environment — lives in the guest.

## What's in the box

| Component | Where | What it does |
| --------- | ----- | ------------ |
| `ginger` CLI | `pkgs/ginger/src/` | Session and snapshot lifecycle on top of the gondolin host SDK: start, attach, exec, stop, snapshot, rename, remove. |
| The image | `pkgs/ginger/gondolin-image/` | An opinionated Alpine-based OCI image for coding agents: nix + direnv (devshell workflows), git, node, python, and `playwright-cli` with its dashboard served over ingress at VM boot. |
| pi extension | `pkgs/ginger/pi/extensions/ginger.ts` | Replaces pi's native tools with VM-backed ones; isolates the guest environment from the host; evaluates `.envrc` once at start; surfaces ingress URLs; snapshots per pi session. |
| pi config + wrapper | `pkgs/ginger/pi/` | A nix-built `~/.pi/agent` config (extensions, skills, prompts, themes, models) and a `pi` host wrapper that keeps it up to date — merging into your existing agent dir, never deleting anything. |
| Nix integration | `flake.nix`, `pkgs/default.nix` | Packages (`ginger`, `gondolin`, `playwright-cli`, `pi`), flake checks (see [tests](pkgs/ginger/tests/README.md)), and a dev shell. |

## Quick start

The repo is a nix flake; `.envrc` uses `use flake`, so direnv users get the
dev shell on `cd`. Otherwise:

```sh
nix develop                     # or: nix run .#default -c ginger --help
```

Then, from any project directory:

```sh
ginger -w ~/code/my-project     # start a session with that workspace mounted
ginger --pi                     # same, but attach the pi agent instead of a shell
ginger -e "fix the failing test"   # one-shot non-interactive exec
```

With no arguments, `ginger` shows a picker of active sessions and saved
snapshots — resume, snapshot, or start fresh.

### Project profile: `.pi/ginger.json`

A workspace can carry its VM preferences in `.pi/ginger.json`, picked up
automatically when starting a session (and by the pi extension):

```json
{ "direnv": true, "listen": true }
```

- `"direnv": true` — evaluate the workspace's `.envrc` once at VM start and
  inject the resulting environment into every tool command (a nix devshell
  means `just`, your language toolchains, etc. are just on PATH).
- `"listen": true` — enable the ingress gateway on an ephemeral port; the
  URL is announced in pi, recorded in the session's `access.json`, and shown
  by `/ginger`.

The full key set (and the equivalent CLI flags) is documented in
`ginger --help`: memory/rootfs sizing, extra host mounts, egress
allow-lists and per-host secrets, TCP mapping, SSH in both directions, and
named profiles under `~/.config/ginger/profiles/`.

### The pi experience

Inside `pi`, the ginger extension:

- runs every tool command in the VM's spec cwd with an environment made of
  exactly three layers — the guest's login baseline, the (optional) direnv
  environment, and pi's session variables. **The host environment is never
  forwarded**; no host secrets, no `HOME=/Users/...`, nothing.
- evaluates the `.envrc` once at start (with a live status line while nix
  chews), then re-evaluates only when you ask: `/reload-direnv`.
- takes one snapshot per pi session on shutdown — and only when the session
  actually has a transcript on disk. Restarting with the same session resumes
  the exact VM, features (ingress, direnv) included.
- reports state on demand: `/ginger` shows origin, cwd, ingress URL, and env
  capture status.

The image also boots `playwright-cli`'s dashboard as an idempotent daemon
and routes it at `/` over ingress; manage the route with the in-guest
`playwright-dashboard` helper (`add|remove|port|status`).

## Repository layout

```
flake.nix                  packages, checks, dev shell
pkgs/default.nix           per-system package set wiring
pkgs/gondolin/             gondolin host SDK + CLI (v0.14.0)
pkgs/playwright-cli/       playwright-cli as a proper nix package (pinned tarballs)
pkgs/ginger/
  default.nix, ginger.nix  the ginger CLI package (+ pi wrapper, installer)
  src/                     CLI: spec, sessions, checkpoints, owner features, UI
  gondolin-image/          image build: config, rootfs extras, init script
  pi/                      nix-built pi agent config + extensions + host wrapper
  tests/                   E2E suites (hermetic extension test + real VM lifecycle)
```

## Development

```sh
nix develop                # dev shell (pre-commit tooling included)
nix flake check            # pre-commit checks + pi-extension-check (all systems)
```

Two end-to-end suites live in [`pkgs/ginger/tests/`](pkgs/ginger/tests/README.md):

- **`pi-extension-check`** — the real extension and real ginger source
  exercised against a faithful stub of the gondolin SDK. Hermetic, fast,
  runs in the build sandbox on every supported system.
- **`real-vm-check`** (Linux) — boots a tiny 256M guest and drives the full
  lifecycle: create → exec → checkpoint → resume → state persistence. Runs
  unsandboxed; also runnable manually anywhere, including nested inside a
  ginger VM.

Commits run through a pre-commit hook set (nixfmt, mdformat, flake-checker,
trufflehog, commitizen, …) via `prek`.

## Design notes

- **The agent owns its environment.** Everything the tools see is declared:
  image defaults + spec env + direnv + pi session vars. Anything not
  declared is absent — that's a feature, not a gap.
- **Evaluate once, refresh on demand.** A nix devshell `.envrc` can take
  minutes; ginger evaluates it at VM start (with visible progress) and never
  again unless the user runs `/reload-direnv`. Per-command evaluation was
  tried and rejected.
- **Snapshots are per-session artifacts.** One pi session → one snapshot,
  named from the session (`pi:<id>`), superseded on the next shutdown.
  Sessions with no transcript produce none.
- **Best-effort features, loud failures.** A failing owner feature (ingress,
  SSH, direnv) records an error in the session's `access.json` and notifies —
  it never sinks the VM.
- **Never delete user state.** The pi config installer deep-merges into
  `~/.pi/agent`, with existing user values winning; directory trees are
  overlaid, and nothing is ever removed.

## Supported systems

`x86_64-linux`, `aarch64-linux`, `aarch64-darwin` (macOS Apple Silicon).
The guest image is built for the VM's target architecture; on macOS the
host-side tooling runs natively while guests run under QEMU (HVF
acceleration where available, TCG otherwise).
