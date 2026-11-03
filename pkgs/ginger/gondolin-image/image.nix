{
  pkgs,
  containerPkgs,
  version,
  piHome,
  ...
}:
let
  inherit (pkgs) dockerTools;
  chromiumLauncher = containerPkgs.writeTextFile {
    name = "chromium-launcher";
    text = ''
      #!/bin/sh
      for f in /etc/chromium/*.conf; do
        [ -f "$f" ] && . "$f"
      done
      CHROMIUM_FLAGS="$CHROMIUM_FLAGS ''${CHROMIUM_USER_FLAGS:+"$CHROMIUM_USER_FLAGS"}"
      exec /bin/chromium ''${CHROMIUM_FLAGS} "$@"
    '';
    executable = true;
    destination = "/usr/bin/chromium";
  };
  runInnerVM = containerPkgs.writeTextFile {
    name = "gondolin-run-inner-vm";
    text = (builtins.readFile ./run-inner-vm.mjs);
    destination = "/run-inner-vm.mjs";
  };
  # User-facing helper to restore/remove the dashboard's ingress route after
  # hand-editing /etc/gondolin/listeners (also used by init).
  playwrightDashboard = containerPkgs.writeShellApplication {
    name = "playwright-dashboard";
    runtimeInputs = (builtins.attrValues { inherit (containerPkgs) curl gnugrep; });
    text = (builtins.readFile ./playwright-dashboard.sh);
  };
  image = dockerTools.buildLayeredImage {
    name = "gondolin-image";
    fromImage = dockerTools.pullImage {
      imageName = "alpine";
      imageDigest = "sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a";
      hash = "sha256-3NOrK7BrtlCX23qGfDWlsgv3vBYmBLTQKq/4sLp8o8c=";
    };
    tag = version;
    contents = [
      containerPkgs.dockerTools.caCertificates
      chromiumLauncher
      playwrightDashboard
      (containerPkgs.writeShellApplication {
        name = "gondolin-bash";
        runtimeInputs = (builtins.attrValues { inherit (containerPkgs) nodejs qemu gondolin; });
        text = ''
          exec node ${runInnerVM}/run-inner-vm.mjs "$@"
        '';
      })
      piHome
    ]
    ++ (builtins.attrValues {
      inherit (containerPkgs)
        chromium
        curl
        direnv
        glibc
        fd
        fontconfig
        git
        gnused
        gondolin
        gsettings-desktop-schemas
        mesa
        nix
        nodejs
        noto-fonts
        openssh
        pi-coding-agent
        playwright-cli
        python3
        ripgrep
        uv
        ;
    });
    includeStorePaths = false;
    extraCommands = ''
      mkdir -p ./bin ./libexec ./usr/sbin
      cp -r ${containerPkgs.pkgsStatic.bash}/bin/* ./bin
      cp -r ${containerPkgs.pkgsStatic.dbus}/bin/* ./bin
      cp -r ${containerPkgs.pkgsStatic.glib}/bin/* ./bin
      cp -r ${containerPkgs.pkgsStatic.e2fsprogs}/bin/* ./bin
      cp -r ${containerPkgs.pkgsStatic.dbus}/libexec/* ./libexec
      ln -sf ../../bin/sshd ./usr/sbin/sshd
      rm ./usr/bin/sandboxd
      rm ./usr/bin/sandboxfs
      rm ./usr/bin/sandboxingress
      rm ./usr/bin/sandboxssh
      # The alpine base ships a musl ldd at /usr/bin/ldd. Native-module
      # installers (rolldown, esbuild, …) detect the system libc by running
      # `ldd --version` and grepping for "musl" — which misidentifies this
      # hybrid image and makes them pick musl builds of native bindings even
      # though node is a glibc build from nix. Replace it with the glibc ldd,
      # which also inspects the many glibc binaries in this image correctly.
      rm -f ./usr/bin/ldd
      ln -s ${containerPkgs.glibc.bin}/bin/ldd ./usr/bin/ldd
    '';
  };
in
pkgs.runCommand "gondolin-image" { } ''
  mkdir -p $out
  cp ${image} $out/gondolin-image.tar
''
