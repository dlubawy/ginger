# playwright-cli (@playwright/cli) as a proper package: the npm tarballs
# are pinned and unpacked into a node_modules layout at image-build time,
# so the guest never needs network (the old wrapper ran `npm install -g`
# on first use). The CLI only needs plain `node` — no lifecycle scripts.
{ pkgs, ... }:
let
  inherit (pkgs) fetchurl;
  cliVersion = "0.1.22";
  coreVersion = "1.64.0-alpha-1790635538000";
  cliTarball = fetchurl {
    url = "https://registry.npmjs.org/@playwright/cli/-/cli-${cliVersion}.tgz";
    sha256 = "bb4840be17006e2b7ba856224dc3062f6571d5f647352476f95c5e77ff5d679a";
  };
  playwrightTarball = fetchurl {
    url = "https://registry.npmjs.org/playwright/-/playwright-${coreVersion}.tgz";
    sha256 = "436022a21e7a7c34436970fe04ab3fccae87a5045d3ed5af3f66c6e3ba377ee8";
  };
  playwrightCoreTarball = fetchurl {
    url = "https://registry.npmjs.org/playwright-core/-/playwright-core-${coreVersion}.tgz";
    sha256 = "54ad1d38174d6ef56d1f165e52547ece8e6c24b865f2a072d9ebaacfbad1ca47";
  };
in
pkgs.stdenv.mkDerivation {
  pname = "playwright-cli";
  version = cliVersion;
  # No src: the pinned tarballs are expanded directly in installPhase.
  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    mkdir -p $out/lib/node_modules/@playwright $out/bin
    tar xzf ${cliTarball}
    mv package $out/lib/node_modules/@playwright/cli
    tar xzf ${playwrightTarball}
    mv package $out/lib/node_modules/playwright
    tar xzf ${playwrightCoreTarball}
    mv package $out/lib/node_modules/playwright-core
    cat > $out/bin/playwright-cli <<'EOF'
    #!/bin/sh
    exec ${pkgs.nodejs}/bin/node "$out/lib/node_modules/@playwright/cli/playwright-cli.js" "$@"
    EOF
    chmod 0755 $out/bin/playwright-cli
  '';
}
