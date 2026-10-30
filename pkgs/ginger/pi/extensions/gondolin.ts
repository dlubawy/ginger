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
 *   - The session label carries pi=<pi session id> and name=pi:<id> --
 *     <workspace>, so on the next start of the same pi session the extension
 *     finds its snapshot and resumes it, and `ginger ls` shows an informative
 *     display name (as if `ginger snap -n` had been used). Sessions created
 *     by the `ginger` CLI (no pi= variable) are never touched.
 *   - On shutdown the VM is checkpointed into ginger's checkpoint directory
 *     with the same label, i.e. exactly what `ginger snap -n <name>` would
 *     produce — but only when the pi session records to a JSONL session file
 *     (in-memory sessions are closed without a snapshot). Any earlier
 *     snapshots of the same pi session are removed, so there is at most one
 *     per session id.
 *
 * Environment isolation:
 *   - Tool commands run in the guest with the VM's own environment (image
 *     defaults plus the spec's env: GINGER_VERSION, profile env from
 *     .pi/ginger.json, host secrets) — exactly what an attached ginger shell
 *     sees. The host process.env is NOT forwarded into the guest (pi builds
 *     the exec env as a copy of it, which would leak host secrets into the
 *     sandbox); only pi's own session variables (PI_SESSION_ID,
 *     PI_SESSION_FILE, PI_PROVIDER, PI_MODEL, PI_REASONING_LEVEL) are added,
 *     mirroring pi's native bash tool.
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
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  readFile(
    path: string,
    opts: { encoding: "utf8"; signal?: AbortSignal },
  ): Promise<string>;
  writeFile(
    path: string,
    content: string | Buffer,
    opts?: { encoding?: string },
  ): Promise<void>;
  access(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  mkdir(
    path: string,
    opts?: { recursive?: boolean; signal?: AbortSignal },
  ): Promise<void>;
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
  makeLabel(parts: {
    ws?: string | null;
    name?: string | null;
    pi?: string | null;
  }): string;
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
}

interface GingerModules {
  spec: GingerSpecModule;
  checkpoints: GingerCheckpointsModule;
  sessions: GingerSessionsModule;
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
      throw new Error(
        detail ? `ginger: ${detail}` : `ginger exited with code ${code ?? 0}`,
      );
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
    const [spec, checkpoints, sessions, sdk] = await Promise.all([
      import(`${base}spec.mjs`),
      import(`${base}checkpoints.mjs`),
      import(`${base}sessions.mjs`),
      import(pathToFileURL(process.env.GONDOLIN_SDK).href),
    ]);
    if (!sdk.VM || !sdk.VmCheckpoint) return null;
    return { spec, checkpoints, sessions, sdk: sdk as GondolinSdk, envInfo };
  } catch {
    return null;
  } finally {
    if (!hadVersion) delete process.env.GINGER_VERSION;
  }
}

/** Resolve a GINGER_PI_SNAPSHOT value to checkpoint metadata. */
function resolveSnapshot(
  g: GingerModules,
  value: string,
): GingerCheckpointMeta {
  if (path.isAbsolute(value)) {
    const qcow = value.endsWith(".qcow2")
      ? value
      : value.endsWith(".json")
        ? `${value.slice(0, -".json".length)}.qcow2`
        : null;
    if (!qcow)
      throw new Error(
        `GINGER_PI_SNAPSHOT path must end in .qcow2 or .json: ${value}`,
      );
    const metaPath = `${qcow}.json`;
    if (!fs.existsSync(metaPath))
      throw new Error(
        `no checkpoint metadata for ${qcow} (expected ${metaPath})`,
      );
    return {
      ...(JSON.parse(
        fs.readFileSync(metaPath, "utf8"),
      ) as GingerCheckpointMeta),
      path: qcow,
    };
  }
  const matches = g.checkpoints.matchCheckpoints([value]);
  return matches[0];
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

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function toGuestPath(paths: GuestPaths, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return paths.cwd;
  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(paths.localCwd, trimmed)) {
      const relativePath = path.relative(paths.localCwd, trimmed);
      return relativePath
        ? path.posix.join(paths.root, toPosix(relativePath))
        : paths.root;
    }
    // Absolute guest path (or outside the workspace) — pass through.
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(paths.cwd, toPosix(trimmed));
}

