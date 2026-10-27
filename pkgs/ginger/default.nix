{
  pkgs,
  containerPkgs,
  gondolin,
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
in
symlinkJoin {
  name = "ginger";
  paths = with pkgs; [
    gingerBin
    gondolin
    podman
  ];
}
