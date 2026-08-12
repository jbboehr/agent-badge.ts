{
  lib,
  bubblewrap,
  cacert,
  closureInfo,
  gh,
  gitMinimal,
  writeShellApplication,
  writeShellScript,
  agent-badge-unwrapped,
}:

let
  agentBadgeDirectories = agent-badge-unwrapped.agentBadgeDirectories;
  authenticatedEntrypoint = writeShellScript "agent-badge-authenticated" ''
    if [[ ! -r /run/secrets/gh-token ]]; then
      echo "agent-badge: GitHub token was not provided to the sandbox" >&2
      exit 1
    fi

    IFS= read -r GH_TOKEN < /run/secrets/gh-token
    if [[ -z "$GH_TOKEN" ]]; then
      echo "agent-badge: GitHub token provided to the sandbox is empty" >&2
      exit 1
    fi

    export GH_TOKEN
    exec ${agent-badge-unwrapped}/bin/agent-badge "$@"
  '';
  runtimePackages = [
    agent-badge-unwrapped
    authenticatedEntrypoint
    cacert
    gh
    gitMinimal
  ];
  runtimeClosure = closureInfo { rootPaths = runtimePackages; };
  runtimePath = lib.makeBinPath [
    agent-badge-unwrapped
    gh
    gitMinimal
  ];
