// Image pipeline (declarative assets from the nix store).

import {
  BUILD_CONFIG,
  CONTAINER_IMAGE,
  IMAGE_TAR,
  VM_IMAGE,
  sdk,
} from "./config.mjs";
import { Step, run, saveLog, tail } from "./ui.mjs";

export async function ensureContainerImage() {
  // `image exists` exits 0/1 silently — a clean probe, no error noise.
  const probe = await run("podman", ["image", "exists", CONTAINER_IMAGE], {
    capture: true,
    quiet: true,
  });
  if (probe.code === 0) return;
  const step = new Step(`Importing base container image ${CONTAINER_IMAGE}`);
  const loaded = await run("podman", ["image", "load", "-i", IMAGE_TAR], {
    capture: true,
    quiet: true,
    onLine: (l) => step.note(l),
  });
  if (loaded.code !== 0) {
    const logPath = saveLog("container-import", loaded.out);
    for (const l of tail(loaded.out, 15).split("\n")) step.note(l);
    step.fail(`failed to import base container image — full log: ${logPath}`);
    process.exit(1);
  }
  step.succeed();
}

export async function ensureVmImage() {
  const refs = sdk.listImageRefs();
  if (refs.some((r) => r.reference === VM_IMAGE)) return;
  const step = new Step(`Building gondolin VM image ${VM_IMAGE}`);
  // Relative paths in the build config resolve against the config file's
  // directory, so the nix store path works from any cwd.
  const built = await run(
    "gondolin",
    ["build", "--tag", VM_IMAGE, "--config", BUILD_CONFIG],
    { capture: true, quiet: true, onLine: (l) => step.note(l) },
  );
  if (built.code !== 0) {
    const logPath = saveLog("vm-image-build", built.out);
    for (const l of tail(built.out, 15).split("\n")) step.note(l);
    step.fail(`failed to build gondolin VM image — full log: ${logPath}`);
    process.exit(1);
  }
  step.succeed();
}

/** Remove both the podman container image and the SDK VM image (--rmi). */
export async function removeImages() {
  const step = new Step("Removing images");
  await run("podman", ["image", "rm", CONTAINER_IMAGE], {
    capture: true,
    quiet: true,
  });
  sdk.removeImage(VM_IMAGE);
  step.succeed(`removed ${CONTAINER_IMAGE} and ${VM_IMAGE}`);
}
