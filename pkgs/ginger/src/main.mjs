#!/usr/bin/env node
/**
 * ginger — run an LLM agent in a gondolin micro-VM with persistent sessions.
 *
 * Architecture:
 *   Every VM session is owned by a detached "owner" process (this same script
 *   re-spawned with --owner). The owner creates or resumes the VM through the
 *   gondolin host SDK and keeps it alive after the client exits. Client
 *   invocations discover sessions via the SDK session registry, then interact
 *   through the `gondolin` CLI (attach/exec), which handles pty relay,
 *   backpressure and the Ctrl-] detach escape.
 *
 *   Shutdown is graceful: the SDK only honours a `lifecycle` shutdown on the
 *   sandbox controller's own IPC connection (held by the owner). The client
 *   therefore signals the owner process (SIGTERM), whose handler calls
 *   `vm.close()` to make the controller terminate qemu cleanly — no guest-side
 *   `poweroff -f`.
 */

import fs from "node:fs";
import path from "node:path";

import { fail, sdk } from "./config.mjs";
import {
  ensureContainerImage,
  ensureVmImage,
  removeImages,
} from "./images.mjs";
import {
  ClientLease,
  activeLifecycleOp,
  gcLeases,
  gcSessionDirs,
  gingerSessions,
  matchSession,
  readSessionSpec,
} from "./sessions.mjs";
import {
  listCheckpoints,
  matchCheckpoints,
  removeCheckpoints,
} from "./checkpoints.mjs";
import { pickTarget, targetTitle } from "./picker.mjs";
import {
  buildSpec,
  formatLabel,
  mergeEnv,
  parseLabel,
  setLabelName,
} from "./spec.mjs";
import {
  interact,
  runOwner,
  shutdownSession,
  snapshotSession,
  startOwner,
  waitForAccess,
  waitForSession,
} from "./owner.mjs";
import { Step, ask, formatAge } from "./ui.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const USAGE = `
Ginger agent

Description:
  A tool for managing an LLM agent in a spicy root container using a gondolin
  micro VM. Sessions persist across runs; with no arguments, pick from the
  active sessions and saved snapshots (or start a new one).

Usage:
  ginger [options]
  ginger -e|--exec COMMAND [ARGS...]
  ginger [options] -- COMMAND [ARGS...]
  ginger <command> [options]

Commands:
  ls                            List active sessions and saved snapshots
  stop [SESSION]                Gracefully shut a session down (picker when
                                omitted)
  snap [SESSION] [-n NAME]      Snapshot a session and stop it (picker when
                                omitted; -n names the snapshot)
  rm <SNAPSHOT>...              Remove snapshots (-y to skip confirmation)
  rename <SNAPSHOT> [NEW-NAME]  Set a snapshot's custom name; omit NEW-NAME
                                to clear it

SESSION matches an id, unique id prefix, custom name or workspace path.

Examples:
  ginger -w /home/user/code-project
  ginger --pi
  ginger -e "fix the failing test"
  ginger snap -n backup      # snapshot and stop (picker when several)
  ginger stop myproj         # shut down by name
  ginger -w ~/code -n myproj   # memorable name for the session/snapshots

