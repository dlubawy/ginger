{
  pkgs,
  containerPkgs,
  gondolin,
  ...
}:
let
  inherit (pkgs)
    writeShellApplication
    ;

  version = "0.0.1";
  piHome = (import ./pi { inherit pkgs; });
  gondolinImage = (
    import ./gondolin-image {
      inherit
        pkgs
        containerPkgs
        gondolin
        version
        piHome
        ;
    }
  );
in
{
  gingerBin = writeShellApplication {
    name = "ginger";
    runtimeInputs = with pkgs; [
      gawk
      gnugrep
      gondolin
      jq
      podman
    ];
    runtimeEnv = {
      GONDOLIN_DEFAULT_IMAGE = "ginger-env:v${version}";
      GONDOLIN_VMM = "qemu";
    };
    text = ''
      if [ -z "$(ls -A "$HOME/.cache/gondolin/sessions")" ]; then
        gingerSession=""
      else
        read -r gingerSession < <(jq -s -r '.[] | select(.label | contains("GINGER_VERSION=${version}")) | .id' "$HOME"/.cache/gondolin/sessions/*.json 2>/dev/null | tr -s '[:blank:]')
      fi
      removeImage=""
      agentExec=""
      runPi=""
      stop=""
      direnvAllow=""
      # snap=""
      gondolinEnvOpts=("--env" "GINGER_VERSION=${version}")
      gondolinVMOpts=("--mount-hostfs" "/nix/store:/.ro-nix/store:ro" "--tcp-map" "unsloth.local=127.0.0.1:8888")
      positionalArgs=()
      while [ $# -gt 0 ]; do
        case "$1" in
          -h|--help)
            cat << EOF
      Ginger agent

      Description:
        A tool for managing an LLM agent in a spicy root container using a gondolin micro VM.

      Usage:
        ginger [options]

      Examples:
        ginger -w /home/user/code-project
        ginger -p 3000:3000

      Options:
        -d,--direnv             Allow direnv in workspace
        -e, --exec              Execute prompt in non-interactive mode
        --rmi                   Removes the image when done
        -l,--listen             Allow ingress into the VM
        -w, --workspace string  Workspace to mount in VM

      EOF
            exit 0
          ;;
          -l|--listen)
            gondolinVMOpts+=("--listen")
            shift 2
          ;;
          -d|--direnv)
            direnvAllow="true"
            shift
          ;;
          --rmi)
            removeImage="true"
            shift
          ;;
          -w|--workspace)
            workingDir="$2"
            gondolinEnvOpts+=("--cwd" "/workspace/$(basename "$workingDir")")
            gondolinVMOpts+=("--mount-hostfs" "$workingDir:/workspace/$(basename "$workingDir")")
            shift 2
          ;;
          --workspace=*)
            workingDir="''${1/*=/}"
            gondolinEnvOpts+=("--cwd" "/workspace/$(basename "$workingDir")")
            gondolinVMOpts+=("--mount-hostfs" "$workingDir:/workspace/$(basename "$workingDir")")
            shift
          ;;
          -e|--exec)
            agentExec="true"
            shift
          ;;
          --pi)
            runPi="true"
            shift
          ;;
          --stop)
            stop="true"
            shift
          ;;
          # --snap)
          #   snap="true"
          #   shift
          # ;;
          -*)
            printf "'%s' is not a valid command\n" "$1" >&2
            exit 1
          ;;
          *)
            positionalArgs+=("$1")
            shift
          ;;
        esac
      done

      set -- "''${positionalArgs[@]}"

      if [ -f "$HOME/.pi/agent/auth.json" ]; then
        printf "[WARNING]: Using unsloth API key in VM\n"
        read -r unslothKey < <(jq -r '.unsloth.key' "$HOME/.pi/agent/auth.json")
        gondolinEnvOpts+=("--env" "UNSLOTH_API_KEY=$unslothKey")
      fi

      containerImageId="$(podman images -n localhost/gondolin-image:v${version} | tail -n 1 | awk -F' ' '{print $3}' | tr -s '[:blank:]')"
      if [ -z "$containerImageId" ]; then
        printf "Loading base container image..."
        podman image load -i ${gondolinImage}/gondolin-image.tar > /dev/null 2>&1
        printf "\rdone...........................\n\n"
      fi
      set +o errexit
      agentImage="$(gondolin image ls | grep -o "$GONDOLIN_DEFAULT_IMAGE" | tr -s '[:blank:]')"
      if [ -z "$agentImage" ]; then
        printf "Creating gondolin VM..."
        gondolin build --tag "$GONDOLIN_DEFAULT_IMAGE" --config ${gondolinImage}/build-config.json > /dev/null 2>&1
        printf "\rdone...................\n\n"
      fi
      set -o errexit

      if [ -z "$gingerSession" ]; then
        set +o errexit
        printf "Starting gondolin VM session..."
        gondolin bash "''${gondolinVMOpts[@]}" "''${gondolinEnvOpts[@]}" > /dev/null &
        gondolinPid="$!"
        printf "\rdone...........................\n\n"
        sleep 2
        read -r gingerSession < <(jq -s -r '.[] | select(.pid | contains('"$gondolinPid"')) | .id' "$HOME"/.cache/gondolin/sessions/*.json)
        printf 'Session ID: %s\n' "$gingerSession"
        set -o errexit
      fi

      if [ -n "$direnvAllow" ]; then
        gondolin attach "''${gondolinEnvOpts[@]}" "$gingerSession" -- direnv allow
      fi

      if [ -n "$stop" ]; then
        gondolin exec --sock "$gingerSession" -- poweroff -f
      elif [ -n "$agentExec" ]; then
        gondolin exec --sock "$gingerSession" "''${gondolinVMOpts[@]}" "''${gondolinEnvOpts[@]}" -- "$*"
      elif [ -n "$runPi" ]; then
        gondolin attach "''${gondolinEnvOpts[@]}" "$gingerSession" -- /bin/pi
      else
        gondolin attach "''${gondolinEnvOpts[@]}" "$gingerSession"
      fi

      if [ -n "$removeImage" ]; then
        podman image rm gondolin-image:v${version}
        gondolin image rm "$GONDOLIN_DEFAULT_IMAGE"
      fi
    '';
  };
}
