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
  image = dockerTools.buildLayeredImage {
    name = "gondolin-image";
    fromImage = dockerTools.pullImage {
      imageName = "alpine";
      imageDigest = "sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a";
      hash = "sha256-3NOrK7BrtlCX23qGfDWlsgv3vBYmBLTQKq/4sLp8o8c=";
    };
    tag = "v${version}";
    contents = [
      containerPkgs.dockerTools.caCertificates
      chromiumLauncher
      (containerPkgs.writeShellApplication {
        name = "playwright-cli";
        runtimeInputs = (builtins.attrValues { inherit (containerPkgs) nodejs; });
        text = ''
          npmRoot="$(${containerPkgs.nodejs}/bin/npm root -g)"
          if [ ! -d "$npmRoot/@playwright" ]; then
            npm install -g @playwright/cli@latest
          fi
          npx --no-install playwright-cli "$@"
        '';
      })
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
        fd
        fontconfig
        gnused
        gondolin
        gsettings-desktop-schemas
        mesa
        nix
        nodejs
        noto-fonts
        openssh
        pi-coding-agent
        python3
        ripgrep
        uv
        ;
    });
    includeStorePaths = false;
    extraCommands = ''
      mkdir -p ./bin ./libexec
      cp -r ${containerPkgs.pkgsStatic.bash}/bin/* ./bin
      cp -r ${containerPkgs.pkgsStatic.dbus}/bin/* ./bin
      cp -r ${containerPkgs.pkgsStatic.glib}/bin/* ./bin
      cp -r ${containerPkgs.pkgsStatic.dbus}/libexec/* ./libexec
      rm ./usr/bin/sandboxd
      rm ./usr/bin/sandboxfs
      rm ./usr/bin/sandboxingress
      rm ./usr/bin/sandboxssh
    '';
  };
in
pkgs.runCommand "gondolin-image" { } ''
  mkdir -p $out
  cp ${image} $out/gondolin-image.tar
''
