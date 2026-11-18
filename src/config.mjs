// Shared configuration — env vars injected by the nix wrapper, derived paths,
// and the gondolin host SDK handle.

import os from "node:os";
import path from "node:path";

export const VERSION = process.env.GINGER_VERSION;
export const IMAGE_TAR = process.env.GINGER_IMAGE_TAR;
export const BUILD_CONFIG = process.env.GINGER_BUILD_CONFIG;
export const SDK_PATH = process.env.GONDOLIN_SDK;
export const VM_IMAGE = process.env.GONDOLIN_DEFAULT_IMAGE ?? `ginger-env:${VERSION}`;
export const CONTAINER_IMAGE = `localhost/gondolin-image:${VERSION}`;
// Label head for v3 labels. The version moved out of the head into a v=
// query parameter so one ginger install can see (and manage) resources from
// other versions — legacy labels carry it in the head (`ginger:0.0.1?…`),
// which isGingerLabel() still matches.
export const LABEL_PREFIX = "ginger";

export const cacheDir = process.env.GINGER_CACHE_DIR ?? path.join(os.homedir(), ".cache", "ginger");
export const checkpointDir = path.join(cacheDir, "checkpoints");
export const logDir = path.join(cacheDir, "logs");
export const profilesDir = path.join(os.homedir(), ".config", "ginger", "profiles");

export const sdk = await import(SDK_PATH);

/** Print an error and exit 1. */
export function fail(message) {
  console.error(`ginger: ${message}`);
  process.exit(1);
}
