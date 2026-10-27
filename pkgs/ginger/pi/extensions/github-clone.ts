/**
 * GitHub Extension
 *
 * Looks for `github:<org>/<repo>` patterns in user prompts and
 * automatically clones them to /tmp/github/<repo>.
 * Then replaces the github:<org>/<repo> string with the local path.
 *
 * Shows an immediate notification "Cloning repos..." as soon as the
 * extension detects github: references, so the user knows something
 * is happening even before the transformed prompt reappears.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use `github:<org>/<repo>` in your prompt
 * 3. The repo will be cloned and the path substituted automatically
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

const GITHUB_PATTERN = /github:(\w+[\w.-]*\/[\w.-]+)/g;
const CLONE_DIR = "/tmp/github";

/** Check if a directory exists */
async function dirExists(path: string, pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("test", ["-d", path]);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function cloneRepo(orgRepo: string, pi: ExtensionAPI): Promise<string> {
  const clonePath = `${CLONE_DIR}/${orgRepo}`;

  // Check if already cloned
  if (await dirExists(clonePath, pi)) {
    return clonePath;
  }

  // Ensure clone directory exists
  try {
    await pi.exec("mkdir", ["-p", CLONE_DIR]);
  } catch {
    // Directory may already exist
  }

  // Clone the repo
  const result = await pi.exec("git", [
    "clone",
    `https://github.com/${orgRepo}`,
    clonePath,
  ]);

  if (result.code === 0) {
    return clonePath;
  }

  // Clone failed - check if the directory now exists (race condition)
  if (await dirExists(clonePath, pi)) {
    return clonePath;
  }

  const errMessage = result.stderr || "clone failed";
  throw new Error(`Failed to clone ${orgRepo}: ${errMessage}`);
}

export default function githubExtension(pi: ExtensionAPI): void {
  pi.on(
    "input",
    async (
      event: InputEvent,
      ctx: ExtensionContext,
    ): Promise<InputEventResult> => {
      const matches = Array.from(event.text.matchAll(GITHUB_PATTERN));
      if (matches.length === 0) {
        return { action: "continue" };
      }

      // Show notification IMMEDIATELY before cloning starts
      // This gives the user feedback while the clone is in progress
      ctx.ui.notify("Cloning GitHub repos...", "info");

      // Collect unique org/repo patterns to clone
      const uniqueRepos = [...new Set(matches.map((m) => m[1]))];

      // Clone all repos in parallel
      const results = new Map<string, string>();
      const errors = new Map<string, string>();

      await Promise.all(
        uniqueRepos.map(async (orgRepo) => {
          try {
            const path = await cloneRepo(orgRepo, pi);
            results.set(orgRepo, path);
          } catch (error) {
            errors.set(
              orgRepo,
              error instanceof Error ? error.message : String(error),
            );
          }
        }),
      );

      // Transform text only after cloning succeeds
      let text = event.text;
      for (const match of matches) {
        const orgRepo = match[1];
        const fullPath = match[0]; // github:<org>/<repo>
        if (results.has(orgRepo)) {
          text = text.replace(fullPath, results.get(orgRepo)!);
        }
        // If there's an error, keep the original text (don't replace)
      }

      // Clear the initial notification and show final status
      ctx.ui.notify("Cloning complete");

      if (errors.size > 0) {
        ctx.ui.notify(
          `Some clones failed: ${Array.from(errors.keys()).join(", ")}`,
          "warning",
        );
      }

      return {
        action: "transform",
        text: text,
        images: event.images,
      };
    },
  );
}
