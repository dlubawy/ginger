#!/bin/sh
# pi-ginger.sh — manage the ginger-built pi agent configuration on a host.
#
# Modes (invoked by the `pi` and `pi-ginger-install` wrappers):
#   pi-ginger.sh run [args...]    prompt to install if the config is stale,
#                                 then exec the real pi
#   pi-ginger.sh install          install/refresh the config now (no prompt)
#
# The nix-built config is expected at $PI_GINGER_CONFIG/etc/pi/agent. The
# agent directory itself is $PI_CODING_AGENT_DIR (pi's own variable),
# falling back to ~/.pi/agent.
#
# Install rules — the agent dir holds session history and other runtime
# state, so nothing in it is ever deleted:
#   - extensions/, skills/, prompts/, themes/: ginger's files are copied
#     over; files the user added inside those trees are left alone.
#   - settings.json / models.json / formatters.json: installed as-is when
#     absent, otherwise deep-merged with the existing file where existing
#     (user) values win and new keys from ginger are added. Arrays are not
#     merged element-wise — the user's array wins.
#   - .ginger-version: sentinel recording which ginger version is installed.

set -eu

usage() {
  echo "usage: pi-ginger.sh <run|install> [args...]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
mode="$1"
shift

command -v jq >/dev/null 2>&1 || {
  echo "pi-ginger: jq is required but not on PATH" >&2
  exit 1
}
[ -n "${PI_GINGER_CONFIG:-}" ] && [ -d "$PI_GINGER_CONFIG/etc/pi/agent" ] || {
  echo "pi-ginger: PI_GINGER_CONFIG is not set or lacks etc/pi/agent" >&2
  exit 1
}

CONFIG_DIR="$PI_GINGER_CONFIG/etc/pi/agent"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CURRENT_VERSION="$(cat "$CONFIG_DIR/.ginger-version")"
INSTALLED_VERSION=""
[ -f "$AGENT_DIR/.ginger-version" ] &&
  INSTALLED_VERSION="$(cat "$AGENT_DIR/.ginger-version" 2>/dev/null || true)"

# Deep-merge two JSON documents to stdout: $1 is the base (new ginger
# config), $2 the override (existing user file). Objects merge
# recursively; for any other type (scalars, arrays) the override wins.
deep_merge() {
  jq -n --slurpfile base "$1" --slurpfile override "$2" '
    def m($a; $b):
      if ($a | type) == "object" and ($b | type) == "object" then
        reduce ($b | keys_unsorted[]) as $k
          ($a; .[$k] = (if has($k) then m(.[$k]; $b[$k]) else $b[$k] end))
      else $b end;
    m($base[0]; $override[0])'
}

install_config() {
  mkdir -p "$AGENT_DIR"

  # Directory trees: overwrite ginger's files, keep user additions. Copy the
  # directory itself (not 'src/.' — BSD cp nests it) into $AGENT_DIR: when
  # $AGENT_DIR/$d exists this merges into it, otherwise it creates it.
  for d in extensions skills prompts themes; do
    [ -d "$CONFIG_DIR/$d" ] || continue
    cp -r "$CONFIG_DIR/$d" "$AGENT_DIR/"
    # Nix store paths are read-only (0444 files, 0555 dirs) and cp without
    # -p copies those modes. A 0555 directory is not writable by its owner,
    # so nothing inside it could be removed or edited without sudo. Restore
    # owner write access (also repairs trees installed before this fix).
    chmod -R u+rwX "$AGENT_DIR/$d"
  done

  # JSON files: install as-is when absent, otherwise merge (user wins).
  for f in settings.json models.json formatters.json; do
    [ -f "$CONFIG_DIR/$f" ] || continue
    if [ ! -f "$AGENT_DIR/$f" ]; then
      cp "$CONFIG_DIR/$f" "$AGENT_DIR/$f"
      chmod u+rw "$AGENT_DIR/$f" # store files are 0444; keep them editable
      echo "pi-ginger: installed $f"
      continue
    fi
    tmp="$(mktemp)"
    if jq empty "$AGENT_DIR/$f" >/dev/null 2>&1; then
      if deep_merge "$CONFIG_DIR/$f" "$AGENT_DIR/$f" >"$tmp"; then
        mv "$tmp" "$AGENT_DIR/$f"
        echo "pi-ginger: merged $f (your values kept)"
      else
        rm -f "$tmp"
        echo "pi-ginger: WARNING: merge of $f failed; left untouched" >&2
      fi
    else
      rm -f "$tmp"
      echo "pi-ginger: WARNING: existing $f is not valid JSON; left untouched" >&2
    fi
  done

  printf '%s\n' "$CURRENT_VERSION" >"$AGENT_DIR/.ginger-version"
}

case "$mode" in
  install)
    if [ "$INSTALLED_VERSION" = "$CURRENT_VERSION" ]; then
      echo "pi-ginger: config already at v$CURRENT_VERSION"
      exit 0
    fi
    install_config
    echo "pi-ginger: installed ginger pi config v$CURRENT_VERSION to $AGENT_DIR"
    ;;
  run)
    if [ "$INSTALLED_VERSION" != "$CURRENT_VERSION" ]; then
      found="${INSTALLED_VERSION:-none}"
      if [ -t 0 ] && [ -t 1 ]; then
        printf 'pi-ginger: ginger pi config v%s not installed in %s (found: %s).\nInstall it now? [y/N] ' \
          "$CURRENT_VERSION" "$AGENT_DIR" "$found"
        read -r answer || answer=""
        case "$answer" in
          y | Y | yes | YES)
            install_config
            echo "pi-ginger: installed v$CURRENT_VERSION"
            ;;
          *)
            echo "pi-ginger: skipped (run 'pi-ginger-install' to install later)"
            ;;
        esac
      else
        echo "pi-ginger: ginger pi config v$CURRENT_VERSION not installed in $AGENT_DIR (found: $found); run 'pi-ginger-install'" >&2
      fi
    fi
    exec pi "$@"
    ;;
  *) usage ;;
esac
