// Owner process (creates/resumes the VM and keeps it alive) plus the
// client-side lifecycle operations: shutdown, snapshot, interact.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { VERSION, checkpointDir, fail, logDir, sdk } from "./config.mjs";
import { makeVmOptions, parseListenSpec } from "./spec.mjs";
import { Step, isAlive, run, tail, waitFor } from "./ui.mjs";
import { writeCheckpointMeta } from "./checkpoints.mjs";
import {
  activeLifecycleOp,
  readSessionAccess,
  removeSessionLeases,
  startLifecycleOp,
  writeSessionAccess,
  writeSessionSpec,
} from "./sessions.mjs";

// ---------------------------------------------------------------------------
// Owner process — creates/resumes the VM and keeps it alive
// ---------------------------------------------------------------------------

export function startOwner(spec) {
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `owner-${Date.now()}.log`);
  const fd = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [process.argv[1], "--owner"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, GINGER_OWNER_SPEC: JSON.stringify(spec) },
  });
  child.unref();
  return { pid: child.pid, logPath };
}

export async function waitForSession(label, owner, step) {
  const start = Date.now();
  const deadline = start + 5 * 60_000;
  let hinted = false;
  while (Date.now() < deadline) {
    const log = fs.existsSync(owner.logPath) ? fs.readFileSync(owner.logPath, "utf8") : "";
    // Prefer the exact session id the owner logged. Labels are derived from
    // workspace + version, so a stale live session from an earlier run can
    // share this one's label — matching it would attach to the wrong VM and
    // leave flags like --listen silently unapplied.
    const idMatch = log.match(/GINGER_SESSION=(\S+)/);
    if (!isAlive(owner.pid)) {
      step.note(`VM owner process exited early — log: ${owner.logPath}`);
      for (const l of tail(log).split("\n")) step.note(l);
      step.fail("failed to start VM session");
      process.exit(1);
    }
    if (idMatch) {
      const s = await sdk.findSession(idMatch[1]).catch(() => null);
      if (s?.alive) return s;
      // The owner created a session that is not registered yet — keep
      // waiting for it instead of falling back to the label match.
    } else {
      const sessions = await sdk.listSessions().catch(() => []);
      const match = sessions.find((s) => s.alive && s.label === label);
      if (match) return match;
    }
    if (!hinted && Date.now() - start > 10_000) {
      step.note(`still starting — owner log at ${owner.logPath}`);
      hinted = true;
    }
    await waitFor(1000);
  }
  step.fail("timed out waiting for VM session to start");
  process.exit(1);
}

/**
 * Wait for the owner to record the access state (success or failure) of each
 * requested feature ("ingress", "ssh") for a freshly started session.
 * Returns the recorded entries, or null if the owner died or the timeout hit
 * first.
 */
export async function waitForAccess(sessionId, owner, keys) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const access = readSessionAccess(sessionId);
    if (access && keys.every((k) => access[k])) return access;
    if (!isAlive(owner.pid)) return access;
    await waitFor(500);
  }
  return readSessionAccess(sessionId);
}

/**
 * Enable the access features that only the process holding the VM's
 * controller connection can enable (SSH, ingress) and run the owner-side
 * guest setup (direnv allow). Both the CLI's owner process and pi's
 * in-process extension call this after create/resume: ingress listeners
 * are host-side (they die with their owner) and direnv's .direnv state is
 * a per-boot tmpfs shadow, so both must be re-applied on every resume.
 *
 * Each feature is best-effort; outcomes are recorded in the session access
 * state for clients to report. `log`/`error` let callers route output (the
 * pi process has no owner log file).
 */
