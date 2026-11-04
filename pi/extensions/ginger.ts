/**
 * Ginger VM Tool Routing
 *
 * Runs pi's built-in tools inside a gondolin micro-VM managed by ginger. The
 * extension acts as the ginger session owner: it builds the session spec with
 * ginger's own code (so profiles, mounts, egress policy and host secrets
 * behave exactly like the `ginger` CLI), creates or resumes the VM in-process
 * (which keeps full vm.fs/vm.exec access for the tools below), and registers
 * the session so `ginger ls` shows it and other terminals can attach.
 *
 * Session lifecycle:
 *   - The host working directory is mounted at /workspace/<basename> in the
 *     guest (the same mount buildSpec computes), and the VM spec is derived
 *     from it (plus an optional project-local <cwd>/.pi/ginger.json profile
 *     file, read by ginger's buildSpec). Tools run in the spec's cwd
 *     (/workspace/<basename> by default, or the profile's `cwd`), matching
 *     what an attached ginger shell would see.
 *   - The session label carries pi=<root pi session id> and name=pi:<id> --
 *     <workspace>, where the root is the top of this session's fork tree
 *     (SessionHeader.parentSession links are paths; the extension walks them
 *     to the root). All sessions in a tree share ONE VM: forking does not
 *     snapshot or start a second VM — the child adopts the parent's running
 *     VM as-is. (pi re-invokes this factory on every session replacement,
 *     so the adopted-VM state lives at MODULE scope, not in the factory's
 *     closure — see the state block below.) Only new roots get fresh VMs,
 *     and only roots' snapshots are
 *     created/resumed, so `ginger ls` shows an informative display name (as
 *     if `ginger snap -n` had been used) and there is at most one snapshot
 *     per session tree. Sessions created by the `ginger` CLI (no pi=
 *     variable) are never touched.
 *   - On shutdown the VM is checkpointed into ginger's checkpoint directory
 *     with the same label, i.e. exactly what `ginger snap -n <name>` would
 *     produce — but only when the pi session records to a JSONL session file
 *     (in-memory sessions are closed without a snapshot). The checkpoint
 *     runs under a ginger lifecycle marker (heartbeat-refreshed) so
 *     concurrent `ginger` clients see "snap in progress" for the whole
 *     duration — including the slow qcow rebase after the VM has already
 *     closed and unregistered itself — and neither GC its session dir nor
 *     start a conflicting snap/stop. On real exit (quit/reload) the
 *     snapshot blocks until done and this session tree's earlier snapshots
 *     are removed; on session replacement (/new, resume-switch) it runs in
 *     the background so pi stays responsive — older snapshots are then
 *     cleaned up by the next startVm, which must not unlink files a still-
 *     running VM may use as its qcow2 backing file.
 *   - Owner-only access features from the spec (ingress via `listen`, ssh,
 *     and `direnv allow` in the guest) are applied after create AND resume,
 *     exactly as the ginger CLI's owner process does: ingress listeners are
 *     host-side so they die with their owner, and direnv's .direnv state is
 *     a per-boot tmpfs — both must be re-established on every start.
 *   - Tool commands run non-login (`bash -c`): a login shell would re-read
 *     /etc/profile, which unconditionally resets PATH and would clobber any
 *     injected environment. Instead the login-shell environment (profiles,
 *     profile.d, nix-profile PATH, locale) is captured ONCE at VM start and
 *     frozen, so each command sees exactly: login baseline + direnv env +
 *     pi session vars, with nothing re-evaluated per command.
 *   - With `direnv` enabled, the .envrc is additionally evaluated ONCE at VM
 *     start (`direnv exec . env -0`, like `ginger --pi` wraps pi itself) and
 *     the resulting environment is frozen and layered over the login baseline
 *     in every tool exec. Per-command `direnv exec` wrapping is deliberately
 *     avoided: direnv re-checks (and can re-evaluate a nix devshell — minutes
 *     of work) on every invocation whenever watched files change. While the
 *     start-time evaluation runs, a status line ticks with elapsed seconds so
 *     pi doesn't look stalled. The user can re-evaluate at will with
 *     /reload-direnv.
 *   - The ingress URL chosen for `listen: true` (ephemeral port) is surfaced
 *     in the start notification and the system-prompt cwd line, and recorded
 *     in ~/.cache/ginger/sessions/<id>/access.json.
 *   - pi (running on the host) references its config by HOST paths — notably
 *     skills under <host agent dir>/skills/… in the prompt. The guest keeps
 *     its own curated copy of that config at /etc/pi/agent (baked into the
 *     image; writable in-guest and snapshot-persisted, since gondolin does
 *     not save /root). The host agent dir is never mounted or exposed to the
 *     guest (it can hold credentials); instead file tools translate host
 *     agent-dir paths to /etc/pi/agent, and a symlink at the literal host
 *     path (created at VM start) makes those paths work in shell commands.
 *
 * Environment isolation:
 *   - Tool commands run in the guest with the VM's own environment (image
 *     defaults plus the spec's env: GINGER_VERSION, profile env from
 *     .pi/ginger.json, host secrets) — exactly what an attached ginger shell
 *     sees. The host process.env is NOT forwarded into the guest (pi builds
 *     the exec env as a copy of it, which would leak host secrets into the
 *     sandbox); only pi's own session variables (PI_SESSION_ID,
 *     PI_SESSION_FILE, PI_PROVIDER, PI_MODEL, PI_REASONING_LEVEL) are added,
 *     mirroring pi's native bash tool. Layered below those session vars:
 *     the frozen login-shell environment (always), and the frozen direnv
 *     environment when `direnv` is enabled (captured once at VM start,
 *     refreshed by /reload-direnv).
 *
 * Environment:
 *   - GINGER_PI_SNAPSHOT  Start this pi session's VM from an existing ginger
 *     snapshot instead of its own latest one. Value is a snapshot name (as
 *     shown by `ginger ls`) or an absolute path to the .qcow2/.json file.
 *   - GINGER_SRC          Directory containing ginger's src/*.mjs modules
 *     (development override; normally discovered via `ginger env`).
 *   - GINGER_VERSION      If set, pi is assumed to run INSIDE a ginger guest
 *     (e.g. `ginger --pi`) and this extension disables itself — the tools
 *     then operate on the local (guest) filesystem directly.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  type EditOperations,
  type FindOperations,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  truncateHead,
  truncateLine,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE_ROOT = "/workspace";
const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

// ---------------------------------------------------------------------------
// Ginger module loading
//
// The extension reuses ginger's spec/checkpoint/session code so VM creation
// matches the CLI exactly. ginger's modules are plain ESM in its src dir; we
// discover that dir (and the wrapper environment) via `ginger env`. The
// gondolin SDK itself is likewise imported by path (GONDOLIN_SDK), since pi's
// extension loader only aliases @earendil-works/pi-* packages.
// ---------------------------------------------------------------------------

// Structural types for the parts of the gondolin SDK we use (the SDK is
// loaded dynamically, so it has no static type surface here).
interface VmStat {
  size?: number;
  mtimeMs?: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface VmFs {
  readFile(path: string, opts?: { signal?: AbortSignal }): Promise<Buffer>;
  readFile(path: string, opts: { encoding: "utf8"; signal?: AbortSignal }): Promise<string>;
  writeFile(path: string, content: string | Buffer, opts?: { encoding?: string }): Promise<void>;
  access(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>;
  listDir(path: string, opts?: { signal?: AbortSignal }): Promise<string[]>;
  stat(path: string, opts?: { signal?: AbortSignal }): Promise<VmStat>;
}

interface VmExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface VmProc extends PromiseLike<VmExecResult> {
  output(): AsyncIterable<{ data: Buffer }>;
}

interface GondolinVM {
  id: string;
  fs: VmFs;
  exec(argv: string[], opts?: Record<string, unknown>): VmProc;
  checkpoint(checkpointPath: string): Promise<unknown>;
  close(): Promise<void>;
}

interface GondolinSdk {
  VM: { create(options: Record<string, unknown>): Promise<GondolinVM> };
  VmCheckpoint: {
    load(path: string): {
      resume(options: Record<string, unknown>): Promise<GondolinVM>;
    };
  };
}

interface GingerEnvInfo {
  srcDir: string;
  version: string;
  sdkPath: string;
  imageTar: string;
  buildConfig: string;
  defaultImage: string | null;
  vmm: string;
  cacheDir: string;
  checkpointDir: string;
  logDir: string;
}

interface GingerSpecModule {
  buildSpec(opts: Record<string, unknown>): Promise<Record<string, any>>;
  makeVmOptions(spec: Record<string, any>): Record<string, any>;
  makeLabel(parts: { ws?: string | null; name?: string | null; pi?: string | null }): string;
  parseLabel(label: string): {
    ws: string | null;
    name: string | null;
    pi: string | null;
  };
}

interface GingerCheckpointMeta {
  name: string;
  path: string;
  label?: string;
  spec?: Record<string, any>;
  createdAt: string;
}

interface GingerCheckpointsModule {
  listCheckpoints(): GingerCheckpointMeta[];
  matchCheckpoints(queries: string[]): GingerCheckpointMeta[];
  removeCheckpoints(checkpoints: GingerCheckpointMeta[]): void;
  writeCheckpointMeta(meta: GingerCheckpointMeta): void;
}

interface GingerSessionsModule {
  writeSessionSpec(sessionId: string, spec: Record<string, any>): void;
  readSessionAccess(sessionId: string): Record<string, any> | null;
  /**
   * Claim the session for a long-running lifecycle op ("snap"/"stop") with
   * heartbeat refresh; returns { release() }. Other ginger clients see the
   * op via activeLifecycleOp() and leave the session alone.
   */
  startLifecycleOp?(sessionId: string, op: string): { release(): void };
  /** "snap"/"stop" if another live client is mid-op on the session, else null. */
  activeLifecycleOp?(sessionId: string): string | null;
}

