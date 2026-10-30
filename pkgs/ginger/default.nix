{
  pkgs,
  containerPkgs,
  gondolin,
  pi,
  ...
}:
let
  inherit (pkgs) symlinkJoin;
  inherit
    (import ./ginger.nix {
      inherit
        pkgs
        containerPkgs
        gondolin
        ;
    })
    gingerBin
    ;
  piWrapper = pkgs.writeShellApplication {
    name = "pi";
    runtimeInputs = (
      builtins.attrValues {
        inherit (pkgs)
          lz4
          podman
          qemu
          ;
        inherit gingerBin gondolin pi;
      }
    );
    text = ''
      pi "$@"
    '';
  };
in
symlinkJoin {
  name = "ginger";
  paths = with pkgs; [
    gingerBin
    gondolin
    piWrapper
    podman
  ];
}
