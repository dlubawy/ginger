{ pkgs, ... }:
let
  inherit (pkgs) writeTextFile symlinkJoin lib;
  piHome = "/etc/pi";
  piConfig = writeTextFile {
    name = "piConfig";
    text = (builtins.readFile ./settings.json);
    destination = "${piHome}/agent/settings.json";
  };
  piModels = writeTextFile {
    name = "piModels";
    text = (builtins.readFile ./models.json);
    destination = "${piHome}/agent/models.json";
  };
  piFormatters = writeTextFile {
    name = "piFormatters";
    text = (builtins.readFile ./formatters.json);
    destination = "${piHome}/agent/formatters.json";
  };
  piThemes = pkgs.stdenv.mkDerivation {
    name = "themes";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = ./themes;
    };
    postInstall = ''
      mkdir -p $out${piHome}/agent
      cp -R ./themes $out${piHome}/agent/themes
    '';
  };
  piSkills = pkgs.stdenv.mkDerivation {
    name = "skills";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = ./skills;
    };
    postInstall = ''
      mkdir -p $out${piHome}/agent
      cp -R ./skills $out${piHome}/agent/skills
    '';
  };
  piPrompts = pkgs.stdenv.mkDerivation {
    name = "prompts";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = ./prompts;
    };
    postInstall = ''
      mkdir -p $out${piHome}/agent
      cp -R ./prompts $out${piHome}/agent/prompts
    '';
  };
  piExtensions = pkgs.stdenv.mkDerivation {
    name = "extensions";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = ./extensions;
    };
    postInstall = ''
      mkdir -p $out${piHome}/agent
      cp -R ./extensions $out${piHome}/agent/extensions
    '';
  };
in
symlinkJoin {
  name = "piHome";
  paths = [
    piConfig
    piFormatters
    piThemes
    piModels
    piPrompts
    piSkills
    piExtensions
  ];
}