interface GingerOwnerModule {
  applyOwnerFeatures(
    vm: GondolinVM,
    spec: Record<string, any>,
    hooks?: { log?: (msg: string) => void; error?: (msg: string) => void },
  ): Promise<void>;
}

interface GingerModules {
  spec: GingerSpecModule;
  checkpoints: GingerCheckpointsModule;
  sessions: GingerSessionsModule;
  owner: GingerOwnerModule;
  sdk: GondolinSdk;
  /** Wrapper environment (version etc.); null in GINGER_SRC dev mode. */
  envInfo: GingerEnvInfo | null;
}

function runGingerCli(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = process.env.GINGER_BIN?.trim() || "ginger";
    let settled = false;
    const finish = (value: string | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(null);
    }, 30_000);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : null);
    });
  });
}

/**
 * Run a ginger function that may call its fail() helper, which prints to
 * stderr and process.exit(1). In the pi process an exit would kill the agent,
 * so temporarily turn exit into a thrown error and capture the message.
 */
function gingerCall<T>(fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const origExit = process.exit;
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    const restore = () => {
      process.exit = origExit;
      process.stderr.write = origWrite;
    };
    process.exit = ((code?: number) => {
      const detail = captured.trim();
      throw new Error(detail ? `ginger: ${detail}` : `ginger exited with code ${code ?? 0}`);
    }) as typeof process.exit;
    process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
      captured += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          restore();
          resolve(value);
        },
        (err) => {
          restore();
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
  });
}

let gingerPromise: Promise<GingerModules | null> | undefined;

async function loadGinger(): Promise<GingerModules | null> {
  if (!gingerPromise) gingerPromise = doLoadGinger();
  return gingerPromise;
}

async function doLoadGinger(): Promise<GingerModules | null> {
  // Whether the caller already had GINGER_VERSION (dev shell); we must not
  // remove a pre-existing value.
  const hadVersion = Boolean(process.env.GINGER_VERSION);
  let envInfo: GingerEnvInfo | null = null;
  let srcDir = process.env.GINGER_SRC?.trim() ?? "";
  if (!srcDir) {
    const out = await runGingerCli(["env"]);
    if (!out) return null;
    try {
      envInfo = JSON.parse(out) as GingerEnvInfo;
    } catch {
      return null;
    }
    srcDir = envInfo.srcDir;
    // Apply the ginger wrapper's environment (only where not already set) so
    // ginger's config.mjs sees the same version/SDK/image as the CLI.
    const apply: Record<string, string | undefined> = {
      GINGER_VERSION: envInfo.version,
      GONDOLIN_SDK: envInfo.sdkPath,
      GINGER_IMAGE_TAR: envInfo.imageTar,
      GINGER_BUILD_CONFIG: envInfo.buildConfig,
      GONDOLIN_DEFAULT_IMAGE: envInfo.defaultImage ?? undefined,
      GONDOLIN_VMM: envInfo.vmm,
    };
    for (const [key, value] of Object.entries(apply)) {
      if (value && !process.env[key]) process.env[key] = value;
    }
  }
  if (!process.env.GINGER_VERSION || !process.env.GONDOLIN_SDK) return null;
  const base = pathToFileURL(srcDir.endsWith("/") ? srcDir : `${srcDir}/`).href;
  // GINGER_VERSION is only needed while ginger's modules load (they capture
  // it at import time). Remove it again afterwards so host-side child
  // processes and other extensions don't mistake this pi process for a
  // ginger guest.
  try {
    const [spec, checkpoints, sessions, owner, sdk] = await Promise.all([
      import(`${base}spec.mjs`),
      import(`${base}checkpoints.mjs`),
      import(`${base}sessions.mjs`),
      import(`${base}owner.mjs`),
      import(pathToFileURL(process.env.GONDOLIN_SDK).href),
    ]);
    if (!sdk.VM || !sdk.VmCheckpoint) return null;
    return {
      spec,
      checkpoints,
      sessions,
      owner: owner as GingerOwnerModule,
      sdk: sdk as GondolinSdk,
      envInfo,
    };
  } catch {
    return null;
  } finally {
    if (!hadVersion) delete process.env.GINGER_VERSION;
  }
}

