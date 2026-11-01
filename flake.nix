{
  description = "A Nix flake based environment";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    git-hooks = {
      url = "github:cachix/git-hooks.nix/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      git-hooks,
    }@inputs:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forEachSupportedSystem =
        f: nixpkgs.lib.genAttrs supportedSystems (system: f { pkgs = import nixpkgs { inherit system; }; });
    in
    {
      packages = forEachSupportedSystem (
        { pkgs }: (import ./pkgs pkgs.stdenv.hostPlatform.system inputs) pkgs
      );
      checks = forEachSupportedSystem (
        { pkgs }:
        let
          system = pkgs.stdenv.hostPlatform.system;
          # Node with native TypeScript type stripping — the ginger pi
          # extension is loaded as .ts directly by node.
          hostUnstable = import nixpkgs-unstable { inherit system; };
          gingerSrc = builtins.path {
            path = ./pkgs/ginger;
            name = "ginger-src";
          };
        in
        {
          pre-commit-check = inputs.git-hooks.lib.${system}.run {
            src = builtins.path {
              path = ./.;
              name = "template";
            };
            package = pkgs.prek;
            hooks = {
              trufflehog = {
                enable = true;
                name = "🔒 Security · Detect hardcoded secrets";
              };
              nixfmt = {
                enable = true;
                name = "🔍 Code Quality · ❄️ Nix · Format";
                after = [ "trufflehog" ];
              };
              oxfmt = {
                enable = true;
                name = "🔍 Code Quality · 🟦 TypeScript · Format";
                after = [ "trufflehog" ];
              };
              oxlint = {
                enable = true;
                name = "🔍 Code Quality · 🟦 TypeScript · Lint";
                after = [ "oxfmt" ];
              };
              flake-checker = {
                enable = true;
                name = "✅ Data & Config Validation · ❄️ Nix · Flake checker";
                args = [
                  "--check-supported"
                  "false"
                ];
                after = [
                  "nixfmt"
                  "oxlint"
                ];
              };
              check-yaml = {
                enable = true;
                name = "✅ Data & Config Validation · YAML · Lint";
                after = [
                  "nixfmt"
                  "oxlint"
                ];
              };
              mdformat = {
                enable = true;
                name = "📝 Docs · Markdown · Format";
                after = [
                  "flake-checker"
                  "check-yaml"
                ];
              };
              just =
                let
                  package = pkgs.just;
                in
                {
                  enable = true;
                  package = package;
                  name = "🤖 Justfile · Format";
                  entry = "${package}/bin/just --fmt --unstable";
                  files = "^justfile$";
                  pass_filenames = false;
                  after = [ "mdformat" ];
                };
              check-case-conflicts = {
                enable = true;
                name = "📁 Filesystem · Check case sensitivity";
                after = [ "just" ];
              };
              check-symlinks = {
                enable = true;
                name = "📁 Filesystem · Check symlinks";
                after = [ "just" ];
              };
              check-merge-conflicts = {
                enable = true;
                name = "🌳 Git Quality · Detect conflict markers";
                after = [
                  "check-symlinks"
                  "check-case-conflicts"
                ];
              };
              forbid-new-submodules = {
                enable = true;
                name = "🌳 Git Quality · Prevent submodule creation";
                after = [
                  "check-symlinks"
                  "check-case-conflicts"
                ];
              };
              no-commit-to-branch = {
                enable = true;
                name = "🌳 Git Quality · Protect main branch";
                settings.branch = [ "main" ];
                stages = [ "pre-push" ];
                after = [
                  "check-symlinks"
                  "check-case-conflicts"
                ];
              };
              check-added-large-files = {
                enable = true;
                name = "🌳 Git Quality · Block large file commits";
                args = [ "--maxkb=5000" ];
                after = [
                  "check-symlinks"
                  "check-case-conflicts"
                ];
              };
              commitizen = {
                enable = true;
                name = "🌳 Git Quality · Validate commit message";
                stages = [ "commit-msg" ];
                after = [
                  "check-symlinks"
                  "check-case-conflicts"
                ];
              };
            };
          };

          # Hermetic E2E test of the pi extension (real extension + real
          # ginger src, stub gondolin SDK, mock pi API). Fast and
          # sandbox-safe; runs on every system.
          pi-extension-check =
            pkgs.runCommand "pi-extension-check"
              {
                nativeBuildInputs = [ hostUnstable.nodejs ];
                PI_SDK_DIR = "${self.packages.${system}.pi}/lib/node_modules/pi-monorepo";
              }
              ''
                mkdir -p $out
                node ${gingerSrc}/tests/pi-extension.test.mjs
              '';

        }
        # Full real-VM lifecycle (create -> exec -> checkpoint -> resume)
        # with a tiny 256M guest. QEMU needs unsandboxed execution, so this
        # check only exists on Linux — the attribute is omitted entirely on
        # darwin (a null value would make `nix flake check` fail). Run it
        # manually elsewhere:
        #   GONDOLIN_SDK=<host SDK entry> QEMU_BIN_DIR=<qemu bin dir> \
        #     node pkgs/ginger/tests/real-vm.test.mjs
        #
        # The guest downloads its assets over TLS at VM.create time. When
        # the build host routes traffic through a TLS-intercepting proxy,
        # propagate its extra CA bundle (impure on purpose — this check
        # needs network access anyway; use `nix build --impure`).
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          real-vm-check =
            let
              # PEM is base64 + BEGIN/END lines: no characters that need
              # escaping in a nix string, so it can be interpolated as-is.
              extraCaPem =
                let
                  p = builtins.getEnv "NODE_EXTRA_CA_CERTS";
                in
                if p != "" then (builtins.readFile p) else "";
              vmCheckEnv = {
                __noChroot = true;
                nativeBuildInputs = [ hostUnstable.nodejs ];
                GONDOLIN_SDK = "${
                  self.packages.${system}.gondolin
                }/lib/node_modules/@gondolin/host/dist/src/index.js";
                QEMU_BIN_DIR = "${hostUnstable.qemu}/bin:${hostUnstable.lz4}/bin";
              };
            in
            pkgs.runCommand "real-vm-check" vmCheckEnv ''
              ${pkgs.lib.optionalString (extraCaPem != "") ''
                # The CA file may live on a mount the builder cannot read,
                # so it is embedded at eval time and written to $TMPDIR.
                printf '%s\n' "${extraCaPem}" > "$TMPDIR/ginger-test-ca.crt"
                export NODE_EXTRA_CA_CERTS="$TMPDIR/ginger-test-ca.crt"
              ''}
              # The SDK caches guest images under $HOME/.cache/gondolin;
              # nix builds have no usable HOME, so give it a temp one.
              export HOME="$TMPDIR/ginger-test-home"
              mkdir -p "$HOME/.cache"
              mkdir -p $out
              node ${gingerSrc}/tests/real-vm.test.mjs
            '';
        }
      );
      devShells = forEachSupportedSystem (
        { pkgs }:
        let
          inherit (self.checks.${pkgs.stdenv.hostPlatform.system}.pre-commit-check) shellHook enabledPackages;
        in
        {
          default = pkgs.mkShell {
            inherit shellHook;
            buildInputs = (builtins.attrValues { inherit (pkgs) prek; }) ++ enabledPackages;
            packages = builtins.attrValues {
              inherit (pkgs)
                just
                nil
                nixfmt
                lz4
                e2fsprogs
                ;
            };
            env = {
              shell = "zsh";
              NIL_PATH = "${pkgs.nil}/bin/nil";
            };
          };
        }
      );
    };
}
