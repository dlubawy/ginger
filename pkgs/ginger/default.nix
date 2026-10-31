{
  pkgs,
  containerPkgs,
  gondolin,
  pi,
  ...
}:
let
  inherit (pkgs) symlinkJoin writeShellApplication;
  ginger = import ./ginger.nix {
    inherit
      pkgs
      containerPkgs
      gondolin
      ;
  };
  inherit (ginger) gingerBin piHome;

  # Shared logic for the `pi` and `pi-ginger-install` wrappers: checks
  # ~/.pi/agent/.ginger-version against the nix-built config, prompts to
  # install when stale, and never deletes anything in the agent dir.
  piGingerScript = pkgs.writeTextFile {
    name = "pi-ginger-script";
    text = (builtins.readFile ./pi/pi-ginger.sh);
    executable = true;
    destination = "/pi-ginger.sh";
  };
  # Host wrapper around pi-coding-agent: offers to install the ginger-built
  # agent configuration, then execs the real pi.
  piWrapper = writeShellApplication {
    name = "pi";
    runtimeInputs = (
      builtins.attrValues {
        inherit (pkgs)
          jq
          lz4
          podman
          qemu
          ;
        inherit gingerBin gondolin pi;
      }
    );
    text = ''
      export PI_GINGER_CONFIG="${piHome}"
      exec ${piGingerScript}/pi-ginger.sh run "$@"
    '';
  };
  # Standalone installer for non-interactive use (the wrapper only prompts
  # on a TTY).
  piGingerInstall = writeShellApplication {
    name = "pi-ginger-install";
    runtimeInputs = [ pkgs.jq ];
    text = ''
      export PI_GINGER_CONFIG="${piHome}"
      exec ${piGingerScript}/pi-ginger.sh install
    '';
  };
in
symlinkJoin {
  name = "ginger";
  paths = with pkgs; [
    gingerBin
    gondolin
    piWrapper
    piGingerInstall
    podman
  ];
}