export async function applyOwnerFeatures(
  vm,
  spec,
  { log = console.log, error = console.error } = {},
) {
  if (spec.ssh) {
    try {
      const access = await vm.enableSsh({
        user: spec.ssh.user,
        listenHost: spec.ssh.listen,
        listenPort: spec.ssh.port,
      });
      writeSessionAccess(vm.id, "ssh", {
        command: access.command,
        host: access.host,
        port: access.port,
        user: access.user,
      });
      log(`SSH enabled: ${access.command}`);
    } catch (err) {
      writeSessionAccess(vm.id, "ssh", { error: err?.message ?? String(err) });
      error(`ssh setup failed: ${err?.message ?? err}`);
    }
  }

  if (spec.listen) {
    try {
      // Older checkpoints may carry the pre-normalization string form.
      const listen = typeof spec.listen === "string" ? parseListenSpec(spec.listen) : spec.listen;
      const access = await vm.enableIngress({
        listenHost: listen.host,
        listenPort: listen.port,
        allowWebSockets: spec.disableWebSockets ? false : undefined,
      });
      writeSessionAccess(vm.id, "ingress", { url: access.url });
      log(`Ingress enabled: ${access.url}`);
    } catch (err) {
      writeSessionAccess(vm.id, "ingress", {
        error: err?.message ?? String(err),
      });
      error(`ingress setup failed: ${err?.message ?? err}`);
    }
  }

  if (spec.direnv && spec.cwd) {
    try {
      await vm.exec("direnv allow", { cwd: spec.cwd });
      log("direnv allowed");
    } catch (err) {
      error(`direnv allow failed: ${err.message}`);
    }
  }
}

export async function runOwner() {
  const spec = JSON.parse(process.env.GINGER_OWNER_SPEC ?? "");
  if (!spec?.label) fail("missing owner spec");
  const options = makeVmOptions(spec);

  let vm;
  if (spec.checkpoint) {
    console.log(`Resuming VM from checkpoint ${spec.checkpoint}`);
    vm = await sdk.VmCheckpoint.load(spec.checkpoint).resume(options);
  } else {
    console.log("Creating VM...");
    vm = await sdk.VM.create(options);
  }

  // Log the session id as early as possible — waitForSession matches on it.
  console.log(`GINGER_SESSION=${vm.id}`);

  // Record the exact spec this VM was started with so later clients
  // (attach/exec/snap) can describe the session without re-supplying flags.
  writeSessionSpec(vm.id, spec);

  // Graceful shutdown even if the owner itself is signalled.
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    process.on(sig, async () => {
      await vm.close().catch(() => {});
      process.exit(0);
    });
  }

  // Access features that only the owner can enable (it holds the sandbox
  // controller connection). The client cannot see this process's stdout, so
  // each outcome is recorded for it to report to the user.
  await applyOwnerFeatures(vm, spec);

  // Hold the session until the guest shuts down (lifecycle shutdown, crash).
  // Log any failure — a silent exit here used to leave only an empty owner
  // log and no clue why the VM went away.
  const hold = vm.exec(["/bin/sleep", "infinity"]);
  await hold.catch((err) => console.error(`hold ended: ${err?.message ?? err}`));
  await vm.close().catch((err) => console.error(`close failed: ${err?.message ?? err}`));
  console.log("owner exiting");
}

// ---------------------------------------------------------------------------
// Session lifecycle operations (client side)
// ---------------------------------------------------------------------------

/**
 * Graceful shutdown.
 *
 * The SDK only honours a `lifecycle`/`shutdown` message on the sandbox
 * controller's own IPC connection — i.e. the one held by the owner process
 * (the `vm` object from `VM.create`). Sending it over the session/attach socket
 * is explicitly rejected ("lifecycle actions are not supported over attach
 * IPC"), so we instead ask the owner to close the VM: its SIGTERM handler calls
 * `vm.close()`, which terminates qemu cleanly and unregisters the session.
 */
export async function shutdownSession(session) {
  const step = new Step(`Shutting down session ${session.id}`);
  const lifecycle = startLifecycleOp(session.id, "stop");
  try {
    await stopOwner(session, step);
  } finally {
    lifecycle.release();
  }
}

