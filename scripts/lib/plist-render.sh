#!/bin/bash
# Cortex plist rendering helpers — sourced by postinstall.sh and postupgrade.sh.
#
# Both lifecycle scripts need to render the same launchd plists from the
# in-repo `__CORTEX_DIR__` / `__BUN_PATH__` / `__HOME__` / `__AGENT_NAME__`
# templates. Holly cortex#52 round 1 major: the sed block + awk extractor
# were duplicated near-verbatim in two places, so an edit to one and not the
# other would silently diverge install-vs-upgrade behaviour. Consolidated
# here so the divergence class of bug can't happen.
#
# Usage (in the calling script):
#   source "${SCRIPT_DIR}/lib/plist-render.sh"
#   render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CONFIG_DIR}"
#
# Exit codes:
#   0 — plists rendered (or non-Darwin host, skip silently from caller)
#   1 — bun not found in PATH (sed substitution would produce a broken plist)
#
# Functions never write outside `${LAUNCH_DIR}`.

# Resolve bun once with a clear error when missing. Holly cortex#52 round 1
# nit-2: unguarded `$(which bun)` would silently emit an empty <string></string>
# into the relay plist's ProgramArguments and crash-loop launchd with no
# useful error. Surface the failure here instead.
resolve_bun_path() {
  local bun_path
  bun_path="$(command -v bun 2>/dev/null || true)"
  if [ -z "${bun_path}" ]; then
    echo "  ⚠ bun not found in PATH — cannot render launchd plists" >&2
    echo "    Install bun (https://bun.sh) and re-run \`arc upgrade Cortex\`." >&2
    return 1
  fi
  printf '%s' "${bun_path}"
}

# Extract the first agent id from a cortex.yaml file. Falls back to "cortex"
# when the file is missing or the awk parse fails. Stays awk-only to avoid
# dragging in a yaml lib at install time.
#
# Output is validated against `^[a-zA-Z0-9_-]+$` — the same regex shape the
# cortex-config schema enforces on `agents[].id`. A name containing the sed
# delimiter `|`, the XML special chars `<` / `&`, or whitespace would
# silently emit a malformed plist when interpolated into the
# `<string>__AGENT_NAME__</string>` slot. Bailing here surfaces the bad
# config at install time with a pointed error message instead of letting
# launchd crash-loop a half-rendered plist (Holly cortex#52 round 3
# security warning).
extract_agent_name() {
  local cortex_yaml="$1"
  local name="cortex"
  if [ -f "${cortex_yaml}" ]; then
    name=$(awk '/^agents:/{found=1; next} found && /^[ \-]*id:/{sub(/.*id:[ ]*/, ""); gsub(/["'\'']/, ""); gsub(/#.*/, ""); print; exit}' "${cortex_yaml}" | xargs || true)
    name="${name:-cortex}"
  fi
  if ! [[ "${name}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "  ⚠ refusing to render plist: agent id \"${name}\" contains characters outside [a-zA-Z0-9_-]" >&2
    echo "    Fix the first \`agents[].id\` in ${cortex_yaml} (cortex-config schema requires lowercase alphanumeric + hyphen)." >&2
    return 1
  fi
  printf '%s' "${name}"
}

# Derive the stack slug from a cortex config filename.
#
#   cortex.yaml          → meta-factory   (special case — bare name is the default stack)
#   cortex.{slug}.yaml   → {slug}
#
# This is the single authoritative slug mapping used by all lifecycle scripts.
# cortex#700: centralised here so preupgrade/postupgrade/plist-render all agree.
config_file_to_slug() {
  local filename
  filename="$(basename "$1")"
  case "${filename}" in
    cortex.yaml)
      printf '%s' "meta-factory"
      ;;
    cortex.*.yaml)
      # Strip leading "cortex." and trailing ".yaml"
      local slug="${filename#cortex.}"
      slug="${slug%.yaml}"
      printf '%s' "${slug}"
      ;;
    *)
      # Unrecognised filename — caller should skip this file.
      return 1
      ;;
  esac
}

# Discover all stack slugs from config files under CONFIG_DIR.
# Prints one slug per line. Never includes the relay daemon.
#
# Args:
#   $1 CONFIG_DIR — directory containing cortex*.yaml files
discover_stack_slugs() {
  local config_dir="$1"
  # Use find + sort for deterministic ordering (glob expansion order is
  # filesystem-dependent on some macOS versions).
  while IFS= read -r cfg; do
    local slug
    if slug="$(config_file_to_slug "${cfg}")"; then
      printf '%s\n' "${slug}"
    fi
  done < <(find "${config_dir}" -maxdepth 1 -name 'cortex*.yaml' | sort)
}