Options:

  Session selection:
    --session ID               Use the session with this id (or unique prefix)
    -w, --workspace PATH       Workspace to mount in the VM (also scopes
                               ls/rm); the mount itself only applies when
                               starting a new session
    -n, --name NAME            Custom name for the session/snapshot label

  This connection (also valid when attaching to an existing session):
    --cwd PATH                 Working directory inside the guest; overrides
                               the cwd implied by -w (per-connection only)
    --env KEY=VALUE            Set environment variable (can repeat)
    -e, --exec COMMAND         Execute COMMAND [ARGS...] non-interactively
                               (args after this flag are passed through
                               verbatim)
        --pi                   Attach to the pi agent instead of a shell

  VM creation (only when starting a new session):
    --profile NAME             Load VM options from the profile
                               ~/.config/ginger/profiles/NAME.json (keys:
                               cwd, env, memory, rootfsSize, hostMounts,
                               memMounts, allowHosts, secrets, tcpMap,
                               sshAllowHosts, sshAgent, sshKnownHosts,
                               sshCredentials, disableWebSockets, ssh,
                               listen, direnv). CLI flags take precedence
                               over the profile
    -d, --direnv               Allow direnv in workspace
    -l, --listen [ADDR]        Start an ingress gateway (HOST:PORT; default
                               127.0.0.1 with an ephemeral port)
    --memory-size SIZE         Ensure VM memory is at least SIZE (K/M/G/T)
    --rootfs-size SIZE         Ensure the rootfs virtual disk is at least
                               SIZE (K/M/G/T)
    --mount-hostfs HOST:GUEST[:ro]
                               Mount a host directory at a guest path
                               (repeatable)
    --mount-memfs PATH         Create a memory-backed mount at a guest path
                               (repeatable)

  Guest egress (VM creation):
    --allow-host HOST          Allow HTTP requests to this host (repeatable)
    --host-secret NAME[=VALUE] | NAME@HOST[,HOST...][=VALUE]
                               Send an env secret to the matching hosts
                               (repeatable); without explicit hosts, suggested
                               hosts are discovered and confirmed
                               interactively
    --tcp-map SPEC             Map guest HOST[:PORT] to upstream HOST:PORT
                               (GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT;
                               repeatable)
    --disable-websockets       Disable WebSocket upgrades for egress and
                               ingress

  Guest SSH egress (VM creation):
    --ssh-allow-host HOST[:PORT]
                               Allow outbound SSH to this host (repeatable;
                               port defaults to 22)
    --ssh-agent [SOCK]         Use an ssh-agent for host-side auth (defaults
                               to $SSH_AUTH_SOCK); requires at least one
                               --ssh-allow-host or --ssh-credential
    --ssh-known-hosts PATH     known_hosts file for upstream verification
                               (repeatable)
    --ssh-credential SPEC      Host-side SSH key: HOST[:PORT]=PATH or
                               USER@HOST[:PORT]=PATH, optional
                               ,passphrase-env=ENV or ,passphrase=...
                               (repeatable)

  SSH access into the VM (VM creation):
    --ssh                      Enable SSH via a localhost port forward and
                               print the ssh command to use
    --ssh-user USER            SSH username (default: root)
    --ssh-port PORT            Local listen port (default: 0 = ephemeral)
    --ssh-listen HOST          Local listen host (default: 127.0.0.1)

  Misc:
    --rmi                      Remove the container and VM images when done
    -y, --yes                  Skip confirmation prompts (rm)
    -h, --help                 Show this help

