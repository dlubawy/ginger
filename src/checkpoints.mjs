// Checkpoint (snapshot) metadata: list, match, remove.

import fs from "node:fs";
import path from "node:path";

import { LABEL_PREFIX, checkpointDir, fail } from "./config.mjs";
import { derivedPiName, parseLabel } from "./spec.mjs";

/** All ginger checkpoints, newest first. */
export function listCheckpoints() {
  if (!fs.existsSync(checkpointDir)) return [];
  return fs
    .readdirSync(checkpointDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(checkpointDir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((m) => m && (m.label ?? "").startsWith(LABEL_PREFIX))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Match checkpoint queries given as auto-names, custom names (label name=),
 * workspace names (label ws=), or unique prefixes of any of those. Fails on
 * no match or an ambiguous prefix.
 */
export function matchCheckpoints(queries) {
  const all = listCheckpoints();
  // Key by object identity, NOT m.name: the auto-name is derived from the
  // image name, so several snapshots of one session share it — a Set of
  // names would silently widen a match to its siblings.
  const matched = new Set();
  for (const q of queries) {
    // A checkpoint can be addressed by its auto-name, its custom name, its
    // derived pi title (what ls shows for pi-owned snapshots), the workspace
    // it belongs to (full path or basename), or its image file name (what ls
    // shows in the IMAGE column).
    const keys = (m) => {
      const { ws, name } = parseLabel(m.label);
      const img = path.basename(m.path);
      return [
        m.name,
        name,
        derivedPiName(m.label),
        ws,
        ws ? path.basename(ws) : null,
        img,
        img.replace(/\.[^.]+$/, ""),
      ];
    };
    const hits = all.filter((m) => keys(m).some((k) => k === q));
    if (hits.length > 0) {
      for (const m of hits) matched.add(m);
      continue;
    }
    const prefix = all.filter((m) => keys(m).some((k) => k?.startsWith(q)));
    if (prefix.length === 0) fail(`no checkpoint matching '${q}'`);
    if (prefix.length > 1) fail(`'${q}' is ambiguous (${prefix.length} checkpoints match)`);
    matched.add(prefix[0]);
  }
  return all.filter((m) => matched.has(m));
}

/** Remove checkpoint files (disk image + metadata). */
export function removeCheckpoints(checkpoints) {
  for (const m of checkpoints) {
    fs.rmSync(m.path, { force: true });
    fs.rmSync(`${m.path}.json`, { force: true });
  }
}

/**
 * Write a checkpoint's metadata sidecar. The embedded spec may carry secret
 * values and passphrases, so the file is mode 0600. Written to a temp file
 * and renamed so a crash mid-write never leaves a truncated (and therefore
 * unparseable) sidecar next to its disk image.
 */
export function writeCheckpointMeta(meta) {
  const target = `${meta.path}.json`;
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Disk images with no metadata sidecar — snapshots whose writer died between
 * writing the qcow and its .json. They are unusable (no label/spec) but must
 * not vanish silently: `ginger ls` reports them.
 */
export function orphanedCheckpoints() {
  if (!fs.existsSync(checkpointDir)) return [];
  return fs
    .readdirSync(checkpointDir)
    .filter((f) => f.endsWith(".qcow2") && !fs.existsSync(`${path.join(checkpointDir, f)}.json`))
    .map((f) => path.join(checkpointDir, f))
    .sort();
}
