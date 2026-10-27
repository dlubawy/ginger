{
  pkgs,
  containerPkgs,
  version,
  piHome,
  ...
}:
let
  inherit (pkgs) symlinkJoin lib;
  buildConfig = (import ./build-config.nix { inherit pkgs version; });
  image = (
    import ./image.nix {
      inherit
        pkgs
        containerPkgs
        version
        piHome
        ;
    }
  );
  initScript = pkgs.writeTextFile {
    name = "gondolin-init-extra";
    text = (builtins.readFile ./gondolin-init-extra.sh);
    executable = true;
    destination = "/gondolin-init-extra.sh";
  };
  rootfs = pkgs.stdenv.mkDerivation {
    name = "rootfs";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = ./rootfs;
    };
    postInstall = ''
      mkdir -p $out
      cp -R ./rootfs $out/rootfs
    '';
  };
in
symlinkJoin {
  name = "gondolin-image";
  paths = [
    buildConfig
    image
    initScript
    rootfs
  ];
}
