import { VM } from "/lib/node_modules/@gondolin/host/dist/src/index.js";

async function main() {
  const vm = await VM.create({
    memory: process.env.INNER_MEMORY || "256M",
    cpus: Number(process.env.INNER_CPUS || "1"),
  });

  try {
    const argv = process.argv.slice(2);

    if (argv.length > 0) {
      const [cmd, ...cmdArgv] = argv;
      const result = await vm.exec([cmd, ...cmdArgv], {
        stdin: true,
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(result.exitCode || 0);
      return;
    }

    const result = await vm.shell({
      command: ["/bin/bash", "-i"],
      attach: true,
    });

    if (result.signal !== undefined) {
      console.error(`[inner] signal: ${result.signal}`);
    }

    process.exit(result.exitCode || 0);
  } finally {
    await vm.close();
  }
}

main().catch((err) => {
  console.error("[inner] error:", err);
  process.exit(1);
});
