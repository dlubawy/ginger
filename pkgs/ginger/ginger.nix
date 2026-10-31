{
  pkgs,
  containerPkgs,
  gondolin,
  ...
}:
let
  inherit (pkgs) writeShellApplication;

  version = "0.0.1";
  piHome = (import ./pi { inherit pkgs version; });
  gondolinImage = (
    import ./gondolin-image {
      inherit
        pkgs
        containerPkgs
        gondolin
        version
        piHome
        ;
    }
  );
  # Co-locate the ginger source files in the nix store so the ESM imports
  # between them resolve at runtime.
  gingerSrc = builtins.path {
    path = ./src;
    name = "ginger-src-${version}";
  };
in
{
  # Re-exported so the host wrappers in ../default.nix can ship the same
  # config they prompt users to install.
  inherit piHome;
  gingerBin = writeShellApplication {
    name = "ginger";
    runtimeInputs = with pkgs; [
      # nodejs runs the ginger sources; qemu + lz4 are required by the
      # gondolin SDK to spawn the VMM (mirrors the gondolin package's makeWrapper).
      nodejs
      podman
      qemu
      lz4
      gondolin
    ];
    text = ''
      export GINGER_VERSION="${version}"
      export GINGER_IMAGE_TAR="${gondolinImage}/gondolin-image.tar"
      export GINGER_BUILD_CONFIG="${gondolinImage}/build-config.json"
      export GONDOLIN_DEFAULT_IMAGE="ginger-env:${version}"
      export GONDOLIN_VMM="qemu"
      # Absolute path so the ESM import resolves inside the nix store.
      export GONDOLIN_SDK="${gondolin}/lib/node_modules/@gondolin/host/dist/src/index.js"
      exec node ${gingerSrc}/main.mjs "$@"
    '';
  };
}