/** Resolve a GINGER_PI_SNAPSHOT value to checkpoint metadata. */
function resolveSnapshot(g: GingerModules, value: string): GingerCheckpointMeta {
  if (path.isAbsolute(value)) {
    const qcow = value.endsWith(".qcow2")
      ? value
      : value.endsWith(".json")
        ? `${value.slice(0, -".json".length)}.qcow2`
        : null;
    if (!qcow) throw new Error(`GINGER_PI_SNAPSHOT path must end in .qcow2 or .json: ${value}`);
    const metaPath = `${qcow}.json`;
    if (!fs.existsSync(metaPath))
      throw new Error(`no checkpoint metadata for ${qcow} (expected ${metaPath})`);
    return {
      ...(JSON.parse(fs.readFileSync(metaPath, "utf8")) as GingerCheckpointMeta),
      path: qcow,
    };
  }
  const matches = g.checkpoints.matchCheckpoints([value]);
  return matches[0];
}

// ---------------------------------------------------------------------------
// Pi session tree (fork lineage)
// ---------------------------------------------------------------------------

/** Read just the first JSON line (the header) of a pi session file. */
function readSessionHeader(file: string): Record<string, any> | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
      if (!firstLine) return null;
      return JSON.parse(firstLine) as Record<string, any>;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Walk the fork lineage up to the root of this pi session's tree. Each
 * SessionHeader.parentSession is a PATH to the parent session file; the root
 * has none. All sessions in a tree share one VM (forks adopt their parent's
 * running VM), so snapshots are keyed by the ROOT id: only new roots create
 * fresh VMs, and only a root's snapshot is resumed for any member of the
 * tree. Falls back to the session's own id when the chain can't be resolved
 * (degrading to per-session behavior rather than failing to start).
 */
function findRootSessionId(ctx: ExtensionContext, fallbackId: string): string {
  let header: Record<string, any> | null = null;
  try {
    const h = ctx.sessionManager.getHeader?.();
    if (h && typeof h.id === "string") header = h as unknown as Record<string, any>;
  } catch {
    header = null;
  }
  if (!header) {
    const file = ctx.sessionManager.getSessionFile?.();
    if (typeof file === "string") header = readSessionHeader(file);
  }
  if (!header || typeof header.id !== "string") return fallbackId;
  let id: string = header.id;
  let parentPath = typeof header.parentSession === "string" ? header.parentSession : undefined;
  const seen = new Set<string>();
  while (parentPath && !seen.has(parentPath)) {
    seen.add(parentPath);
    const h = readSessionHeader(parentPath);
    if (!h) break;
    if (typeof h.id === "string") id = h.id;
    parentPath = typeof h.parentSession === "string" ? h.parentSession : undefined;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Guest path mapping (host cwd is mounted at paths.root; tools run in
// paths.cwd, which mirrors the VM spec's cwd)
// ---------------------------------------------------------------------------

interface GuestPaths {
  /** Host working directory pi was started in. */
  localCwd: string;
  /** Guest mount point of localCwd (e.g. /workspace/my-project). */
  root: string;
  /** Guest cwd the tools operate in (spec.cwd, defaults to root). */
  cwd: string;
}

/**
 * pi runs on the host and discovers its config (skills, prompts, …) under
 * the host agent dir — so its prompt references absolute paths like
 * /Users/<you>/.pi/agent/skills/<name>/SKILL.md. The guest has its own
 * curated copy of that config at /etc/pi/agent: baked into the image (the
 * host dir is NEVER exposed to the guest — it can hold credentials),
 * writable in-guest, and under /etc because gondolin snapshots do not
 * persist /root. File tools translate host agent-dir paths to that guest
 * path (toGuestPath); a symlink created at VM start makes literal host
 * paths work in shell commands too.
 */
const HOST_PI_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
const GUEST_PI_AGENT_DIR = "/etc/pi/agent";

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function toGuestPath(paths: GuestPaths, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return paths.cwd;
  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(paths.localCwd, trimmed)) {
      const relativePath = path.relative(paths.localCwd, trimmed);
      return relativePath ? path.posix.join(paths.root, toPosix(relativePath)) : paths.root;
    }
    // Host pi agent dir -> the guest-local curated copy (skills etc.). The
    // host dir itself is never mounted or exposed.
    if (isInsideHostPath(HOST_PI_AGENT_DIR, trimmed)) {
      const relativePath = path.relative(HOST_PI_AGENT_DIR, trimmed);
      return relativePath
        ? path.posix.join(GUEST_PI_AGENT_DIR, toPosix(relativePath))
        : GUEST_PI_AGENT_DIR;
    }
    // Absolute guest path (or outside the workspace) — pass through.
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(paths.cwd, toPosix(trimmed));
}

// ---------------------------------------------------------------------------
// Tool operations over the VM (vm.fs / vm.exec)
// ---------------------------------------------------------------------------

function createGondolinReadOps(vm: GondolinVM, paths: GuestPaths): ReadOperations {
  return {
    readFile: async (filePath) => vm.fs.readFile(toGuestPath(paths, filePath)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(paths, filePath));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix.extname(toGuestPath(paths, filePath)).toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

function createGondolinWriteOps(vm: GondolinVM, paths: GuestPaths): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(toGuestPath(paths, filePath), content, {
        encoding: "utf8",
      });
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(toGuestPath(paths, dirPath), { recursive: true });
    },
  };
}

function createGondolinEditOps(vm: GondolinVM, paths: GuestPaths): EditOperations {
  const readOps = createGondolinReadOps(vm, paths);
  const writeOps = createGondolinWriteOps(vm, paths);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

function createGondolinLsOps(vm: GondolinVM, paths: GuestPaths): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(paths, filePath));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => vm.fs.stat(toGuestPath(paths, filePath)),
    readdir: async (dirPath) => vm.fs.listDir(toGuestPath(paths, dirPath)),
  };
}

