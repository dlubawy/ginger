{ pkgs, ... }:
pkgs.stdenv.mkDerivation (finalAttr: {
  pname = "gondolin";
  version = "0.13.0";
  src = pkgs.fetchFromGitHub {
    owner = "earendil-works";
    repo = "gondolin";
    rev = "v${finalAttr.version}";
    hash = "sha256-zxcP/S9Z4ofke1aligdqEYEEUwyjywyphXgoqyV/Mfs=";
  };
  nativeBuildInputs = (
    builtins.attrValues {
      inherit (pkgs)
        nodejs
        pnpmConfigHook
        pnpm_12
        qemu
        lz4
        makeWrapper
        zig
        uv
        ;
    }
  );
  # pnpmDeps = pkgs.fetchPnpmDeps { inherit (finalAttr) pname version src patches; pnpm = pkgs.pnpm_10; hash = "sha256-FIWcDSheA9NEotOjbRxDi79fR3UU5xuKzrSeJvHBKZs="; fetcherVersion = 3; };
  pnpmDeps = pkgs.fetchPnpmDeps {
    inherit (finalAttr) pname version src;
    pnpm = pkgs.pnpm_12;
    hash = "sha256-6qdzwqch2fvVw+paNCQ1Nk4w20dZ5NuWS8dZLRc5CTc=";
    fetcherVersion = 4;
  };
  buildPhase = ''
    runHook preBuild

    make -C host
    make -C guest build-inner

    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/node_modules/@gondolin"
    cp -a ./* $out/lib/node_modules/@gondolin

    mkdir -p $out/bin
    chmod +x $out/lib/node_modules/@gondolin/host/dist/bin/gondolin.js
    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/gondolin \
      --add-flags $out/lib/node_modules/@gondolin/host/dist/bin/gondolin.js \
      --prefix-each PATH : "${pkgs.qemu}/bin:${pkgs.lz4.out}/bin" \
      --prefix NODE_PATH : $out/lib/node_modules/@gondolin/node_modules

    mkdir -p $out/usr/bin
    cp -a ./guest/zig-out/bin/* $out/usr/bin

    runHook postInstall
  '';
})
