// Session spec — serializable description of a VM, shared by owner and client.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { LABEL_PREFIX, VERSION, VM_IMAGE, fail, profilesDir, sdk } from "./config.mjs";
import { paint } from "./ui.mjs";

// ---------------------------------------------------------------------------
// Labels — `<image>:<tag>?ws=<abs workspace>&name=<custom name>`
//
// The query part uses RFC 3986 percent-encoding (via URLSearchParams), so
// paths with spaces or '=' stay unambiguous. parseLabel also understands the
// legacy colon form (`ginger:<ver>[:ws=<ws>][:name=<name>]`) so old sessions
// and checkpoints keep working; everything new is written in v2.
// ---------------------------------------------------------------------------

/**
 * Parse a --listen value: "HOST:PORT", ":PORT" (host defaults to
 * 127.0.0.1) or the IPv6 bracket form "[::1]:PORT". Mirrors the gondolin
 * CLI's parseListenSpec.
 */
export function parseListenSpec(spec) {
  const trimmed = String(spec ?? "").trim();
  if (!trimmed) fail("--listen requires a non-empty value");

  let host = "127.0.0.1";
  let portStr = trimmed;

  if (portStr.startsWith("[")) {
    const bracketEnd = portStr.indexOf("]");
    if (bracketEnd === -1) fail(`invalid --listen value: ${spec} (missing ']')`);
    host = portStr.slice(1, bracketEnd);
    if (!host) fail(`invalid --listen value: ${spec} (empty host in brackets)`);
    const rest = portStr.slice(bracketEnd + 1);
    if (!rest.startsWith(":")) fail(`invalid --listen value: ${spec} (expected :PORT after ])`);
    portStr = rest.slice(1);
  } else if (portStr.includes(":")) {
    const idx = portStr.lastIndexOf(":");
    const rawHost = portStr.slice(0, idx);
    if (rawHost) host = rawHost;
    portStr = portStr.slice(idx + 1);
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    fail(`invalid --listen value: ${spec} (port must be 0-65535)`);

  return { host, port };
}

/** Clean a user-supplied name (values are encoded, but keep them tame). */
export function sanitizeName(name) {
  const cleaned = String(name ?? "")
    .replace(/[?&=]/g, "-")
    .trim();
  if (!cleaned) fail("name must be a non-empty string");
  return cleaned.slice(0, 64);
}

export function makeLabel({ ws = null, name = null, pi = null } = {}) {
  const params = new URLSearchParams();
  if (ws) params.set("ws", ws);
  if (name) params.set("name", sanitizeName(name));
  // pi= links the session to a pi agent session id. Only set for sessions
  // created by the pi extension, so it can find and resume its own VM.
  if (pi) params.set("pi", String(pi));
  const q = params.toString();
  return q ? `${LABEL_PREFIX}?${q}` : LABEL_PREFIX;
}

/** Parse the ws=/name=/pi= parts of a ginger label (v2 or legacy form). */
export function parseLabel(label) {
  const out = { ws: null, name: null, pi: null };
  const s = String(label ?? "");
  const qIdx = s.indexOf("?");
  if (qIdx >= 0) {
    for (const [k, v] of new URLSearchParams(s.slice(qIdx + 1))) {
      if (k === "ws") out.ws = v;
      else if (k === "name") out.name = v;
      else if (k === "pi") out.pi = v;
    }
  } else {
    for (const part of s.split(":").slice(1)) {
      if (part.startsWith("ws=")) out.ws = part.slice(3);
      else if (part.startsWith("name=")) out.name = part.slice(5);
      else if (part.startsWith("pi=")) out.pi = part.slice(3);
    }
  }
  return out;
}

/** Replace the name= part of a label, or drop it when name is null. */
export function setLabelName(label, name) {
  const cur = parseLabel(label);
  return makeLabel({ ws: cur.ws, name, pi: cur.pi });
}

/** Human-readable form for display (decoded values, no percent-encoding). */
export function formatLabel(label) {
  const s = String(label ?? "");
  const qIdx = s.indexOf("?");
  if (qIdx < 0) return s;
  const parts = [...new URLSearchParams(s.slice(qIdx + 1)).entries()].map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${s.slice(0, qIdx)}?${parts.join("&")}` : s.slice(0, qIdx);
}

// ---------------------------------------------------------------------------
// Option parsers — mirror the gondolin CLI so ginger accepts the same values
// ---------------------------------------------------------------------------

const SIZE_SUFFIXES = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Parse a human size ("512M", "2G", bare number = bytes) into bytes. */
export function parseSizeBytes(value, flag) {
  const m = String(value ?? "")
    .trim()
    .match(/^(\d+)([KMGTkmgt])?$/);
  if (!m || !Number(m[1]))
    fail(`invalid ${flag} value: ${value} (use a number with optional K/M/G/T suffix)`);
  const bytes = Number(m[1]) * (m[2] ? SIZE_SUFFIXES[m[2].toUpperCase()] : 1);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail(`invalid ${flag} value: ${value}`);
  return bytes;
}

/** Parse a --mount-hostfs spec: "HOST:GUEST[:ro]". */
export function parseMountHostfs(spec, flag = "--mount-hostfs") {
  const parts = String(spec).split(":");
  if (parts.length < 2 || !parts[0] || !parts[1])
    fail(`invalid ${flag} value: ${spec} (expected HOST:GUEST[:ro])`);
  const [host, guest, ...opts] = parts;
  const ro = opts.includes("ro");
  if (opts.some((o) => o !== "ro"))
    fail(`invalid ${flag} value: ${spec} (unknown option "${opts.find((o) => o !== "ro")}")`);
  return { host, guest, ro };
}

/**
 * Parse a --host-secret spec (same grammar as the gondolin CLI):
 *   NAME | NAME=VALUE | NAME@HOST[,HOST...] | NAME@HOST[,HOST...]=VALUE
 */
export function parseHostSecret(spec) {
  const at = String(spec).indexOf("@");
  if (at === -1) {
    const eq = spec.indexOf("=");
    const name = (eq === -1 ? spec : spec.slice(0, eq)).trim();
    if (!name) fail(`invalid --host-secret value: ${spec} (empty name)`);
    const value = eq === -1 ? process.env[name] : spec.slice(eq + 1);
    if (value === undefined) fail(`environment variable ${name} not set for --host-secret`);
    return { name, value, hosts: [] };
  }
  const name = spec.slice(0, at).trim();
  if (!name) fail(`invalid --host-secret value: ${spec} (empty name)`);
  const afterAt = spec.slice(at + 1);
  const eq = afterAt.indexOf("=");
  const hostsStr = eq === -1 ? afterAt : afterAt.slice(0, eq);
  const value = eq === -1 ? process.env[name] : afterAt.slice(eq + 1);
  if (value === undefined) fail(`environment variable ${name} not set for --host-secret`);
  const hosts = hostsStr
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0)
    fail(`invalid --host-secret value: ${spec} (no hosts; use ${name}@HOST[,HOST...])`);
  return { name, value, hosts };
}

/**
 * Secrets without explicit hosts get host suggestions (trufflehog scan of the
 * workspace) and an interactive confirmation, mirroring the gondolin CLI.
 */
export async function resolveSecretHosts(secrets) {
  const resolved = [];
  for (const secret of secrets) {
    if (secret.hosts.length > 0) {
      resolved.push(secret);
      continue;
    }
    process.stderr.write(`Discovering suggested hosts for secret ${secret.name}...\n`);
    const suggestions = await sdk.suggestHostsForSecret({
      secretValue: secret.value,
    });
    if (suggestions.length === 0)
      fail(
        `no suggested hosts found for secret ${secret.name}; provide hosts explicitly with --host-secret ${secret.name}@HOST[,HOST...]`,
      );
    const accepted = await promptForSuggestedSecretHosts(secret, suggestions);
    if (accepted.length === 0)
      fail(
        `no hosts were accepted for secret ${secret.name}; re-run with --host-secret ${secret.name}@HOST[,HOST...]`,
      );
    resolved.push({ ...secret, hosts: accepted });
  }
  return resolved;
}

async function promptForSuggestedSecretHosts(secret, suggestions) {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    fail(
      `suggested hosts were found for ${secret.name}, but interactive confirmation requires a TTY. Re-run with --host-secret ${secret.name}@HOST[,HOST...]`,
    );

  process.stderr.write(`Suggested hosts for ${secret.name}:\n`);
  suggestions.forEach((s, i) => {
    process.stderr.write(`  [${i + 1}] ${s.host}  (${s.file}:${s.line}, hits=${s.count ?? 0})\n`);
    if (s.snippet) process.stderr.write(`      ${s.snippet}\n`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = (
      await rl.question("Accept all suggested hosts? [Y/n] (or enter comma-separated numbers): ")
    )
      .trim()
      .toLowerCase();

    if (!answer || answer === "y" || answer === "yes" || answer === "a")
      return suggestions.map((s) => s.host);
    if (answer === "n" || answer === "no") return [];

    const indexes = answer
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value));
    if (indexes.length === 0) return [];

    const selected = new Set();
    for (const index of indexes) {
      const suggestion = suggestions[index - 1];
      if (!suggestion) return [];
      selected.add(suggestion.host);
    }
    return [...selected];
  } finally {
    rl.close();
  }
}

/**
 * Parse a --ssh-credential spec (same grammar as the gondolin CLI):
 *   HOST[:PORT]=PATH | USER@HOST[:PORT]=PATH
 * with optional ",passphrase-env=ENV" or ",passphrase=..." suffix.
 */
export function parseSshCredential(spec) {
  const comma = String(spec).lastIndexOf(",");
  const mainPart = comma === -1 ? spec : spec.slice(0, comma);
  let passphrase;
  if (comma !== -1) {
    const extra = spec.slice(comma + 1);
    if (extra.startsWith("passphrase-env=")) {
      const envName = extra.slice("passphrase-env=".length);
      passphrase = process.env[envName];
      if (passphrase === undefined)
        fail(`environment variable ${envName} not set for --ssh-credential`);
    } else if (extra.startsWith("passphrase=")) {
      passphrase = extra.slice("passphrase=".length);
    } else {
      fail(
        `invalid --ssh-credential value: ${spec} (unknown option after comma; use passphrase-env=ENV or passphrase=...)`,
      );
    }
  }

  const eq = mainPart.lastIndexOf("=");
  if (eq === -1) fail(`invalid --ssh-credential value: ${spec} (expected HOST[:PORT]=PATH)`);
  const hostPart = mainPart.slice(0, eq);
  const keyPath = mainPart.slice(eq + 1);
  if (!keyPath) fail(`invalid --ssh-credential value: ${spec} (empty key path)`);

  let username;
  const at = hostPart.lastIndexOf("@");
  if (at !== -1) {
    username = hostPart.slice(0, at);
    if (!username) fail(`invalid --ssh-credential value: ${spec} (empty username)`);
  }

  let host = at === -1 ? hostPart : hostPart.slice(at + 1);
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && colon > 0) {
    const portStr = host.slice(colon + 1);
    if (!/^\d+$/.test(portStr)) fail(`invalid --ssh-credential value: ${spec} (bad port)`);
    host = host.slice(0, colon);
  }
  if (!host) fail(`invalid --ssh-credential value: ${spec} (empty host)`);

  return { host, username, keyPath, passphrase };
}

/** Parse a --tcp-map spec: "GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT". */
export function parseTcpMapSpec(spec) {
  const eq = String(spec).indexOf("=");
  if (eq === -1)
    fail(`invalid --tcp-map value: ${spec} (expected GUEST_HOST[:PORT]=UPSTREAM_HOST:PORT)`);
  return { key: spec.slice(0, eq), value: spec.slice(eq + 1) };
}

/** Validate and merge KEY=VALUE env lists; later entries win on duplicate keys. */
export function mergeEnv(base, extra) {
  const byKey = new Map();
  for (const entry of [...base, ...extra]) {
    const eq = String(entry).indexOf("=");
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(entry).slice(0, eq)))
      fail(`invalid --env value: ${entry} (expected KEY=VALUE)`);
    byKey.set(String(entry).slice(0, eq), String(entry));
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Profile files — JSON describing VM creation options; CLI flags override
// them. Profiles live in ~/.config/ginger/profiles/<name>.json. The same
// string grammar as the corresponding CLI flag is used for list entries, so
// values can be copy-pasted between a command line and a file.
// ---------------------------------------------------------------------------

const SPEC_FILE_KEYS = new Set([
  "cwd",
  "env",
  "memory",
  "rootfsSize",
  "hostMounts",
  "memMounts",
  "allowHosts",
  "secrets",
  "tcpMap",
  "sshAllowHosts",
  "sshAgent",
  "sshKnownHosts",
  "sshCredentials",
  "disableWebSockets",
  "ssh",
  "listen",
  "direnv",
]);

/** Resolve a --profile name to its file path (validating the name). */
export function profilePath(name) {
  const n = String(name ?? "").trim();
  if (!n || n === "." || n === ".." || /[\\/]/.test(n)) fail(`invalid --profile name: ${name}`);
  return path.join(profilesDir, `${n}.json`);
}

/** Load and validate a profile JSON file. */
export function loadProfileFile(file) {
  if (!fs.existsSync(file)) fail(`profile not found: ${file} (create it under ${profilesDir}/)`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`cannot read profile file ${file}: ${err.message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fail(`profile file must contain a JSON object: ${file}`);
  for (const key of Object.keys(raw))
    if (!SPEC_FILE_KEYS.has(key))
      fail(
        `unknown key in profile file: ${key} (expected one of: ${[...SPEC_FILE_KEYS].join(", ")})`,
      );
  return raw;
}

function requireStringArray(value, what) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    fail(`profile file "${what}" must be an array of strings`);
  return value;
}

// ---------------------------------------------------------------------------
// Spec assembly
// ---------------------------------------------------------------------------

/**
 * Build the session spec from CLI options and an optional profile file.
 * Single-valued options: CLI flag wins over the file. List-valued options:
 * file entries first, CLI entries appended. Built-in defaults (the /nix
 * mount, GINGER_VERSION) are always applied on top.
 */
export async function buildSpec(opts) {
  // -- cwd: --cwd wins; else the profile file; else the workspace default.
  const wsPath = opts.workspace ? path.resolve(opts.workspace) : null;

  // Profile file: an explicit --profile name, or a project-local
  // <workspace>/.pi/ginger.json when present (how the pi extension
  // customizes the VM for a checkout).
  let file = {};
  if (opts.profile) {
    file = loadProfileFile(profilePath(opts.profile));
  } else if (wsPath) {
    const autoProfile = path.join(wsPath, ".pi", "ginger.json");
    if (fs.existsSync(autoProfile)) file = loadProfileFile(autoProfile);
  }
  const wsName = wsPath ? path.basename(wsPath) : null;
  let cwd = opts.cwd ?? (typeof file.cwd === "string" ? file.cwd : null);
  if (cwd !== null && !cwd.startsWith("/")) fail(`--cwd must be an absolute guest path: ${cwd}`);
  if (cwd === null) cwd = wsName ? `/workspace/${wsName}` : null;

  // -- listen (the profile file accepts the same string form as -l, or a
  // pre-parsed { host, port } object)
  const listenRaw = opts.listen ?? file.listen ?? null;
  let listen = null;
  if (listenRaw !== null && listenRaw !== undefined) {
    if (listenRaw === true) {
      // Bare -l: default host with an ephemeral port.
      listen = { host: "127.0.0.1", port: 0 };
    } else if (typeof listenRaw === "string") {
      listen = parseListenSpec(listenRaw);
    } else if (
      typeof listenRaw === "object" &&
      (listenRaw.host === undefined || typeof listenRaw.host === "string") &&
      Number.isInteger(listenRaw.port)
    ) {
      listen = { host: listenRaw.host ?? "127.0.0.1", port: listenRaw.port };
    } else {
      fail(`invalid listen value in profile file: ${JSON.stringify(listenRaw)}`);
    }
  }

  // -- sizes
  const memoryBytes = opts.memorySize
    ? parseSizeBytes(opts.memorySize, "--memory-size")
    : typeof file.memory === "string"
      ? parseSizeBytes(file.memory, "profile file 'memory'")
      : null;
  let rootfsSize =
    opts.rootfsSize ?? (typeof file.rootfsSize === "string" ? file.rootfsSize : null);
  if (rootfsSize !== null) {
    // Validate now so the user gets the error before the VM starts.
    parseSizeBytes(rootfsSize, "--rootfs-size");
    rootfsSize = String(rootfsSize).trim();
  }

  // -- env (file first, CLI appended; later entries win)
  const fileEnv = requireStringArray(file.env ?? [], "env");
  const env = mergeEnv(fileEnv, opts.env ?? []);

  // -- hostfs mounts
  const hostMounts = [
    ...requireStringArray(file.hostMounts ?? [], "hostMounts").map((m) =>
      parseMountHostfs(m, "profile file 'hostMounts' entry"),
    ),
    ...(opts.mountHostfs ?? []).map((m) => parseMountHostfs(m)),
  ];
  for (const m of hostMounts) {
    const p = path.resolve(m.host);
    if (!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory())
      fail(`--mount-hostfs host path does not exist or is not a directory: ${m.host}`);
  }

  // -- memfs mounts
  const memMounts = [
    ...requireStringArray(file.memMounts ?? [], "memMounts"),
    ...(opts.mountMemfs ?? []),
  ];
  for (const p of memMounts)
    if (!p.startsWith("/")) fail(`--mount-memfs path must be absolute: ${p}`);

  // -- HTTP egress
  const allowHosts = [
    ...requireStringArray(file.allowHosts ?? [], "allowHosts"),
    ...(opts.allowHost ?? []),
  ];
  const secretsRaw = [
    ...requireStringArray(file.secrets ?? [], "secrets").map((s) => parseHostSecret(s)),
    ...(opts.hostSecret ?? []).map(parseHostSecret),
  ];
  const secrets = await resolveSecretHosts(secretsRaw);
  // The guest only sees env vars supplied per connection (gondolin
  // attach/exec --env) — the VM-level defaultEnv from VM.create does not
  // reach sessions attached from another process. So each secret gets a
  // high-entropy placeholder generated here, seeded into the spec's env
  // below, and pinned on the secret so the owner's createHttpHooks
  // substitutes exactly the value the guest holds.
  const makePlaceholder = sdk.makePlaceholderFunc({ length: 32 });
  for (const s of secrets) s.placeholder = makePlaceholder();

  // -- tcp mappings (file record first, CLI entries appended/override per key)
  const fileTcp = file.tcpMap ?? {};
  if (typeof fileTcp !== "object" || fileTcp === null || Array.isArray(fileTcp))
    fail(`profile file "tcpMap" must be an object of GUEST:UPSTREAM pairs`);
  const tcpMap = { ...fileTcp };
  for (const [k, v] of Object.entries(fileTcp)) {
    if (typeof k !== "string" || typeof v !== "string")
      fail(`profile file "tcpMap" entries must be strings: ${JSON.stringify([k, v])}`);
    parseTcpMapSpec(`${k}=${v}`);
  }
  for (const entry of opts.tcpMap ?? []) {
    const { key, value } = parseTcpMapSpec(entry);
    tcpMap[key] = value;
  }

  // -- SSH egress
  const sshAllowHosts = [
    ...requireStringArray(file.sshAllowHosts ?? [], "sshAllowHosts"),
    ...(opts.sshAllowHost ?? []),
  ];
  const sshKnownHosts = [
    ...requireStringArray(file.sshKnownHosts ?? [], "sshKnownHosts"),
    ...(opts.sshKnownHosts ?? []),
  ];
  for (const p of sshKnownHosts)
    if (!fs.existsSync(p)) fail(`--ssh-known-hosts file does not exist: ${p}`);
  const sshCredentials = [
    ...requireStringArray(file.sshCredentials ?? [], "sshCredentials").map((s) =>
      parseSshCredential(s),
    ),
    ...(opts.sshCredential ?? []).map(parseSshCredential),
  ];
  for (const c of sshCredentials) {
    const p = path.resolve(c.keyPath);
    if (!fs.existsSync(p)) fail(`SSH key file does not exist: ${c.keyPath}`);
  }

  let sshAgent = opts.sshAgent !== undefined ? opts.sshAgent : (file.sshAgent ?? null);
  if (sshAgent === true) {
    sshAgent = process.env.SSH_AUTH_SOCK?.trim() || null;
    if (!sshAgent) fail("--ssh-agent requires a socket path or $SSH_AUTH_SOCK");
  } else if (sshAgent !== null && typeof sshAgent !== "string") {
    fail("--ssh-agent must be a socket path (or omitted for $SSH_AUTH_SOCK)");
  }
  if (sshAgent && sshAllowHosts.length === 0 && sshCredentials.length === 0)
    fail("--ssh-agent requires at least one --ssh-allow-host (or --ssh-credential)");

  // -- SSH access into the VM
  const fileSsh = file.ssh ?? null;
  if (fileSsh !== null && (typeof fileSsh !== "object" || fileSsh === null))
    fail(`profile file "ssh" must be an object of { user, port, listen }`);
  const ssh =
    opts.ssh || fileSsh
      ? {
          user: opts.sshUser ?? fileSsh?.user ?? "root",
          port: opts.sshPort ?? fileSsh?.port ?? 0,
          listen: opts.sshListen ?? fileSsh?.listen ?? "127.0.0.1",
        }
      : null;
  if (!ssh && [opts.sshUser, opts.sshPort, opts.sshListen].some((v) => v != null))
    fail("--ssh-user/--ssh-port/--ssh-listen require --ssh");
  if (ssh && !Number.isInteger(ssh.port)) fail("--ssh-port must be an integer");

  // -- websockets
  const disableWebSockets = !!(opts.disableWebSockets || file.disableWebSockets);

  const spec = {
    label: makeLabel({
      ws: wsPath,
      name: opts.name ?? null,
      pi: opts.piSession ?? null,
    }),
    mounts: [{ host: "/nix", guest: "/.ro-nix/nix", ro: true }],
    tcp: [],
    env,
    cwd,
    listen,
    direnv: opts.direnv || !!file.direnv,
    memoryBytes,
    rootfsSize,
    hostMounts,
    memMounts,
    allowHosts,
    secrets,
    tcpMap,
    sshAllowHosts,
    sshAgent,
    sshKnownHosts,
    sshCredentials,
    disableWebSockets,
    ssh,
  };
  if (wsPath) spec.mounts.push({ host: wsPath, guest: `/workspace/${wsName}` });
  spec.env.unshift(`GINGER_VERSION=${VERSION}`);
  for (const s of secrets) spec.env.push(`${s.name}=${s.placeholder}`);
  return spec;
}

// ---------------------------------------------------------------------------
// SDK options
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_BYTES = 2 * 1024 ** 3; // historical ginger default

/** Rebuild SDK VMOptions from a serializable spec (providers are live objects). */
export function makeVmOptions(spec) {
  const mounts = {};
  for (const m of spec.mounts ?? []) {
    const hostPath = path.resolve(m.host);
    if (!fs.statSync(hostPath, { throwIfNoEntry: false })?.isDirectory()) {
      fail(`host path does not exist or is not a directory: ${m.host}`);
    }
    let provider = new sdk.RealFSProvider(hostPath);
    if (m.ro) provider = new sdk.ReadonlyProvider(provider);
    if (m.guest.startsWith("/workspace")) {
      const secrets = new sdk.ShadowProvider(provider, {
        shouldShadow: sdk.createShadowPathPredicate(["/.env"]),
        writeMode: "deny",
      });
      provider = new sdk.ShadowProvider(secrets, {
        shouldShadow: sdk.createShadowPathPredicate([
          "/.git/hooks",
          "/.direnv",
          "/.venv",
          "/node_modules",
        ]),
        writeMode: "tmpfs",
      });
    }
    mounts[m.guest] = provider;
  }
  for (const m of spec.hostMounts ?? []) {
    const hostPath = path.resolve(m.host);
    let provider = new sdk.RealFSProvider(hostPath);
    if (m.ro) provider = new sdk.ReadonlyProvider(provider);
    mounts[m.guest] = provider;
  }
  for (const p of spec.memMounts ?? []) mounts[p] = new sdk.MemoryProvider();

  const tcpHosts = Object.fromEntries(
    (spec.tcp ?? []).map((t) => {
      const eq = t.indexOf("=");
      if (eq <= 0) fail(`invalid tcp mapping in spec: ${t}`);
      return [t.slice(0, eq), t.slice(eq + 1)];
    }),
  );
  for (const [k, v] of Object.entries(spec.tcpMap ?? {})) tcpHosts[k] = v;

  const memoryBytes = Math.max(spec.memoryBytes ?? 0, DEFAULT_MEMORY_BYTES);
  const options = {
    // Round up to whole MiB — qemu-style sizes must not be fractional.
    memory: `${Math.ceil(memoryBytes / 1024 ** 2)}M`,
    sessionLabel: spec.label,
    sandbox: { imagePath: VM_IMAGE, vmm: process.env.GONDOLIN_VMM ?? "qemu" },
    vfs: { mounts },
    env: [...(spec.env ?? [])],
  };
  if (Object.keys(tcpHosts).length > 0) {
    options.tcp = { hosts: tcpHosts };
    // Required companion settings for explicit tcp mappings.
    options.dns = { mode: "synthetic", syntheticHostMapping: "per-host" };
  }
  if (spec.rootfsSize) options.rootfs = { size: spec.rootfsSize };
  if (spec.disableWebSockets) options.allowWebSockets = false;

  // HTTP egress policy + secret injection.
  if ((spec.allowHosts?.length ?? 0) > 0 || (spec.secrets?.length ?? 0) > 0) {
    const { httpHooks, env } = sdk.createHttpHooks({
      allowedHosts: spec.allowHosts?.length ? spec.allowHosts : undefined,
      secrets: Object.fromEntries(
        (spec.secrets ?? []).map((s) => [
          s.name,
          {
            hosts: s.hosts,
            value: s.value,
            // Pin the placeholder generated in buildSpec so the hook
            // substitutes exactly what spec.env seeds into the guest.
            ...(s.placeholder ? { placeholder: s.placeholder } : {}),
          },
        ]),
      ),
    });
    options.httpHooks = httpHooks;
    for (const [k, v] of Object.entries(env)) options.env.push(`${k}=${v}`);
  }

  // SSH egress proxying.
  const creds = spec.sshCredentials ?? [];
  if ((spec.sshAllowHosts?.length ?? 0) > 0 || creds.length > 0) {
    const allowedHosts = [...(spec.sshAllowHosts ?? [])];
    for (const c of creds) if (!allowedHosts.includes(c.host)) allowedHosts.push(c.host);
    const credentials = Object.fromEntries(
      creds.map((c) => [
        c.host,
        {
          username: c.username,
          privateKey: fs.readFileSync(path.resolve(c.keyPath), "utf8"),
          passphrase: c.passphrase,
        },
      ]),
    );
    options.ssh = {
      allowedHosts,
      credentials: Object.keys(credentials).length ? credentials : undefined,
      agent: spec.sshAgent ?? undefined,
      knownHostsFile:
        (spec.sshKnownHosts?.length ?? 0) === 1
          ? spec.sshKnownHosts[0]
          : spec.sshKnownHosts?.length
            ? spec.sshKnownHosts
            : undefined,
    };
  }
  return options;
}