# Render the plist for a single stack slug into LAUNCH_DIR. Idempotent —
# overwrites any previous render of the same filename.
#
# Slug-to-template mapping:
#   meta-factory → src/services/ai.meta-factory.cortex.meta-factory.plist
#                  (has __AGENT_NAME__ extracted from cortex.yaml)
#   work         → src/services/ai.meta-factory.cortex.work.plist
#   <other>      → src/services/ai.meta-factory.cortex.stack.plist
#                  (generic template; uses __STACK_SLUG__ + __CONFIG_FILE__)
#
# For any slug: if the config yaml is absent the plist is removed (same
# stale-plist guard as the original cortex#244 work-stack logic, now
# generalised to all stacks).
#
# Args:
#   $1 CORTEX_DIR — repo root
#   $2 LAUNCH_DIR — target dir (typically ${HOME}/Library/LaunchAgents)
#   $3 CONFIG_DIR — cortex config dir
#   $4 SLUG       — stack slug (e.g. meta-factory, work, halden)
#   $5 BUN_PATH   — pre-resolved bun binary path
render_stack_plist() {
  local cortex_dir="$1"
  local launch_dir="$2"
  local config_dir="$3"
  local slug="$4"
  local bun_path="$5"

  local dst="${launch_dir}/ai.meta-factory.cortex.${slug}.plist"

  # Derive config filename from slug (inverse of config_file_to_slug).
  local config_file
  if [ "${slug}" = "meta-factory" ]; then
    config_file="cortex.yaml"
  else
    config_file="cortex.${slug}.yaml"
  fi
  local config_yaml="${config_dir}/${config_file}"

  # If the config no longer exists, remove any stale rendered plist so
  # launchd doesn't crash-loop trying to start a daemon whose --config
  # target is missing. Idempotent: rm -f swallows no-such-file.
  if [ ! -f "${config_yaml}" ]; then
    if [ -f "${dst}" ]; then
      launchctl unload "${dst}" 2>/dev/null || true
      rm -f "${dst}"
      echo "  ⊘ ${slug} plist removed — ${config_file} not present (stack un-scaffolded)"
    else
      echo "  ⊘ ${slug} plist skipped — ${config_file} not present"
    fi
    return 0
  fi

  # Choose the right template and render.
  case "${slug}" in
    meta-factory)
      local src="${cortex_dir}/src/services/ai.meta-factory.cortex.meta-factory.plist"
      if [ ! -f "${src}" ]; then
        echo "  ⚠ Template missing: ${src}" >&2
        return 1
      fi
      local agent_name
      agent_name="$(extract_agent_name "${config_yaml}")" || return 1
      sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
          -e "s|__BUN_PATH__|${bun_path}|g" \
          -e "s|__HOME__|${HOME}|g" \
          -e "s|__AGENT_NAME__|${agent_name}|g" \
          "${src}" > "${dst}"
      echo "  ✓ meta-factory plist rendered → ${dst} (agent=${agent_name})"
      ;;
    work)
      local src="${cortex_dir}/src/services/ai.meta-factory.cortex.work.plist"
      if [ ! -f "${src}" ]; then
        echo "  ⚠ Template missing: ${src}" >&2
        return 1
      fi
      sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
          -e "s|__BUN_PATH__|${bun_path}|g" \
          -e "s|__HOME__|${HOME}|g" \
          "${src}" > "${dst}"
      echo "  ✓ work plist rendered → ${dst}"
      ;;
    *)
      # Generic stack — use the parameterised stack template.
      local src="${cortex_dir}/src/services/ai.meta-factory.cortex.stack.plist"
      if [ ! -f "${src}" ]; then
        echo "  ⚠ Template missing: ${src}" >&2
        return 1
      fi
      sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
          -e "s|__BUN_PATH__|${bun_path}|g" \
          -e "s|__HOME__|${HOME}|g" \
          -e "s|__STACK_SLUG__|${slug}|g" \
          -e "s|__CONFIG_FILE__|${config_file}|g" \
          "${src}" > "${dst}"
      echo "  ✓ ${slug} plist rendered → ${dst}"
      ;;
  esac
}

# Render plists for relay + all discovered stacks into ${LAUNCH_DIR}.
# Idempotent — overwrites any previous render of the same filename.
#
# cortex#700: stacks are now discovered from cortex*.yaml globs, not a
# hardcoded list. Adding a new stack = adding its config; no script edit
# needed.
#
# Args:
#   $1 CORTEX_DIR  — repo root (provides plist templates under src/services/)
#   $2 LAUNCH_DIR  — target dir (typically ${HOME}/Library/LaunchAgents)
#   $3 CONFIG_DIR  — cortex config dir (provides cortex*.yaml for discovery)
render_cortex_plists() {
  local cortex_dir="$1"
  local launch_dir="$2"
  local config_dir="$3"

  if [ "$(uname)" != "Darwin" ]; then
    return 0
  fi

  local bun_path
  bun_path="$(resolve_bun_path)" || return 1
  mkdir -p "${launch_dir}"

  # Relay plist — always present, separate from the stack loop.
  local relay_src="${cortex_dir}/src/services/ai.meta-factory.cortex.relay.plist"
  local relay_dst="${launch_dir}/ai.meta-factory.cortex.relay.plist"
  if [ -f "${relay_src}" ]; then
    sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
        -e "s|__BUN_PATH__|${bun_path}|g" \
        -e "s|__HOME__|${HOME}|g" \
        "${relay_src}" > "${relay_dst}"
    echo "  ✓ Relay plist rendered → ${relay_dst}"
  fi

  # Stack plists — one per discovered cortex*.yaml config (cortex#700).
  # cortex.yaml → meta-factory, cortex.{slug}.yaml → {slug}
  local rendered_count=0
  while IFS= read -r slug; do
    render_stack_plist "${cortex_dir}" "${launch_dir}" "${config_dir}" "${slug}" "${bun_path}" || true
    rendered_count=$((rendered_count + 1))
  done < <(discover_stack_slugs "${config_dir}")

  if [ "${rendered_count}" -eq 0 ]; then
    echo "  ⚠ No cortex*.yaml configs found in ${config_dir} — no stack plists rendered" >&2
  fi
}