async function walkGuestFiles(
  vm: GondolinVM,
  root: string,
  visit: (guestPath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const stat = await vm.fs.stat(root, { signal });
  if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

  const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const entries = await vm.fs.listDir(dir, { signal });
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
      let entryStat: VmStat;
      try {
        entryStat = await vm.fs.stat(guestPath, { signal });
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!(await walkDirectory(guestPath, relativePath))) return false;
      } else if (!(await visit(guestPath, relativePath))) {
        return false;
      }
    }
    return true;
  };

  return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosix(pattern);
  if (normalizedPattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalizedPattern) ||
      path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: GondolinVM, paths: GuestPaths): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(paths, filePath));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = toGuestPath(paths, cwd);
      const results: string[] = [];
      await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
        if (results.length >= options.limit) return false;
        if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
        return results.length < options.limit;
      });
      return results;
    },
  };
}

function createLineMatcher(
  pattern: string,
  literal: boolean | undefined,
  ignoreCase: boolean | undefined,
) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
  outputLines: string[];
  lines: string[];
  relativePath: string;
  lineIndex: number;
  contextLines: number;
}): boolean {
  let linesTruncated = false;
  const start =
    params.contextLines > 0
      ? Math.max(0, params.lineIndex - params.contextLines)
      : params.lineIndex;
  const end =
    params.contextLines > 0
      ? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
      : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
  }
  return linesTruncated;
}

async function executeGondolinGrep(
  vm: GondolinVM,
  paths: GuestPaths,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
  const root = toGuestPath(paths, params.path ?? ".");
  const rootStat = await vm.fs.stat(root, { signal });
  const rootIsDirectory = rootStat.isDirectory();
  const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
  const contextLines = params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
  const outputLines: string[] = [];
  const details: GrepToolDetails = {};
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  await walkGuestFiles(
    vm,
    root,
    async (guestPath, relativePath) => {
      if (matchCount >= effectiveLimit) return false;
      if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
      let content: string;
      try {
        content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
      } catch {
        return true;
      }
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
      for (let index = 0; index < lines.length; index++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        if (
          appendGrepBlock({
            outputLines,
            lines,
            relativePath: displayPath,
            lineIndex: index,
            contextLines,
          })
        ) {
          linesTruncated = true;
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    },
    signal,
  );

  if (matchCount === 0)
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    };

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const notices: string[] = [];
  let output = truncation.content;

  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

/**
 * The only host-side variables forwarded into the guest: pi's own session
 * variables, built the same way pi's native bash tool does (see
 * resolveSpawnContext). Everything else the guest gets comes from the VM
 * itself (image defaults + spec env), matching an attached ginger shell.
 */
function piSessionVars(ctx: ExtensionContext | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!ctx) return vars;
  try {
    vars.PI_SESSION_ID = String(ctx.sessionManager.getSessionId());
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) vars.PI_SESSION_FILE = sessionFile;
    if (ctx.model) {
      vars.PI_PROVIDER = ctx.model.provider;
      vars.PI_MODEL = ctx.model.id;
    }
    if (ctx.thinkingLevel) vars.PI_REASONING_LEVEL = ctx.thinkingLevel;
  } catch {
    // best effort — a missing var is fine
  }
  return vars;
}

/**
 * Parse a base64-encoded NUL-separated `env -0` dump into a plain map.
 * Volatile vars that are meaningless outside their original shell (`_`)
 * are dropped.
 */
function parseEnvDump(stdout: string): Record<string, string> {
  const raw = Buffer.from(stdout.replace(/\s/g, ""), "base64").toString("utf8");
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (name === "_") continue;
    env[name] = entry.slice(eq + 1);
  }
  return env;
}

/** Run a command in the guest whose stdout is an env dump, and parse it. */
async function captureEnvDump(
  vm: GondolinVM,
  argv: string[],
  cwd: string | undefined,
  what: string,
): Promise<Record<string, string>> {
  // Default (buffer) output mode: the resolved result carries stdout.
  // `stdout: "pipe"` would stream chunks to .output() only and leave
  // result.stdout empty — silently producing an empty environment.
  const result = await vm.exec(argv, cwd ? { cwd } : {});
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `${what} exited ${result.exitCode}`);
  if (!result.stdout) throw new Error(`${what} produced no output`);
  return parseEnvDump(result.stdout);
}

/**
 * Evaluate the guest .envrc exactly once and return the resulting
 * environment. `direnv exec` re-checks for changes on every invocation —
 * in a nix devshell repo that can mean a multi-minute re-evaluation per
 * command — so we never wrap individual commands in it. Instead this dumps
 * the activated environment (NUL-separated, base64 to survive string
 * stdout) and parses it into a plain map that callers inject via the exec
 * env.
 */
async function captureDirenvEnv(vm: GondolinVM, cwd: string): Promise<Record<string, string>> {
  return captureEnvDump(
    vm,
    ["direnv", "exec", ".", "/bin/sh", "-c", "env -0 | base64"],
    cwd,
    "direnv exec",
  );
}

/**
 * Capture the guest's LOGIN-shell environment once (what an attached shell
 * sees: /etc/profile, /etc/profile.d/nix.sh, locale, nix-profile PATH…).
 * Tool commands run non-login (`bash -c`) so their environment is exactly
 * what we inject — a login shell would re-read /etc/profile and clobber the
 * injected PATH (it unconditionally resets it). This capture is cheap:
 * sourcing profiles never triggers a nix evaluation.
 */
async function captureLoginEnv(vm: GondolinVM, shellPath: string): Promise<Record<string, string>> {
  return captureEnvDump(vm, [shellPath, "-lc", "env -0 | base64"], undefined, "login env capture");
}

