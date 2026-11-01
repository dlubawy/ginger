{ pkgs, version }:
let
  inherit (pkgs) lib;
  # Directory trees are taken as filesets so untracked files (editor cruft,
  # OS metadata) don't break the build. Note each store path wraps the tree
  # in a directory of its own name, hence the '/<name>' on the copies below.
  extensions = lib.fileset.toSource {
    root = ./.;
    fileset = ./extensions;
  };
  skills = lib.fileset.toSource {
    root = ./.;
    fileset = ./skills;
  };
  prompts = lib.fileset.toSource {
    root = ./.;
    fileset = ./prompts;
  };
  themes = lib.fileset.toSource {
    root = ./.;
    fileset = ./themes;
  };
in
# The ginger-built pi agent configuration, laid out as etc/pi/agent so the
# same output can be dropped into the gondolin image at /etc/pi/agent and
# installed onto a host at ~/.pi/agent (see ../default.nix's pi wrapper).
pkgs.runCommand "pi-agent-config-${version}" { } ''
  mkdir -p $out/etc/pi/agent
  install -m 0644 ${./settings.json}    $out/etc/pi/agent/settings.json
  install -m 0644 ${./models.json}      $out/etc/pi/agent/models.json
  install -m 0644 ${./formatters.json}  $out/etc/pi/agent/formatters.json
  cp -r ${extensions}/extensions $out/etc/pi/agent/extensions
  cp -r ${skills}/skills         $out/etc/pi/agent/skills
  cp -r ${prompts}/prompts       $out/etc/pi/agent/prompts
  cp -r ${themes}/themes         $out/etc/pi/agent/themes
  # Sentinel: the host wrapper compares this against
  # ~/.pi/agent/.ginger-version to decide when to offer an update.
  echo "${version}" >$out/etc/pi/agent/.ginger-version
''