in
writeShellApplication {
  name = "agent-badge";

  text = ''
    readonly host_home="''${HOME-}"
    if [[ "$host_home" == /* && "$host_home" != "/" ]]; then
      readonly sandbox_home="$host_home"
    else
      readonly sandbox_home="/home/agent-badge"
    fi
    readonly command_name="''${1-}"
    readonly subcommand_name="''${2-}"
    readonly config_key="''${3-}"

    project_access="none"
    needs_auth="false"
    needs_network="false"
    provider_access="none"

    # Select the narrowest host view that supports each CLI command.
    case "$command_name" in
      init)
        project_access="repo-rw"
        needs_auth="true"
        needs_network="true"
        provider_access="pricing"
        ;;
      scan)
        project_access="agent-rw-git-ro"
        provider_access="history"
        ;;
      publish | refresh)
        project_access="agent-rw-git-ro"
        needs_auth="true"
        needs_network="true"
        provider_access="pricing"
        ;;
      status)
        project_access="agent-ro"
        needs_network="true"
        ;;
      doctor)
        project_access="doctor-ro"
        needs_auth="true"
        needs_network="true"
        provider_access="presence"
        ;;
      uninstall)
        project_access="repo-rw"
        for argument in "$@"; do
          if [[ "$argument" == "--purge-remote" ]]; then
            needs_auth="true"
            needs_network="true"
          fi
        done
        ;;
      config)
        if [[ "$subcommand_name" != "set" ]]; then
          project_access="agent-ro"
        elif [[ "$config_key" == "refresh.prePush.enabled" || "$config_key" == "refresh.prePush.mode" ]]; then
          project_access="repo-rw"
        else
          project_access="agent-rw"
        fi
        ;;
    esac

    for argument in "$@"; do
      if [[ "$argument" == "--help" || "$argument" == "-h" ]]; then
        project_access="none"
        needs_auth="false"
        needs_network="false"
        provider_access="none"
      fi
    done

    sandbox_args=(
      --unshare-all
      --unshare-user
      --disable-userns
      --die-with-parent
      --new-session
      --hostname agent-badge
      --clearenv
      --dir /nix
      --dir /nix/store
      --dir /etc
      --dir /home
      --dir "$sandbox_home"
      --dir "$sandbox_home/.config"
      --dir "$sandbox_home/.config/gh"
      --proc /proc
      --dev /dev
      --tmpfs /tmp
      --setenv HOME "$sandbox_home"
      --setenv XDG_CONFIG_HOME "$sandbox_home/.config"
      --setenv GH_CONFIG_DIR "$sandbox_home/.config/gh"
      --setenv LANG C.UTF-8
      --setenv LC_ALL C.UTF-8
      --setenv PATH ${lib.escapeShellArg runtimePath}
      --setenv SSL_CERT_FILE ${lib.escapeShellArg "${cacert}/etc/ssl/certs/ca-bundle.crt"}
      --setenv NIX_SSL_CERT_FILE ${lib.escapeShellArg "${cacert}/etc/ssl/certs/ca-bundle.crt"}
      --setenv GIT_CONFIG_NOSYSTEM 1
    )

    # Commands that do not publish or inspect GitHub remain network-isolated.
    if [[ "$needs_network" == "true" ]]; then
      sandbox_args+=(
        --share-net
        --ro-bind-try /etc/hosts /etc/hosts
        --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf
        --ro-bind-try /etc/resolv.conf /etc/resolv.conf
      )
    fi

    # Expose only the package's runtime closure, not the complete Nix store.
    while IFS= read -r store_path; do
      sandbox_args+=(--ro-bind "$store_path" "$store_path")
    done < ${runtimeClosure}/store-paths

    for environment_name in TERM COLORTERM NO_COLOR FORCE_COLOR CI AGENT_BADGE_HOME_NORMALIZATION; do
      if [[ -v "$environment_name" ]]; then
        sandbox_args+=(--setenv "$environment_name" "''${!environment_name}")
      fi
    done

    if [[ "$needs_network" == "true" ]]; then
      for environment_name in ALL_PROXY HTTPS_PROXY HTTP_PROXY NO_PROXY all_proxy https_proxy http_proxy no_proxy; do
        if [[ -v "$environment_name" ]]; then
          sandbox_args+=(--setenv "$environment_name" "''${!environment_name}")
        fi
      done
    fi

    if [[ "$needs_auth" == "true" ]]; then
      github_token=""

      for environment_name in GH_TOKEN GITHUB_TOKEN GITHUB_PAT; do
        if [[ -n "''${!environment_name-}" ]]; then
          github_token="''${!environment_name}"
          break
        fi
      done

      if [[ -z "$github_token" ]]; then
        if [[ -n "''${GH_HOST-}" ]]; then
          github_token="$(${gh}/bin/gh auth token --hostname "$GH_HOST" 2>/dev/null || true)"
        else
          github_token="$(${gh}/bin/gh auth token 2>/dev/null || true)"
        fi
      fi

      if [[ -z "$github_token" ]]; then
        echo "agent-badge: GitHub authentication is required for '$command_name'" >&2
        echo "agent-badge: export GH_TOKEN or authenticate the host GitHub CLI with 'gh auth login'" >&2
        exit 1
      fi

      if [[ "$github_token" == *$'\n'* || "$github_token" == *$'\r'* ]]; then
        echo "agent-badge: refusing a GitHub token containing a line break" >&2
        exit 1
      fi

      exec {github_token_fd}<<<"$github_token"
      unset github_token
      sandbox_args+=(
        --dir /run
        --dir /run/secrets
        --perms 0400
        --ro-bind-data "$github_token_fd" /run/secrets/gh-token
      )

      if [[ -n "''${GH_HOST-}" ]]; then
        sandbox_args+=(--setenv GH_HOST "$GH_HOST")
      fi
    fi

    resolve_provider_directory() {
      local environment_name="$1"
      local default_directory="$2"
      local candidate="$default_directory"

      resolved_provider_directory=""
      if [[ -n "''${!environment_name-}" ]]; then
        candidate="''${!environment_name}"

        if [[ "$candidate" != /* ]]; then
          echo "agent-badge: $environment_name must contain an absolute path" >&2
          exit 1
        fi

        if [[ ! -d "$candidate" ]]; then
          echo "agent-badge: $environment_name does not name an accessible directory: $candidate" >&2
          exit 1
        fi
      elif [[ -z "$candidate" || ! -d "$candidate" ]]; then
        return
      fi

      if ! resolved_provider_directory="$(cd "$candidate" && pwd -P)"; then
        echo "agent-badge: unable to resolve $environment_name directory: $candidate" >&2
        exit 1
      fi

      if [[ "$resolved_provider_directory" == "/" ]]; then
        echo "agent-badge: refusing to use the filesystem root for $environment_name" >&2
        exit 1
      fi
    }

    mount_provider_directory() {
      local host_directory="$1"
      local sandbox_directory="$2"

      if [[ -d "$host_directory" && ! -L "$host_directory" ]]; then
        sandbox_args+=(--ro-bind "$host_directory" "$sandbox_directory")
      fi
    }

    # Never expose provider credentials or configuration. The scanner sees only
    # the history inputs each adapter reads, at its conventional sandbox path.
    if [[ "$provider_access" != "none" ]]; then
      default_codex_home=""
      default_claude_home=""
      default_grok_home=""
      if [[ -n "$host_home" ]]; then
        default_codex_home="$host_home/.codex"
        default_claude_home="$host_home/.claude"
        default_grok_home="$host_home/.grok"
      fi

      resolve_provider_directory AGENT_BADGE_CODEX_DIR "$default_codex_home"
      host_codex_home="$resolved_provider_directory"
      if [[ -n "$host_codex_home" ]]; then
        sandbox_args+=(--dir "$sandbox_home/.codex")
        sandbox_args+=(--setenv AGENT_BADGE_CODEX_DIR "$sandbox_home/.codex")

        if [[ "$provider_access" == "history" || "$provider_access" == "pricing" ]]; then
          shopt -s nullglob
          for codex_file in \
            "$host_codex_home"/history.jsonl \
            "$host_codex_home"/state_[0-9]*.sqlite; do
            if [[ -f "$codex_file" && ! -L "$codex_file" ]]; then
              sandbox_args+=(--ro-bind "$codex_file" "$sandbox_home/.codex/''${codex_file##*/}")
            fi
          done
          shopt -u nullglob
        fi

        if [[ "$provider_access" == "pricing" ]]; then
          shopt -s nullglob
          for codex_file in "$host_codex_home"/rollout-*.jsonl; do
            if [[ -f "$codex_file" && ! -L "$codex_file" ]]; then
              sandbox_args+=(--ro-bind "$codex_file" "$sandbox_home/.codex/''${codex_file##*/}")
            fi
          done
          shopt -u nullglob

          mount_provider_directory "$host_codex_home/sessions" "$sandbox_home/.codex/sessions"
          mount_provider_directory "$host_codex_home/archived_sessions" "$sandbox_home/.codex/archived_sessions"
        fi
      fi

      resolve_provider_directory AGENT_BADGE_CLAUDE_DIR "$default_claude_home"
      host_claude_home="$resolved_provider_directory"
      if [[ -n "$host_claude_home" ]]; then
        sandbox_args+=(--dir "$sandbox_home/.claude")
        sandbox_args+=(--setenv AGENT_BADGE_CLAUDE_DIR "$sandbox_home/.claude")

        if [[ "$provider_access" == "history" || "$provider_access" == "pricing" ]]; then
          mount_provider_directory "$host_claude_home/projects" "$sandbox_home/.claude/projects"
        fi
      fi

      grok_environment_name="AGENT_BADGE_GROK_DIR"
      if [[ -z "''${AGENT_BADGE_GROK_DIR-}" && -n "''${GROK_HOME-}" ]]; then
        grok_environment_name="GROK_HOME"
      fi
      resolve_provider_directory "$grok_environment_name" "$default_grok_home"
      host_grok_home="$resolved_provider_directory"
      if [[ -n "$host_grok_home" ]]; then
        sandbox_args+=(--dir "$sandbox_home/.grok")
        sandbox_args+=(--setenv AGENT_BADGE_GROK_DIR "$sandbox_home/.grok")

        if [[ "$provider_access" == "history" || "$provider_access" == "pricing" ]]; then
          mount_provider_directory "$host_grok_home/sessions" "$sandbox_home/.grok/sessions"
        fi
      fi
    fi

    readonly agent_badge_directories=( ${lib.escapeShellArgs agentBadgeDirectories} )

    mount_agent_badge_directories() {
      local access="$1"
      local agent_badge_directory
      local agent_badge_parent_directory
      local agent_badge_relative_directory
      local found="false"

      for agent_badge_relative_directory in "''${agent_badge_directories[@]}"; do
        agent_badge_directory="$project_root/$agent_badge_relative_directory"
        agent_badge_parent_directory="''${agent_badge_directory%/*}"

        if [[ -L "$agent_badge_directory" ]]; then
          echo "agent-badge: refusing a symlinked $agent_badge_relative_directory directory" >&2
          exit 1
        fi

        if [[ "$agent_badge_parent_directory" != "$project_root" && -L "$agent_badge_parent_directory" ]]; then
          echo "agent-badge: refusing a symlinked parent for $agent_badge_relative_directory" >&2
          exit 1
        fi

        if [[ ! -d "$agent_badge_directory" ]]; then
          continue
        fi

        found="true"
        if [[ "$agent_badge_parent_directory" != "$project_root" ]]; then
          sandbox_args+=(--dir "$agent_badge_parent_directory")
        fi

        if [[ "$access" == "rw" ]]; then
          sandbox_args+=(--bind "$agent_badge_directory" "$agent_badge_directory")
        else
          sandbox_args+=(--ro-bind "$agent_badge_directory" "$agent_badge_directory")
        fi
      done

      if [[ "$access" == "rw" && "$found" != "true" ]]; then
        echo "agent-badge: neither .github/agent-badge nor .agent-badge is initialized in $project_root" >&2
        exit 1
      fi
    }

    mount_external_git_directory() {
      local candidate="$1"

      if [[ ! -d "$candidate" ]]; then
        return
      fi

      candidate="$(cd "$candidate" && pwd -P)"
      case "$candidate" in
        "$project_root" | "$project_root"/*)
          return
          ;;
      esac

      if [[ "''${mounted_git_directories-}" == *"|$candidate|"* ]]; then
        return
      fi

      mounted_git_directories="''${mounted_git_directories-}|$candidate|"
      sandbox_args+=(--dir "$candidate" --ro-bind "$candidate" "$candidate")
    }

    mount_git_metadata() {
      local mount_project_git_entry="$1"
      local mount_hook="$2"
      local git_entry="$project_root/.git"
      local git_directory=""
      local git_common_directory=""

      if [[ -L "$git_entry" ]]; then
        echo "agent-badge: refusing symlinked Git metadata at $git_entry" >&2
        exit 1
      fi

      if [[ "$mount_project_git_entry" == "true" && -f "$git_entry" ]]; then
        sandbox_args+=(--ro-bind "$git_entry" "$git_entry")
      elif [[ "$mount_project_git_entry" == "true" && -d "$git_entry" ]]; then
        sandbox_args+=(
          --dir "$git_entry"
          --dir "$git_entry/objects"
          --dir "$git_entry/refs"
          --dir "$git_entry/refs/heads"
          --dir "$git_entry/refs/tags"
        )

        for git_file in HEAD config; do
          if [[ -f "$git_entry/$git_file" && ! -L "$git_entry/$git_file" ]]; then
            sandbox_args+=(--ro-bind "$git_entry/$git_file" "$git_entry/$git_file")
          fi
        done

        if [[ "$mount_hook" == "true" && -f "$git_entry/hooks/pre-push" && ! -L "$git_entry/hooks/pre-push" ]]; then
          sandbox_args+=(
            --dir "$git_entry/hooks"
            --ro-bind "$git_entry/hooks/pre-push" "$git_entry/hooks/pre-push"
          )
        fi
      fi

      git_directory="$(${gitMinimal}/bin/git -C "$project_root" rev-parse --absolute-git-dir 2>/dev/null || true)"
      git_common_directory="$(${gitMinimal}/bin/git -C "$project_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
      mount_external_git_directory "$git_directory"
      mount_external_git_directory "$git_common_directory"
    }

    if [[ "$project_access" == "none" ]]; then
      sandbox_args+=(--chdir /)
    else
      host_cwd="$(pwd -P)"
      project_root="$(${gitMinimal}/bin/git -C "$host_cwd" rev-parse --show-toplevel 2>/dev/null || true)"

      if [[ -n "$project_root" && -d "$project_root" ]]; then
        project_root="$(cd "$project_root" && pwd -P)"
      else
        project_root="$host_cwd"
      fi

      if [[ "$project_root" == "/" ]]; then
        echo "agent-badge: refusing to expose the filesystem root as a project" >&2
        exit 1
      fi

      sandbox_args+=(--dir "$project_root" --chdir "$project_root")

      case "$project_access" in
        repo-rw)
          sandbox_args+=(--bind "$project_root" "$project_root")
          mount_git_metadata false false
          ;;
        agent-rw-git-ro)
          mount_agent_badge_directories rw
          mount_git_metadata true false
          ;;
        agent-rw)
          mount_agent_badge_directories rw
          ;;
        agent-ro)
          mount_agent_badge_directories ro
          ;;
        doctor-ro)
          mount_agent_badge_directories ro
          mount_git_metadata true true

          shopt -s nullglob
          for project_file in \
            "$project_root"/[Rr][Ee][Aa][Dd][Mm][Ee]* \
            "$project_root"/pnpm-lock.yaml \
            "$project_root"/yarn.lock \
            "$project_root"/bun.lockb \
            "$project_root"/bun.lock \
            "$project_root"/package-lock.json \
            "$project_root"/npm-shrinkwrap.json; do
            if [[ -f "$project_file" && ! -L "$project_file" ]]; then
              sandbox_args+=(--ro-bind "$project_file" "$project_file")
            fi
          done
          shopt -u nullglob
          ;;
      esac
    fi

    if [[ "$needs_auth" == "true" ]]; then
      exec ${bubblewrap}/bin/bwrap "''${sandbox_args[@]}" -- \
        ${authenticatedEntrypoint} "$@"
    fi

    exec ${bubblewrap}/bin/bwrap "''${sandbox_args[@]}" -- \
      ${agent-badge-unwrapped}/bin/agent-badge "$@"
  '';

  derivationArgs = {
    passthru.unwrapped = agent-badge-unwrapped;
    meta = {
      description = "Bubblewrap-confined agent-badge CLI";
      inherit (agent-badge-unwrapped.meta) homepage license;
      mainProgram = "agent-badge";
      platforms = lib.platforms.linux;
    };
  };
}