async function stopOwner(session, step) {
  if (session.pid && isAlive(session.pid)) {
    try {
      process.kill(session.pid, "SIGTERM");
    } catch (err) {
      console.error(`could not signal owner pid ${session.pid}: ${err.message}`);
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const s = await sdk.findSession(session.id).catch(() => null);
    if (!s || !s.alive) {
      step.succeed("session stopped");
      return;
    }
    await waitFor(500);
  }
  // Escalate: the owner is still alive, force-kill it so qemu goes with it.
  if (session.pid && isAlive(session.pid)) {
    step.note("graceful shutdown timed out — force-killing owner");
    try {
      process.kill(session.pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  step.succeed("session stopped");
  removeSessionLeases(session.id);
}

/**
 * Wait for the checkpoint file to appear after a snapshot request. The qcow
 * rebase+move can outlive the socket response by a long way on large disks,
 * so this polls with a generous deadline. If the owner process dies before
 * the file appears, fail after a grace period (the move runs in the owner) —
 * otherwise a crashed snapshot would hang for the full deadline.
 */
async function waitForCheckpoint(outPath, ownerId) {
  const deadline = Date.now() + 15 * 60_000;
  let ownerDiedAt = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(outPath)) return true;
    if (ownerId && !isAlive(ownerId)) {
      ownerDiedAt ??= Date.now();
      if (Date.now() - ownerDiedAt > 60_000) return false;
    } else {
      ownerDiedAt = null;
    }
    await waitFor(1000);
  }
  return false;
}

export async function snapshotSession(session, spec, snapLabel = null) {
  fs.mkdirSync(checkpointDir, { recursive: true });
  const name = `ginger-${VERSION.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}`;
  const outPath = path.join(checkpointDir, `${name}.qcow2`);
  const step = new Step(`Snapshotting session ${session.id}`);
  const lifecycle = startLifecycleOp(session.id, "snap");
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => (value) => {
        if (!settled) {
          settled = true;
          fn(value);
        }
      };
      const client = sdk.connectToSession(session.socketPath, {
        onJson: (msg) => {
          if (msg.type === "snapshot_response" && msg.id === 1) {
            client.close();
            settle(resolve)(msg);
          } else if (msg.type === "error" && msg.id === 1) {
            client.close();
            settle(reject)(new Error(`${msg.code}: ${msg.message}`));
          }
        },
        onBinary: () => {},
        onClose: async (err) => {
          // Snapshotting stops the VM, so the socket may close before the
          // response; fall back to observing the checkpoint file appear.
          if (settled) return;
          const ok = await waitForCheckpoint(outPath, session.pid);
          if (ok) settle(resolve)({ path: outPath, name });
          else
            settle(reject)(
              err ?? new Error("session closed before snapshot completed"),
            );
        },
      });
      client.send({ type: "snapshot", id: 1, path: outPath });
    });
  } catch (err) {
    step.note(err?.message ?? String(err));
    step.fail(`failed to snapshot session ${session.id}`);
    process.exit(1);
  }
  // The label drives later filtering/renaming; the saved spec's label is
  // what a resumed session gets, so both carry the final name.
  const label = snapLabel ?? session.label;
  const meta = {
    name: result.name ?? name,
    path: result.path ?? outPath,
    label,
    spec: { ...spec, label },
    createdAt: new Date().toISOString(),
  };
  try {
    writeCheckpointMeta(meta);
  } catch (err) {
    // A qcow without its sidecar is an orphan that ginger ls reports — say
    // so explicitly instead of letting the failure look like a bad snapshot.
    step.fail(`snapshot written but metadata failed (${err?.message ?? err}) — orphan at ${meta.path}`);
    process.exit(1);
  }
  step.succeed(`snapshot saved: ${meta.path}`);
  // Snapshotting stops the session; drop its lease dir as well.
  removeSessionLeases(session.id);
  lifecycle.release();
}

// ---------------------------------------------------------------------------
// Interaction (via the gondolin CLI for proper pty handling)
// ---------------------------------------------------------------------------

function envArgs(spec) {
  return spec.env.flatMap((e) => ["--env", e]);
}

export async function interact(session, opts, spec) {
  if (opts.execArgs) {
    if (opts.execArgs.length === 0) fail("--exec requires a command");
    const args = ["exec", "--sock", session.id, ...envArgs(spec)];
    if (spec.cwd) args.push("--cwd", spec.cwd);
    args.push("--", ...opts.execArgs);
    return await run("gondolin", args);
  }
  const args = ["attach", ...envArgs(spec)];
  if (spec.cwd) args.push("--cwd", spec.cwd);
  args.push(session.id);
  if (opts.pi) args.push("--", "direnv", "exec", ".", "/bin/pi");
  return await run("gondolin", args);
}
