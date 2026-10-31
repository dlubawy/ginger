system: inputs:
let
  allPackages = {
    aarch64-darwin =
      pkgs:
      let
        unstablePkgs = (import inputs.nixpkgs-unstable { system = "aarch64-darwin"; });
        containerPkgs =
          let
            containerPkgs = (import inputs.nixpkgs-unstable { system = "aarch64-linux"; });
          in
          containerPkgs
          // {
            gondolin = pkgs.callPackage ./gondolin {
              pkgs = containerPkgs;
            };
            playwright-cli = pkgs.callPackage ./playwright-cli {
              pkgs = containerPkgs;
            };
          };
        gondolin = pkgs.callPackage ./gondolin {
          pkgs = unstablePkgs;
        };
        pi = unstablePkgs.pi-coding-agent;
        playwright-cli = pkgs.callPackage ./playwright-cli {
          pkgs = unstablePkgs;
        };
      in
      {
        inherit gondolin playwright-cli;
        default = pkgs.callPackage ./ginger {
          inherit
            pkgs
            containerPkgs
            gondolin
            pi
            ;
        };
      };
    aarch64-linux =
      pkgs:
      let
        unstablePkgs = (import inputs.nixpkgs-unstable { system = "aarch64-linux"; });
        gondolin = pkgs.callPackage ./gondolin {
          pkgs = (import inputs.nixpkgs-unstable { system = "aarch64-linux"; });
        };
        pi = unstablePkgs.pi-coding-agent;
        playwright-cli = pkgs.callPackage ./playwright-cli {
          pkgs = unstablePkgs;
        };
      in
      {
        inherit gondolin playwright-cli;
        default = pkgs.callPackage ./ginger {
          inherit pkgs gondolin pi;
          containerPkgs = pkgs;
        };
      };
    x86_64-linux =
      pkgs:
      let
        unstablePkgs = (import inputs.nixpkgs-unstable { system = "x86_64-linux"; });
        gondolin = pkgs.callPackage ./gondolin {
          pkgs = (import inputs.nixpkgs-unstable { system = "x86_64-linux"; });
        };
        pi = unstablePkgs.pi-coding-agent;
        playwright-cli = pkgs.callPackage ./playwright-cli {
          pkgs = unstablePkgs;
        };
      in
      {
        inherit gondolin playwright-cli;
        default = pkgs.callPackage ./ginger {
          inherit pkgs gondolin pi;
          containerPkgs = pkgs;
        };
      };
  };
in
if builtins.hasAttr system allPackages then
  allPackages.${system}
else
  # TODO: make this cleaner
  pkgs:
  allPackages.aarch64-darwin pkgs // allPackages.aarch64-linux pkgs // allPackages.x86_64-linux pkgs