function createGondolinBashOps(
  vm: GondolinVM,
  paths: GuestPaths,
  shellPath: string,
  piEnv: Record<string, string>,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = toGuestPath(paths, cwd);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeout * 1000)
          : undefined;

      try {
        // Non-login, non-interactive: reads no startup files, so the
        // injected environment (login baseline + frozen direnv env + pi
        // session vars) is exactly what the command sees. A login shell
        // would re-run /etc/profile, which unconditionally resets PATH and
        // would wipe the devshell.
        const proc = vm.exec([shellPath, "-c", command], {
          cwd: guestCwd,
          // Never forward pi's exec env (a copy of the host process.env).
          env: Object.keys(piEnv).length > 0 ? piEnv : undefined,
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of proc.output()) onData(chunk.data);
        const result = await proc;
        return { exitCode: result.exitCode };
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// VM state — module scope, deliberately NOT factory scope
//
// pi re-invokes this extension's factory on every session replacement
// (/new, /fork, resume-switch): each gets a fresh runtime and therefore a
// fresh closure. The loaded module, however, is shared across those
// invocations (pi caches the factory per cwd; only /reload re-imports it,
// and reload stops the VM with a blocking snapshot first anyway). Keeping
// the VM state here — instead of in the factory's closure — is what lets a
// forked session ADOPT the parent's running VM: the outgoing instance's
// session_shutdown("fork") leaves the state in place, and the incoming
// instance's session_start("fork") finds it and attaches to the same VM.
// One pi process runs one session at a time, so one module-level VM is
// exactly the right shape.
// ---------------------------------------------------------------------------

let vm: GondolinVM | undefined;
let vmStarting: Promise<GondolinVM> | undefined;
let vmSpec: Record<string, any> | undefined;
/** Ingress URL if the spec enabled `listen` (from the session access state). */
let vmIngressUrl: string | undefined;
/** Guest cwd for tools: the spec's cwd (refined by startVm once known). */
let guestCwd = "";
/**
 * Frozen direnv environment (spec.direnv): captured once at VM start by
 * evaluating the .envrc, injected into every tool exec. Refreshed by
 * /reload-direnv. Undefined when direnv is off or capture failed.
 */
let direnvEnv: Record<string, string> | undefined;
/**
 * Login-shell environment captured once at VM start (profile, profile.d,
 * nix-profile PATH, locale…). Layered under the direnv env and pi session
 * vars in every tool exec, since commands run non-login (`bash -c`).
 */
let loginEnv: Record<string, string> | undefined;
let vmPiId: string | undefined;
let vmOrigin: "fresh" | "resumed" | "seeded" | undefined;
let shuttingDown = false;
// Bumped on every session transition (start, non-fork shutdown). A startVm
// that began for an earlier session must not adopt its VM into a newer
// one — it compares the generation it captured at entry.
let generation = 0;
let shellPath = "/bin/sh";

export default function (pi: ExtensionAPI) {
  // Inside a ginger guest (e.g. `ginger --pi`) the tools should run locally —
  // ginger seeds GINGER_VERSION into every guest environment.
  if (process.env.GINGER_VERSION) return;

  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localLs = createLsTool(localCwd);

  // The host cwd is mounted at /workspace/<basename> (buildSpec's mount),
  // and the tools run in the spec's cwd, which defaults to that mount but a
  // project profile (.pi/ginger.json) can override with `cwd`.
  const guestWorkspace = path.posix.join(GUEST_WORKSPACE_ROOT, path.basename(localCwd));
  // Module-scope VM state (see above): reset the cwd default for this
  // instance; startVm refines it from the spec once one is running.
  guestCwd = guestWorkspace;

  const guestPaths = (): GuestPaths => ({
    localCwd,
    root: guestWorkspace,
    cwd: guestCwd,
  });

  /** Standard status-line text for a running VM. */
  const vmStatusLabel = (id: string) =>
    `Ginger: ${id.slice(0, 8)} (${vmOrigin ?? "unknown"}, ${guestCwd})`;

  function checkpointDir(): string {
    return path.join(
      process.env.GINGER_CACHE_DIR?.trim() || path.join(os.homedir(), ".cache", "ginger"),
      "checkpoints",
    );
  }

  async function startVm(ctx?: ExtensionContext): Promise<GondolinVM> {
    const myGeneration = generation;
    // Capture everything we need from ctx NOW, while it is active: pi
    // invalidates a session's ctx when the session is replaced (every
    // property access on it then THROWS), and this function outlives such
    // replacements — VM boot + direnv evaluation can take minutes. The ui
    // object itself is app-level (the TUI) and stays valid for the process;
    // the session identity must be read before the first await.
    const ui = ctx?.ui;
    if (ui) ui.setStatus("ginger", ui.theme.fg("accent", `Ginger: starting VM for ${localCwd}`));
    // Key snapshots by the ROOT of this session's fork tree (see
    // findRootSessionId): every member of the tree shares one VM, so they
    // share one snapshot chain too.
    const piId = ctx
      ? findRootSessionId(ctx, String(ctx.sessionManager.getSessionId()))
      : `pid-${process.pid}`;
    const g = await loadGinger();
    if (!g)
      throw new Error(
        "ginger not found (no `ginger` on PATH and no GINGER_SRC set) — cannot start the VM; tools will fail until ginger is installed",
      );
    const wsPath = localCwd;
    // Display name for this session's snapshots (label name=), shown by
    // `ginger ls` and used for matching — as if `ginger snap -n <name>` had
    // been used.
    const snapName = `pi:${piId} -- ${path.basename(wsPath)}`;

    // Resolve the spec for this pi session:
    //   1. GINGER_PI_SNAPSHOT — seed a fresh session from an existing snapshot
    //   2. latest checkpoint labeled pi=<this pi session id> — resume it
    //   3. otherwise build a new spec (workspace + optional .pi/ginger.json)
    let spec: Record<string, any>;
    let origin: "fresh" | "resumed" | "seeded";
    const seed = process.env.GINGER_PI_SNAPSHOT?.trim();
    if (seed) {
      const meta = await gingerCall(() => resolveSnapshot(g, seed));
      spec = meta.spec
        ? { ...meta.spec }
        : await gingerCall(() => g.spec.buildSpec({ workspace: wsPath }));
      spec.checkpoint = meta.path;
      const prev = g.spec.parseLabel(meta.label ?? "");
      spec.label = g.spec.makeLabel({
        ws: prev.ws ?? wsPath,
        name: snapName,
        pi: piId,
      });
      origin = "seeded";
    } else {
      const mine = await gingerCall(() =>
        g.checkpoints.listCheckpoints().filter((m) => g.spec.parseLabel(m.label ?? "").pi === piId),
      );
      if (mine.length > 0) {
        // listCheckpoints() is newest-first.
        const cp = mine[0];
        spec = cp.spec
          ? { ...cp.spec, checkpoint: cp.path }
          : await gingerCall(() =>
              g.spec.buildSpec({
                workspace: wsPath,
                piSession: piId,
                name: snapName,
              }),
            );
        // Refresh the display name (older snapshots may predate it) while
        // keeping the recorded workspace.
        const prev = g.spec.parseLabel(spec.label);
        spec.label = g.spec.makeLabel({
          ws: prev.ws ?? wsPath,
          name: snapName,
          pi: piId,
        });
        origin = "resumed";
        if (mine.length > 1) {
          // One snapshot per session tree: the older ones are redundant now.
          // Drop them BEFORE booting — once the new VM is up, an older file
          // could in principle still be another running VM's qcow2 backing
          // file (a concurrent pi process resuming it), and unlinking that
          // mid-flight would corrupt it. Background snapshots deliberately
          // never delete; this pre-boot pass is the tree's cleanup point.
          await gingerCall(() => g.checkpoints.removeCheckpoints(mine.slice(1))).catch(
            (err) =>
              ui?.notify(
                `Ginger: could not remove old snapshots: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              ),
          );
        }
      } else {
        spec = await gingerCall(() =>
          g.spec.buildSpec({ workspace: wsPath, piSession: piId, name: snapName }),
        );
        origin = "fresh";
      }
    }

    const options = await gingerCall(() => g.spec.makeVmOptions(spec));
    const created = spec.checkpoint
      ? await g.sdk.VmCheckpoint.load(spec.checkpoint).resume(options)
      : await g.sdk.VM.create(options);

    // A session transition may have raced with the (slow) VM creation —
    // don't leak this session's VM into the next one.
    if (shuttingDown || generation !== myGeneration) {
      await created.close().catch(() => {});
      throw new Error("pi session changed while the VM was starting");
    }

    // Apply the owner-only access features (ingress, ssh) and guest setup
    // (direnv allow) that the ginger CLI's owner process runs after
    // create/resume — we hold the same controller connection. This must
    // happen on every resume too: ingress listeners are host-side (they die
    // with their owner) and direnv's .direnv state is a per-boot tmpfs.
    // Best effort: a failing feature is reported but doesn't sink the VM.
    await gingerCall(() =>
      g.owner.applyOwnerFeatures(created, spec, {
        log: (msg) => ui?.notify(`Ginger: ${msg}`, "info"),
        error: (msg) => ui?.notify(`Ginger: ${msg}`, "error"),
      }),
    ).catch((err) => {
      ui?.notify(
        `Ginger: access feature setup failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    });

    // The ingress URL (when `listen` is enabled) was recorded in the session
    // access state by applyOwnerFeatures; capture it for the notifications
    // and the system-prompt line below.
    try {
      const access = g.sessions.readSessionAccess(created.id);
      vmIngressUrl = typeof access?.ingress?.url === "string" ? access.ingress.url : undefined;
    } catch {
      vmIngressUrl = undefined;
    }

    vm = created;
    vmSpec = spec;
    vmPiId = piId;
    vmOrigin = origin;
    guestCwd = typeof spec.cwd === "string" && spec.cwd ? spec.cwd : guestWorkspace;

    // Register the session (spec sidecar) so `ginger ls` shows it and other
    // ginger clients can attach/exec against it. Best effort: a missing
    // sidecar only degrades `ginger`'s descriptions, not the VM itself.
    try {
      await gingerCall(() => g.sessions.writeSessionSpec(created.id, spec));
    } catch (err) {
      ui?.notify(
        `Ginger: could not register session spec: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
    const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
    shellPath = bashProbe.stdout.trim() || "/bin/sh";

    // Literal host agent-dir paths (e.g. a skill path copied from the prompt
    // into a shell command) should work in-guest too: alias the host path to
    // the guest-local /etc/pi/agent. The symlink exposes no host content —
    // it points only at the image-baked, snapshot-persisted copy. File tools
    // translate paths themselves (toGuestPath), so this is a shell-command
    // convenience; best effort either way.
    try {
      await created.exec(["mkdir", "-p", path.posix.dirname(HOST_PI_AGENT_DIR)]);
      await created.exec(["ln", "-sfn", GUEST_PI_AGENT_DIR, HOST_PI_AGENT_DIR]);
    } catch (err) {
      ui?.notify(
        `Ginger: could not alias ${HOST_PI_AGENT_DIR} in the guest: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }

    // Capture the login-shell environment once (profiles, profile.d,
    // nix-profile PATH, locale…). Tool commands run non-login (`bash -c`)
    // so their env is exactly what we inject; without this baseline they
    // would lose everything /etc/profile provides. Sourcing profiles never
    // triggers a nix evaluation, so this is fast.
    try {
      loginEnv = await gingerCall(() => captureLoginEnv(created, shellPath));
    } catch (err) {
      loginEnv = undefined;
      ui?.notify(
        `Ginger: login env capture failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }

    // With spec.direnv, evaluate the .envrc once now (this is where the
    // possibly-slow nix devshell evaluation happens — at session start, like
    // `ginger --pi`, not per command) and freeze the resulting environment
    // for all tool execs. Best effort: on failure tools run with the plain
    // VM environment.
    if (spec.direnv) {
      // The .envrc evaluation (a nix devshell in particular) can take
      // minutes. Make it visible: an up-front notification plus a status
      // line that ticks with elapsed seconds, so pi doesn't look stalled.
      const evalStartedAt = Date.now();
      const showEvalStatus = () => {
        if (!ui) return;
        const secs = Math.round((Date.now() - evalStartedAt) / 1000);
        ui.setStatus(
          "ginger",
          ui.theme.fg("muted", `Ginger: evaluating .envrc (direnv/nix)… ${secs}s`),
        );
      };
      ui?.notify(
        "Ginger: evaluating direnv environment (.envrc) — nix devshells can take a while",
        "info",
      );
      showEvalStatus();
      const evalTick = setInterval(showEvalStatus, 1000);
      try {
        direnvEnv = await gingerCall(() => captureDirenvEnv(created, guestCwd));
        ui?.notify(
          `Ginger: direnv environment loaded (${Object.keys(direnvEnv).length} vars) after ${Math.round((Date.now() - evalStartedAt) / 1000)}s; /reload-direnv to re-evaluate`,
          "info",
        );
      } catch (err) {
        direnvEnv = undefined;
        ui?.notify(
          `Ginger: direnv env capture failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        clearInterval(evalTick);
      }
    }

    if (ui) {
      ui.setStatus("ginger", ui.theme.fg("accent", vmStatusLabel(created.id)));
      ui.notify(
        `Ginger VM ${origin === "fresh" ? "started" : origin === "resumed" ? "resumed from snapshot" : "started from GINGER_PI_SNAPSHOT"}. ${localCwd} is mounted at ${guestWorkspace}; tools run in ${guestCwd}.${vmIngressUrl ? ` Ingress: ${vmIngressUrl}` : ""}`,
        "info",
      );
    }
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<GondolinVM> {
    if (vm) return vm;
    if (!vmStarting) {
      vmStarting = startVm(ctx).finally(() => {
        vmStarting = undefined;
      });
    }
    return vmStarting;
  }

  /**
   * Checkpoint the VM into ginger's checkpoint directory (the same layout as
   * `ginger snap`: qcow2 + 0600 JSON sidecar). Runs under a heartbeat
   * lifecycle marker so concurrent ginger clients see "snap in progress" for
   * the whole duration — including the slow qcow rebase+move, by which time
   * the VM is already closed and unregistered from every registry. With
   * blocking=true the caller awaits this (real exit: pi stops right after);
   * otherwise it runs fire-and-forget and reports via notifications only.
   */
  async function snapshotVm(opts: {
    // The CAPTURED ui object (ctx.ui read while the ctx was still active),
    // never the ctx itself: in background mode this runs long after pi has
    // replaced the session, and every property access on a stale ctx throws.
    ui: ExtensionContext["ui"];
    vm: GondolinVM;
    spec: Record<string, any>;
    piId: string | undefined;
    blocking: boolean;
  }): Promise<void> {
    const { ui, vm: activeVm, spec: activeSpec, piId: activePiId, blocking } = opts;
    const g = await loadGinger();
    if (!g || !activeSpec) {
      try {
        await activeVm.close();
      } catch {
        // best effort
      }
      if (blocking) ui.setStatus("ginger", undefined);
      return;
    }
    // Another ginger client (CLI snap/stop) may already own this session —
    // don't double-checkpoint a VM it is about to stop.
    try {
      const busy = await gingerCall(() => g.sessions.activeLifecycleOp?.(activeVm.id) ?? null);
      if (busy) {
        ui.notify(
          `Ginger: session ${activeVm.id.slice(0, 8)} is already being ${busy} by another client — skipping snapshot`,
          "info",
        );
        try {
          await activeVm.close();
        } catch {
          // best effort
        }
        if (blocking) ui.setStatus("ginger", undefined);
        return;
      }
    } catch {
      // marker check is best effort — proceed
    }
    const startedAt = Date.now();
    if (blocking)
      ui.setStatus("ginger", ui.theme.fg("muted", "Ginger: snapshotting"));
    try {
      // Claim the session BEFORE touching the VM. During the slow rebase the
      // VM is already gone from every registry, so without this marker a
      // concurrent `ginger ls` would GC the session's sidecar dir (spec.json
      // & co.) mid-snapshot, and a CLI snap/stop could race us on the same
      // VM. The heartbeat keeps the marker fresh for minutes-long snapshots.
      const lifecycle = g.sessions.startLifecycleOp
        ? await gingerCall(() => g.sessions.startLifecycleOp!(activeVm.id, "snap"))
        : { release() {} };
      try {
        const version = g.envInfo?.version ?? process.env.GINGER_VERSION ?? "dev";
        const name = `ginger-${String(version).replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}`;
        const dir = checkpointDir();
        fs.mkdirSync(dir, { recursive: true });
        const outPath = path.join(dir, `${name}.qcow2`);
        await activeVm.checkpoint(outPath);
        // The qcow must be on disk before its sidecar is written — the
        // reverse order (or a crash between the two) leaves an orphan that
        // `ginger ls` can neither show nor resume.
        if (!fs.existsSync(outPath))
          throw new Error(`checkpoint file missing after checkpoint(): ${outPath}`);
        g.checkpoints.writeCheckpointMeta({
          name,
          path: outPath,
          label: activeSpec.label,
          spec: activeSpec,
          createdAt: new Date().toISOString(),
        });
        if (activePiId && blocking) {
          // One snapshot per session tree, deleted only when we are the last
          // word: on real exit no VM of this process is left that could be
          // using an older file as its qcow2 backing. Background mode leaves
          // cleanup to the next startVm (which deletes pre-boot).
          const stale = await gingerCall(() =>
            g.checkpoints
              .listCheckpoints()
              .filter(
                (m) => g.spec.parseLabel(m.label ?? "").pi === activePiId && m.path !== outPath,
              ),
          );
          if (stale.length > 0) await gingerCall(() => g.checkpoints.removeCheckpoints(stale));
        }
        const secs = Math.round((Date.now() - startedAt) / 1000);
        ui.notify(`Ginger VM snapshot saved: ${outPath} (${secs}s)`, "info");
      } finally {
        lifecycle.release();
      }
    } catch (err) {
      ui.notify(
        `Ginger snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      try {
        await activeVm.close();
      } catch {
        // best effort — the VM is already stopped after a checkpoint
      }
      if (blocking) ui.setStatus("ginger", undefined);
    }
  }

  pi.on("session_start", async (event, ctx) => {
    // Capture ui while the ctx is active — this handler (and the VM boot it
    // triggers) can outlive a session replacement, after which every ctx
    // property access throws.
    const ui = ctx.ui;
    generation++;
    // A previous shutdown may have left the flag set — a fresh session must
    // be able to start its VM.
    shuttingDown = false;
    // A fork continues the parent session's work: adopt the running VM
    // instead of snapshotting + starting a second one. The state is in
    // module scope (see above) and the parent's shutdown handler (reason
    // "fork") deliberately left it in place for us.
    if (event.reason === "fork" && vm) {
      // Verify the VM is still alive before adopting — if it died in the
      // replacement gap, drop the stale state and start normally below
      // (resume from the tree's snapshot or fresh). Unknown (no ginger,
      // lookup error, entry already GC'd) → assume alive; a truly dead VM
      // fails loudly on the first exec.
      let alive = true;
      try {
        const g = await loadGinger();
        if (g) {
          const s = await g.sdk.findSession(vm.id);
          alive = s?.alive !== false;
        }
      } catch {
        alive = true;
      }
      if (alive) {
        // This factory invocation reset guestCwd to the default mount; the
        // adopted VM's spec is the source of truth (profiles can override
        // cwd).
        guestCwd = typeof vmSpec?.cwd === "string" && vmSpec.cwd ? vmSpec.cwd : guestWorkspace;
        ui.setStatus("ginger", ui.theme.fg("accent", vmStatusLabel(vm.id)));
        ui.notify(
          `Ginger VM inherited from parent session: ${vm.id} (${guestCwd})`,
          "info",
        );
        return;
      }
      vm = undefined;
      vmSpec = undefined;
      vmPiId = undefined;
      vmOrigin = undefined;
      vmIngressUrl = undefined;
      direnvEnv = undefined;
      loginEnv = undefined;
    }
    try {
      await ensureVm(ctx);
    } catch (err) {
      ui.notify(
        `Ginger VM failed to start: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Capture ui NOW: for /new and resume-switches the background snapshot
    // keeps running long after pi has replaced this session, and a stale
    // ctx throws on every property access.
    const ui = ctx.ui;
    const reason = event.reason;
    const activeVm = vm;
    const activeSpec = vmSpec;
    const activePiId = vmPiId;
    if (!activeVm) return;

    // Fork: hand the VM to the child session — no snapshot, no new VM. The
    // tree keeps sharing this one VM; the root's next shutdown covers it.
    if (reason === "fork") return;

    generation++;
    shuttingDown = true;
    vm = undefined;
    vmSpec = undefined;
    vmPiId = undefined;
    vmOrigin = undefined;
    vmStarting = undefined;
    direnvEnv = undefined;
    loginEnv = undefined;

    // Only snapshot sessions that have an actual JSONL transcript on disk.
    // pi reports the session file path even before it is ever written
    // (sessions without chat history never create the file), so the path
    // alone is not enough — checking existence keeps ephemeral sessions from
    // leaving snapshots nobody can resume.
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (
      typeof sessionFile !== "string" ||
      !sessionFile.endsWith(".jsonl") ||
      !fs.existsSync(sessionFile)
    ) {
      try {
        await activeVm.close();
      } catch {
        // best effort
      }
      ui.setStatus("ginger", undefined);
      return;
    }

    // Real exit (quit/reload, or an older pi without a reason): pi stops
    // running right after this handler, so the snapshot must complete here.
    // Session replacement (/new, resume-switch): pi keeps running, so run
    // the (potentially minutes-long) checkpoint in the background and let
    // the user keep working in the new session.
    if (reason === "new" || reason === "resume") {
      ui.notify("Ginger: snapshotting in the background — you can keep working", "info");
      void snapshotVm({ ui, vm: activeVm, spec: activeSpec, piId: activePiId, blocking: false }).catch(
        (err) => {
          ui.notify(
            `Ginger background snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        },
      );
    } else {
      await snapshotVm({ ui, vm: activeVm, spec: activeSpec, piId: activePiId, blocking: true });
    }
  });

  pi.registerCommand("ginger", {
    description: "Show Ginger VM status",
    handler: async (_args, ctx) => {
      const ui = ctx.ui; // capture while active (ensureVm can take minutes)
      const activeVm = await ensureVm(ctx);
      ui.notify(
        [
          `Ginger session: ${activeVm.id}`,
          `Label: ${vmSpec?.label ?? "(unknown)"}`,
          `Origin: ${vmOrigin ?? "unknown"}`,
          `Host workspace: ${localCwd}`,
          `Guest workspace: ${guestWorkspace}`,
          `Guest cwd: ${guestCwd}`,
          `Shell: ${shellPath}`,
          vmIngressUrl ? `Ingress: ${vmIngressUrl}` : undefined,
          loginEnv
            ? `Login env: captured (${Object.keys(loginEnv).length} vars)`
            : "Login env: NOT captured (tool commands miss /etc/profile defaults)",
          direnvEnv
            ? `Direnv: environment loaded (${Object.keys(direnvEnv).length} vars); /reload-direnv to re-evaluate`
            : undefined,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        "info",
      );
    },
  });


  pi.registerCommand("reload-direnv", {
    description:
      "Re-evaluate the guest .envrc (direnv) and refresh the environment used by tool commands",
    handler: async (_args, ctx) => {
      const ui = ctx.ui; // capture while active (re-evaluation can take minutes)
      if (!vmSpec?.direnv) {
        ui.notify(
          'Ginger: direnv is not enabled for this VM (set "direnv": true in .pi/ginger.json)',
          "error",
        );
        return;
      }
      const activeVm = await ensureVm(ctx);
      // Re-evaluation can take minutes (nix devshell) — show it in the
      // status line so pi doesn't look stalled.
      ui.setStatus(
        "ginger",
        ui.theme.fg("muted", "Ginger: re-evaluating .envrc (direnv/nix)…"),
      );
      try {
        const env = await gingerCall(() => captureDirenvEnv(activeVm, guestCwd));
        direnvEnv = env;
        ui.notify(
          `Ginger: direnv environment reloaded (${Object.keys(env).length} vars)`,
          "info",
        );
      } catch (err) {
        ui.notify(
          `Ginger: direnv reload failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      } finally {
        ui.setStatus("ginger", ui.theme.fg("accent", vmStatusLabel(activeVm.id)));
      }
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(guestCwd, {
        operations: createGondolinReadOps(activeVm, guestPaths()),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(guestCwd, {
        operations: createGondolinWriteOps(activeVm, guestPaths()),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(guestCwd, {
        operations: createGondolinEditOps(activeVm, guestPaths()),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(guestCwd, {
        operations: createGondolinBashOps(activeVm, guestPaths(), shellPath, {
          ...(loginEnv ?? {}),
          ...(direnvEnv ?? {}),
          ...piSessionVars(ctx),
        }),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createLsTool(guestCwd, {
        operations: createGondolinLsOps(activeVm, guestPaths()),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createFindTool(guestCwd, {
        operations: createGondolinFindOps(activeVm, guestPaths()),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return executeGondolinGrep(activeVm, guestPaths(), params, signal);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await ensureVm(ctx);
    return {
      operations: createGondolinBashOps(activeVm, guestPaths(), shellPath, {
        ...(loginEnv ?? {}),
        ...(direnvEnv ?? {}),
        ...piSessionVars(ctx),
      }),
    };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Non-fatal: a failed start was already reported at session_start and
    // individual tools will surface it on use. Only rewrite the prompt when
    // the VM is actually up, otherwise the local cwd line stays true.
    try {
      await ensureVm(ctx);
    } catch {}
    if (!vm) return;
    const localLine = `Current working directory: ${localCwd}`;
    const guestLine = `Current working directory: ${guestCwd} (Gondolin VM; host workspace mounted at ${guestWorkspace} from ${localCwd}${vmIngressUrl ? `; ingress: ${vmIngressUrl}` : ""}${direnvEnv ? "; direnv environment active — /reload-direnv re-evaluates the .envrc" : ""}; pi config and skills live at ${GUEST_PI_AGENT_DIR} in this VM — host paths under ${HOST_PI_AGENT_DIR} refer to the same files)`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });
}