// ---------------------------------------------------------------------------
// Tool operations over the VM (vm.fs / vm.exec)
// ---------------------------------------------------------------------------

function createGondolinReadOps(
  vm: GondolinVM,
  paths: GuestPaths,
): ReadOperations {
  return {
    readFile: async (filePath) => vm.fs.readFile(toGuestPath(paths, filePath)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(paths, filePath));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix
        .extname(toGuestPath(paths, filePath))
        .toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

function createGondolinWriteOps(
  vm: GondolinVM,
  paths: GuestPaths,
): WriteOperations {
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

function createGondolinEditOps(
  vm: GondolinVM,
  paths: GuestPaths,
): EditOperations {
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

  const walkDirectory = async (
    dir: string,
    relativeDir: string,
  ): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const entries = await vm.fs.listDir(dir, { signal });
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry)
        : entry;
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
  return path.posix.matchesGlob(
    path.posix.basename(relativePath),
    normalizedPattern,
  );
}

function createGondolinFindOps(
  vm: GondolinVM,
  paths: GuestPaths,
): FindOperations {
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
    return (line: string) =>
      (ignoreCase ? line.toLowerCase() : line).includes(needle);
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
      ? Math.min(
          params.lines.length - 1,
          params.lineIndex + params.contextLines,
        )
      : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(
      `${params.relativePath}${separator}${index + 1}${separator} ${text}`,
    );
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
  const matcher = createLineMatcher(
    params.pattern,
    params.literal,
    params.ignoreCase,
  );
  const contextLines =
    params.context && params.context > 0 ? params.context : 0;
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
      if (params.glob && !matchesToolGlob(relativePath, params.glob))
        return true;
      let content: string;
      try {
        content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
      } catch {
        return true;
      }
      const lines = content
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n");
      const displayPath = rootIsDirectory
        ? relativePath
        : path.posix.basename(guestPath);
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
        const proc = vm.exec([shellPath, "-lc", command], {
          cwd: guestCwd,
          // Never forward pi's exec env (a copy of the host process.env):
          // only pi's session vars, on top of the VM's own environment.
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
// Extension
// ---------------------------------------------------------------------------

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
  const guestWorkspace = path.posix.join(
    GUEST_WORKSPACE_ROOT,
    path.basename(localCwd),
  );
  let guestCwd = guestWorkspace;

  let vm: GondolinVM | undefined;
  let vmStarting: Promise<GondolinVM> | undefined;
  let vmSpec: Record<string, any> | undefined;
  let vmPiId: string | undefined;
  let vmOrigin: "fresh" | "resumed" | "seeded" | undefined;
  let shuttingDown = false;
  let shellPath = "/bin/sh";

  const guestPaths = (): GuestPaths => ({
    localCwd,
    root: guestWorkspace,
    cwd: guestCwd,
  });

  function checkpointDir(): string {
    return path.join(
      process.env.GINGER_CACHE_DIR?.trim() ||
        path.join(os.homedir(), ".cache", "ginger"),
      "checkpoints",
    );
  }

  async function startVm(ctx?: ExtensionContext): Promise<GondolinVM> {
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("accent", `Ginger: starting VM for ${localCwd}`),
    );
    const g = await loadGinger();
    if (!g)
      throw new Error(
        "ginger not found (no `ginger` on PATH and no GINGER_SRC set) — cannot start the VM; tools will fail until ginger is installed",
      );

    const piId = ctx
      ? String(ctx.sessionManager.getSessionId())
      : `pid-${process.pid}`;
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
        g.checkpoints
          .listCheckpoints()
          .filter((m) => g.spec.parseLabel(m.label ?? "").pi === piId),
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

    // A shutdown may have raced with the (slow) VM creation — don't leak it.
    if (shuttingDown) {
      await created.close().catch(() => {});
      throw new Error("pi is shutting down");
    }

    vm = created;
    vmSpec = spec;
    vmPiId = piId;
    vmOrigin = origin;
    guestCwd =
      typeof spec.cwd === "string" && spec.cwd ? spec.cwd : guestWorkspace;

    // Register the session (spec sidecar) so `ginger ls` shows it and other
    // ginger clients can attach/exec against it. Best effort: a missing
    // sidecar only degrades `ginger`'s descriptions, not the VM itself.
    try {
      await gingerCall(() => g.sessions.writeSessionSpec(created.id, spec));
    } catch (err) {
      ctx?.ui.notify(
        `Ginger: could not register session spec: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
    const bashProbe = await created.exec([
      "/bin/sh",
      "-lc",
      "command -v bash || true",
    ]);
    shellPath = bashProbe.stdout.trim() || "/bin/sh";
    ctx?.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg(
        "accent",
        `Ginger: ${created.id.slice(0, 8)} (${origin}, ${guestCwd})`,
      ),
    );
    ctx?.ui.notify(
      `Ginger VM ${origin === "fresh" ? "started" : origin === "resumed" ? "resumed from snapshot" : "started from GINGER_PI_SNAPSHOT"}. ${localCwd} is mounted at ${guestWorkspace}; tools run in ${guestCwd}.`,
      "info",
    );
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

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureVm(ctx);
    } catch (err) {
      ctx.ui.notify(
        `Ginger VM failed to start: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    const activeVm = vm;
    const activeSpec = vmSpec;
    const activePiId = vmPiId;
    vm = undefined;
    vmSpec = undefined;
    vmPiId = undefined;
    vmOrigin = undefined;
    vmStarting = undefined;
    if (!activeVm) return;
    // Only snapshot sessions that record to a JSONL session file; in-memory
    // sessions (and pre-first-message ones, which have no file yet) would
    // leave a snapshot nobody can correlate with a transcript.
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (typeof sessionFile !== "string" || !sessionFile.endsWith(".jsonl")) {
      try {
        await activeVm.close();
      } catch {
        // best effort
      }
      ctx.ui.setStatus("gondolin", undefined);
      return;
    }
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Ginger: snapshotting"),
    );
    const g = await loadGinger();
    try {
      if (g && activeSpec) {
        // Same layout as `ginger snap`: qcow2 + 0600 JSON sidecar in the
        // checkpoint dir, label keeps pi=<id> so the next start of this pi
        // session resumes it.
        const version =
          g.envInfo?.version ?? process.env.GINGER_VERSION ?? "dev";
        const name = `ginger-${String(version).replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}`;
        const dir = checkpointDir();
        fs.mkdirSync(dir, { recursive: true });
        const outPath = path.join(dir, `${name}.qcow2`);
        await activeVm.checkpoint(outPath);
        g.checkpoints.writeCheckpointMeta({
          name,
          path: outPath,
          label: activeSpec.label,
          spec: activeSpec,
          createdAt: new Date().toISOString(),
        });
        // One snapshot per pi session: drop this session's earlier
        // snapshots (the label's pi= links them) now that the new one is on
        // disk.
        if (activePiId) {
          const stale = await gingerCall(() =>
            g.checkpoints
              .listCheckpoints()
              .filter(
                (m) =>
                  g.spec.parseLabel(m.label ?? "").pi === activePiId &&
                  m.path !== outPath,
              ),
          );
          if (stale.length > 0)
            await gingerCall(() => g.checkpoints.removeCheckpoints(stale));
        }
        ctx.ui.notify(`Ginger VM snapshot saved: ${outPath}`, "info");
      }
    } catch (err) {
      ctx.ui.notify(
        `Ginger snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      try {
        await activeVm.close();
      } catch {
        // best effort — the VM is already stopped after a checkpoint
      }
      ctx.ui.setStatus("gondolin", undefined);
    }
  });

  pi.registerCommand("gondolin", {
    description: "Show Ginger VM status",
    handler: async (_args, ctx) => {
      const activeVm = await ensureVm(ctx);
      ctx.ui.notify(
        [
          `Ginger session: ${activeVm.id}`,
          `Label: ${vmSpec?.label ?? "(unknown)"}`,
          `Origin: ${vmOrigin ?? "unknown"}`,
          `Host workspace: ${localCwd}`,
          `Guest workspace: ${guestWorkspace}`,
          `Guest cwd: ${guestCwd}`,
          `Shell: ${shellPath}`,
        ].join("\n"),
        "info",
      );
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
        operations: createGondolinBashOps(
          activeVm,
          guestPaths(),
          shellPath,
          piSessionVars(ctx),
        ),
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
      operations: createGondolinBashOps(
        activeVm,
        guestPaths(),
        shellPath,
        piSessionVars(ctx),
      ),
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
    const guestLine = `Current working directory: ${guestCwd} (Gondolin VM; host workspace mounted at ${guestWorkspace} from ${localCwd})`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });
}