Everything after a bare -- is treated as the command to exec.
`;

function needValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("-"))
    fail(`option ${flag} requires a value`);
  return v;
}

const COMMANDS = {
  ls: "ls",
  list: "ls",
  stop: "stop",
  snap: "snap",
  snapshot: "snap",
  rm: "rm",
  remove: "rm",
  rename: "rename",
};

function parseArgs(argv) {
  const opts = {
    command: null,
    targets: [],
    direnv: false,
    execArgs: null,
    pi: false,
    session: null,
    rmi: false,
    yes: false,
    listen: null,
    workspace: null,
    name: null,
    help: false,
    // Per-connection
    cwd: null,
    env: [],
    // VM creation
    profile: null,
    memorySize: null,
    rootfsSize: null,
    mountHostfs: [],
    mountMemfs: [],
    allowHost: [],
    hostSecret: [],
    tcpMap: [],
    sshAllowHost: [],
    sshAgent: undefined,
    sshKnownHosts: [],
    sshCredential: [],
    disableWebSockets: false,
    ssh: false,
    sshUser: null,
    sshPort: null,
    sshListen: null,
  };
  let start = 0;
  if (COMMANDS[argv[0]]) {
    opts.command = COMMANDS[argv[0]];
    start = 1;
  }
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      opts.execArgs = argv.slice(i + 1);
      break;
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-w" || arg === "--workspace") {
      opts.workspace = needValue(argv, i++, arg);
    } else if (arg.startsWith("--workspace=")) {
      opts.workspace = arg.slice("--workspace=".length);
    } else if (arg === "-l" || arg === "--listen") {
      // Optional value: -l for the default, -l ADDR or -l=ADDR for a custom one.
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-"))
        opts.listen = needValue(argv, i++, arg);
      else opts.listen = true;
    } else if (arg.startsWith("--listen=")) {
      opts.listen = arg.slice("--listen=".length) || true;
    } else if (arg === "-n" || arg === "--name") {
      opts.name = needValue(argv, i++, arg);
    } else if (arg.startsWith("--name=")) {
      opts.name = arg.slice("--name=".length);
    } else if (arg === "-y" || arg === "--yes") {
      opts.yes = true;
    } else if (arg === "-d" || arg === "--direnv") {
      opts.direnv = true;
    } else if (arg === "-e" || arg === "--exec") {
      opts.execArgs = argv.slice(i + 1);
      break;
    } else if (arg === "--pi") {
      opts.pi = true;
    } else if (arg === "--rmi") {
      opts.rmi = true;
    } else if (arg === "--session") {
      opts.session = needValue(argv, i++, arg);
    } else if (arg === "--cwd") {
      opts.cwd = needValue(argv, i++, arg);
    } else if (arg.startsWith("--cwd=")) {
      opts.cwd = arg.slice("--cwd=".length);
    } else if (arg === "--env") {
      opts.env.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--env=")) {
      opts.env.push(arg.slice("--env=".length));
    } else if (arg === "--profile") {
      opts.profile = needValue(argv, i++, arg);
    } else if (arg.startsWith("--profile=")) {
      opts.profile = arg.slice("--profile=".length);
    } else if (arg === "--memory-size") {
      opts.memorySize = needValue(argv, i++, arg);
    } else if (arg.startsWith("--memory-size=")) {
      opts.memorySize = arg.slice("--memory-size=".length);
    } else if (arg === "--rootfs-size") {
      opts.rootfsSize = needValue(argv, i++, arg);
    } else if (arg.startsWith("--rootfs-size=")) {
      opts.rootfsSize = arg.slice("--rootfs-size=".length);
    } else if (arg === "--mount-hostfs") {
      opts.mountHostfs.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--mount-hostfs=")) {
      opts.mountHostfs.push(arg.slice("--mount-hostfs=".length));
    } else if (arg === "--mount-memfs") {
      opts.mountMemfs.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--mount-memfs=")) {
      opts.mountMemfs.push(arg.slice("--mount-memfs=".length));
    } else if (arg === "--allow-host") {
      opts.allowHost.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--allow-host=")) {
      opts.allowHost.push(arg.slice("--allow-host=".length));
    } else if (arg === "--host-secret") {
      opts.hostSecret.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--host-secret=")) {
      opts.hostSecret.push(arg.slice("--host-secret=".length));
    } else if (arg === "--tcp-map") {
      opts.tcpMap.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--tcp-map=")) {
      opts.tcpMap.push(arg.slice("--tcp-map=".length));
    } else if (arg === "--disable-websockets") {
      opts.disableWebSockets = true;
    } else if (arg === "--ssh-allow-host") {
      opts.sshAllowHost.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--ssh-allow-host=")) {
      opts.sshAllowHost.push(arg.slice("--ssh-allow-host=".length));
    } else if (arg === "--ssh-agent") {
      // Optional value: bare --ssh-agent means $SSH_AUTH_SOCK.
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-"))
        opts.sshAgent = needValue(argv, i++, arg);
      else opts.sshAgent = true;
    } else if (arg.startsWith("--ssh-agent=")) {
      opts.sshAgent = arg.slice("--ssh-agent=".length) || true;
    } else if (arg === "--ssh-known-hosts") {
      opts.sshKnownHosts.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--ssh-known-hosts=")) {
      opts.sshKnownHosts.push(arg.slice("--ssh-known-hosts=".length));
    } else if (arg === "--ssh-credential") {
      opts.sshCredential.push(needValue(argv, i++, arg));
    } else if (arg.startsWith("--ssh-credential=")) {
      opts.sshCredential.push(arg.slice("--ssh-credential=".length));
    } else if (arg === "--ssh") {
      opts.ssh = true;
    } else if (arg === "--ssh-user") {
      opts.sshUser = needValue(argv, i++, arg);
    } else if (arg.startsWith("--ssh-user=")) {
      opts.sshUser = arg.slice("--ssh-user=".length);
    } else if (arg === "--ssh-port") {
      const v = needValue(argv, i++, arg);
      const p = Number(v);
      if (!Number.isInteger(p) || p < 0 || p > 65535)
        fail(`invalid --ssh-port value: ${v} (port must be 0-65535)`);
      opts.sshPort = p;
    } else if (arg.startsWith("--ssh-port=")) {
      const v = arg.slice("--ssh-port=".length);
      const p = Number(v);
      if (!Number.isInteger(p) || p < 0 || p > 65535)
        fail(`invalid --ssh-port value: ${v} (port must be 0-65535)`);
      opts.sshPort = p;
    } else if (arg === "--ssh-listen") {
      opts.sshListen = needValue(argv, i++, arg);
    } else if (arg.startsWith("--ssh-listen=")) {
      opts.sshListen = arg.slice("--ssh-listen=".length);
    } else if (arg.startsWith("-")) {
      fail(`unknown option '${arg}' (see --help)`);
    } else if (opts.command) {
      opts.targets.push(arg);
    } else {
      fail(`unexpected argument '${arg}' (see --help)`);
    }
  }
  return opts;
}

/**
 * Flags that only make sense when ginger creates the VM itself. Used to fail
 * loudly when they are combined with a management command or an existing
 * session instead of being silently ignored. (-w is exempt: it scopes
 * selection, and resuming a workspace's session is the normal flow.)
 */
function creationOnlyFlags(opts) {
  const flags = [];
  if (opts.profile) flags.push("--profile");
  if (opts.memorySize) flags.push("--memory-size");
  if (opts.rootfsSize) flags.push("--rootfs-size");
  if (opts.mountHostfs.length > 0) flags.push("--mount-hostfs");
  if (opts.mountMemfs.length > 0) flags.push("--mount-memfs");
  if (opts.allowHost.length > 0) flags.push("--allow-host");
  if (opts.hostSecret.length > 0) flags.push("--host-secret");
  if (opts.tcpMap.length > 0) flags.push("--tcp-map");
  if (opts.sshAllowHost.length > 0) flags.push("--ssh-allow-host");
  if (opts.sshAgent !== undefined && opts.sshAgent !== null)
    flags.push("--ssh-agent");
  if (opts.sshKnownHosts.length > 0) flags.push("--ssh-known-hosts");
  if (opts.sshCredential.length > 0) flags.push("--ssh-credential");
  if (opts.disableWebSockets) flags.push("--disable-websockets");
  if (
    opts.ssh ||
    opts.sshUser !== null ||
    opts.sshPort !== null ||
    opts.sshListen !== null
  )
    flags.push("--ssh");
  if (opts.listen) flags.push("-l, --listen");
  if (opts.direnv) flags.push("-d, --direnv");
  return flags;
}

// ---------------------------------------------------------------------------
// Management commands: ls, rm, rename
// ---------------------------------------------------------------------------

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "?";
  if (bytes < 1024 ** 2) return `${Math.ceil(bytes / 1024)}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

