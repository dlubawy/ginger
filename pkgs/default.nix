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
    x86_64-darwin = pkgs: {
      default =
        let
          containerPkgs = (
            import inputs.nixpkgs-unstable {
              system = "x86_64-linux";
            }
          );
        in
        pkgs.callPackage ./ginger {
          inherit pkgs containerPkgs;
        };
    };
    aarch64-linux = pkgs: {
      default = pkgs.callPackage ./ginger {
        inherit pkgs;
        containerPkgs = pkgs;
      };
      gondolin = pkgs.callPackage ./gondolin {
        pkgs = (import inputs.nixpkgs-unstable { system = "aarch64-linux"; });
      };
    };
    x86_64-linux = pkgs: {
      default = pkgs.callPackage ./ginger {
        inherit pkgs;
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
  allPackages.aarch64-darwin pkgs
  // allPackages.x86_64-darwin pkgs
  // allPackages.aarch64-linux pkgs
  // allPackages.x86_64-linux pkgs
