system: inputs:
let
  allPackages = {
    aarch64-darwin =
      pkgs:
      let
        containerPkgs =
          (import inputs.nixpkgs-unstable {
            system = "aarch64-linux";
          })
          // {
            gondolin = pkgs.callPackage ./gondolin {
              pkgs = (import inputs.nixpkgs-unstable { system = "aarch64-linux"; });
            };
          };
      in
      rec {
        gondolin = pkgs.callPackage ./gondolin {
          pkgs = (import inputs.nixpkgs-unstable { system = "aarch64-darwin"; });
        };
        default = pkgs.callPackage ./ginger {
          inherit
            pkgs
            containerPkgs
            gondolin
            ;
        };
      };
    aarch64-linux = pkgs: rec {
      gondolin = pkgs.callPackage ./gondolin {
        pkgs = (import inputs.nixpkgs-unstable { system = "aarch64-linux"; });
      };
      default = pkgs.callPackage ./ginger {
        inherit pkgs gondolin;
        containerPkgs = pkgs;
      };
    };
    x86_64-linux = pkgs: rec {
      gondolin = pkgs.callPackage ./gondolin {
        pkgs = (import inputs.nixpkgs-unstable { system = "aarch64-linux"; });
      };
      default = pkgs.callPackage ./ginger {
        inherit pkgs gondolin;
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