function printTable(headers, rows) {
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => r[c]?.length ?? 0)),
  );
  const line = (cells) =>
    "  " +
    cells
      .map((c, i) => String(c ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

async function commandList(opts) {
  const wsPath = opts.workspace ? path.resolve(opts.workspace) : null;
  let sessions = await gingerSessions();
  if (wsPath)
    sessions = sessions.filter((s) => parseLabel(s.label).ws === wsPath);
  let checkpoints = listCheckpoints();
  if (wsPath)
    checkpoints = checkpoints.filter((m) => parseLabel(m.label).ws === wsPath);

  console.log(`Sessions (${sessions.length}):`);
  if (sessions.length === 0) console.log("  (none)");
  else
    printTable(
      ["NAME", "ID", "AGE", "LABEL"],
      sessions.map((s) => [
        targetTitle("session", s),
        s.id,
        formatAge(s.createdAt),
        formatLabel(s.label),
      ]),
    );

  console.log(`\nSnapshots (${checkpoints.length}):`);
  if (checkpoints.length === 0) console.log("  (none)");
  else
    printTable(
      ["NAME", "CREATED", "SIZE", "IMAGE"],
      checkpoints.map((m) => [
        targetTitle("checkpoint", m),
        new Date(m.createdAt).toLocaleString(),
        formatSize(fs.statSync(m.path, { throwIfNoEntry: false })?.size),
        path.basename(m.path),
      ]),
    );
}

async function commandRemove(opts) {
  if (opts.targets.length === 0) fail("usage: ginger rm <SNAPSHOT>... [-y]");
  const targets = matchCheckpoints(opts.targets);
  console.log(`Removing ${targets.length} snapshot(s):`);
  for (const m of targets) {
    const size = fs.statSync(m.path, { throwIfNoEntry: false })?.size;
    console.log(
      `  ${targetTitle("checkpoint", m)}  ${path.basename(m.path)}${
        size ? `  (${formatSize(size)})` : ""
      }`,
    );
  }
  if (!opts.yes) {
    const answer = (
      await ask("\nRemove these snapshots? [y/N] ", process.stdout)
    ).toLowerCase();
    if (!answer.startsWith("y")) {
      console.log("aborted");
      return;
    }
  }
  removeCheckpoints(targets);
  console.log(`removed ${targets.length} snapshot(s)`);
}

/** `ginger stop [SESSION]` / `ginger snap [SESSION] [-n NAME]`. */
async function commandLifecycle(opts) {
  const sessions = await gingerSessions();
  let session;
  if (opts.targets[0]) {
    session = matchSession(sessions, opts.targets[0]);
  } else {
    if (sessions.length === 0) fail("no active ginger sessions");
    session = (await pickTarget(sessions, [], { fresh: false })).target;
  }

  const op = activeLifecycleOp(session.id);
  if (op)
    fail(
      `session ${session.id} is already being ${
        op === "snap" ? "snapshotted" : "stopped"
      } by another ginger client`,
    );

  if (opts.command === "stop") {
    await shutdownSession(session);
    return 0;
  }

  // snap: prefer the spec the session was actually started with so the
  // workspace mount, cwd, env, tcp and listen are preserved without
  // re-supplying any flags. Falls back to a CLI-built spec for sessions
  // created before spec persistence existed.
  const spec = readSessionSpec(session.id) ?? (await buildSpec(opts));
  const snapLabel = opts.name
    ? setLabelName(session.label, opts.name)
    : session.label;
  await snapshotSession(session, spec, snapLabel);
  return 0;
}

async function commandRename(opts) {
  if (opts.targets.length < 1 || opts.targets.length > 2)
    fail("usage: ginger rename <SNAPSHOT> [NEW-NAME]");
  const [query, newName] = opts.targets;
  const matches = matchCheckpoints([query]);
  if (matches.length !== 1)
    fail(
      `expected exactly one snapshot matching '${query}', got ${matches.length}`,
    );
  const m = matches[0];
  m.label = setLabelName(m.label, newName ?? null);
  fs.writeFileSync(`${m.path}.json`, JSON.stringify(m, null, 2));
  console.log(
    newName
      ? `renamed '${query}' to '${newName}'`
      : `cleared the name of '${query}'`,
  );
  console.log(`label: ${m.label}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--owner") return runOwner();

  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE.trim());
    return;
  }

  // Sweep lease files left behind by clients that died without cleanup, and
  // drop session dirs (spec.json & co.) for sessions that are no longer
  // live. A failed session fetch skips the dir sweep — never treat "unknown"
  // as "none".
  gcLeases();
  const live = await gingerSessions().catch(() => null);
  if (live) gcSessionDirs(live.map((s) => s.id));

  // Management and lifecycle commands need no images and no VM — and never
  // start one, so VM-creation flags have nothing to apply to.
  const creationFlags = creationOnlyFlags(opts);
  if (opts.command && creationFlags.length > 0)
    fail(`${creationFlags.join(", ")} only apply when starting a new session`);
  if (opts.command === "ls") return commandList(opts);
  if (opts.command === "rm") return commandRemove(opts);
  if (opts.command === "rename") return commandRename(opts);
  if (opts.command === "stop" || opts.command === "snap")
    return commandLifecycle(opts);

  await ensureContainerImage();
  await ensureVmImage();

  // With -w, scope both sessions and snapshots to that workspace (the label
  // carries the absolute host path).
  const wsPath = opts.workspace ? path.resolve(opts.workspace) : null;
  let sessions = await gingerSessions();
  if (wsPath)
    sessions = sessions.filter((s) => parseLabel(s.label).ws === wsPath);

  const checkpoints = listCheckpoints().filter(
    (m) => !wsPath || parseLabel(m.label).ws === wsPath,
  );

  // VM-creation flags cannot be applied to a session that already exists —
  // fail loudly instead of silently ignoring them.
  const refuseExistingSession = (existing) => {
    if (creationFlags.length === 0) return;
    fail(
      `${creationFlags.join(", ")} only apply when starting a new session — ` +
        `session ${existing.id} already exists`,
    );
  };

  let spec = null;
  let session = null;
  if (opts.session) {
    const match = sessions.find(
      (s) => s.id === opts.session || s.id.startsWith(opts.session),
    );
    if (!match) fail(`no active ginger session matching '${opts.session}'`);
    refuseExistingSession(match);
    session = match;
  } else {
    // Unified picker: live sessions plus saved snapshots and an optional
    // "start a new session" entry.
    const choice = await pickTarget(sessions, checkpoints, { fresh: true });
    if (choice.type === "session") {
      refuseExistingSession(choice.target);
      session = choice.target;
    } else {
      const checkpoint = choice.type === "checkpoint" ? choice.target : null;
      // Resume with the exact spec the checkpoint was taken from so the VM
      // is configured identically (workspace mount, cwd, env, tcp, listen).
      // The SDK's VmCheckpoint.load() does not restore base options, so
      // this is ginger's job. Old checkpoints saved without a spec fall
      // back to a CLI-built one.
      spec = checkpoint?.spec
        ? { ...checkpoint.spec, checkpoint: checkpoint.path }
        : await buildSpec(opts);
      if (checkpoint && opts.name)
        spec.label = setLabelName(spec.label, opts.name);
      const step = new Step(
        checkpoint
          ? `Resuming VM from checkpoint ${checkpoint.name}`
          : "Starting VM session",
      );
      const owner = startOwner(spec);
      session = await waitForSession(spec.label, owner, step);
      step.succeed("session ready");
      console.log(`Session ID: ${session.id}\n`);

      // The owner enables access features (ingress gateway, SSH forwarder)
      // just after creating the VM and records each outcome; wait for them
      // so the user gets the same feedback the gondolin CLI prints (or a
      // loud failure).
      const wanted = [];
      if (spec.listen) wanted.push("ingress");
      if (spec.ssh) wanted.push("ssh");
      if (wanted.length > 0) {
        const access = await waitForAccess(session.id, owner, wanted);
        for (const key of wanted) {
          const info = access?.[key];
          if (!info || info.error)
            fail(
              `${key} setup failed${
                info?.error ? `: ${info.error}` : ""
              } — owner log: ${owner.logPath}`,
            );
        }
        if (access.ssh) console.error(`SSH enabled: ${access.ssh.command}`);
        if (access.ingress) {
          console.error(`Ingress enabled: ${access.ingress.url}`);
          console.error(
            "Configure routes by editing /etc/gondolin/listeners inside the VM.",
          );
        }
      }
    }
  }

  // Adopt the spec the session was actually started with when the owner
  // recorded one — attaching/exec then uses the right cwd/env without
  // re-supplying flags. (Freshly started sessions may not have it written
  // yet; the CLI-built spec above is identical in that case.)
  const savedSpec = readSessionSpec(session.id);
  if (savedSpec) spec = savedSpec;
  else if (!spec) spec = await buildSpec(opts);

  // --cwd/--env apply to this connection only: they override what the
  // session was started with without changing the VM itself.
  if (opts.cwd) spec.cwd = opts.cwd;
  if (opts.env.length > 0) spec.env = mergeEnv(spec.env ?? [], opts.env);

  // Claim this connection so the shutdown prompt below only fires when we
  // are the last ginger client on the session. (The owner process never
  // takes a lease — it runs via --owner and returns before this point.)
  // Release happens in the 'exit' handler registered by acquire().
  new ClientLease(session.id).acquire();

  const code = await interact(session, opts, spec);

  // Offer to shut the session down after an interactive attach — but only
  // if the session is still alive, no other ginger connection is attached,
  // and no lifecycle op (snap/stop) is in flight.
  if (!opts.execArgs && process.stdin.isTTY) {
    const s = await sdk.findSession(session.id).catch(() => null);
    if (!s || !s.alive) {
      // Our attach ended because the session itself went away (e.g. a
      // concurrent --snap/--stop) — nothing left to shut down.
    } else {
      const op = activeLifecycleOp(session.id);
      const others = ClientLease.liveOthers(session.id);
      if (op) {
        console.log(
          op === "snap"
            ? `Session ${session.id} is being snapshotted by another ginger client — leaving it to them.`
            : `Session ${session.id} is being shut down by another ginger client.`,
        );
      } else if (others > 0) {
        console.log(
          `Other ginger connections active (${others}) — leaving session ${session.id} running.`,
        );
      } else {
        const answer = (
          await ask("Shutdown VM? [y/N] ", process.stdout)
        ).toLowerCase();
        if (answer.startsWith("y")) {
          await shutdownSession(session);
        }
      }
    }
  }

  if (opts.rmi) await removeImages();

  process.exit(code);
}

main().catch((err) => fail(err?.message ?? String(err)));
