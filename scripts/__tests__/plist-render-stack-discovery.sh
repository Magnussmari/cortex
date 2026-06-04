#!/bin/bash
# cortex#700 — unit tests for stack discovery + plist rendering in plist-render.sh.
#
# Tests run entirely in tmp fixtures; no live ~/.config/cortex is touched and
# launchctl is never invoked (mocked via PATH override).
#
# Run:
#   bash scripts/__tests__/plist-render-stack-discovery.sh
#
# Exit code: 0 = all pass, non-zero = failure count.

set -euo pipefail

# ─── Test harness ─────────────────────────────────────────────────
PASS=0
FAIL=0

pass() { printf '  ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "${expected}" = "${actual}" ]; then
    pass "${label}"
  else
    fail "${label}: expected «${expected}» got «${actual}»"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "${haystack}" | grep -qF "${needle}"; then
    pass "${label}"
  else
    fail "${label}: expected «${needle}» in «${haystack}»"
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if ! printf '%s\n' "${haystack}" | grep -qF "${needle}"; then
    pass "${label}"
  else
    fail "${label}: did NOT expect «${needle}» in «${haystack}»"
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "${path}" ]; then
    pass "${label}"
  else
    fail "${label}: file not found: ${path}"
  fi
}

assert_file_not_exists() {
  local label="$1" path="$2"
  if [ ! -f "${path}" ]; then
    pass "${label}"
  else
    fail "${label}: expected file absent but found: ${path}"
  fi
}

# ─── Fixtures ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Source the lib (uname guard in render_cortex_plists will short-circuit on
# non-Darwin hosts; we test lower-level functions directly so that's fine).
source "${SCRIPT_DIR}/lib/plist-render.sh"

# Temp workspace — cleaned up on EXIT.
TMPBASE="$(mktemp -d)"
trap 'rm -rf "${TMPBASE}"' EXIT

CONFIG_DIR="${TMPBASE}/config"
LAUNCH_DIR="${TMPBASE}/LaunchAgents"
mkdir -p "${CONFIG_DIR}" "${LAUNCH_DIR}"

# Mock bun: the real bun isn't needed for slug/render tests; we provide a
# stub that prints a deterministic path so sed substitution works without
# requiring bun to be installed.
MOCK_BIN="${TMPBASE}/mock-bin"
mkdir -p "${MOCK_BIN}"
printf '#!/bin/sh\nprintf "%s" "%s"\n' "${MOCK_BIN}/bun" > "${MOCK_BIN}/bun"
chmod +x "${MOCK_BIN}/bun"

# Mock launchctl: never actually invoke launchctl — just emit a trace line
# so tests can assert it was (or wasn't) called.
LAUNCHCTL_LOG="${TMPBASE}/launchctl.log"
cat > "${MOCK_BIN}/launchctl" <<'EOF'
#!/bin/sh
printf 'launchctl %s\n' "$*" >> "${LAUNCHCTL_LOG:-/dev/null}"
EOF
chmod +x "${MOCK_BIN}/launchctl"
LAUNCHCTL_LOG="${LAUNCHCTL_LOG}" # re-export for subshells
export PATH="${MOCK_BIN}:${PATH}"

# ─── Section 1: config_file_to_slug ──────────────────────────────
printf '\n=== config_file_to_slug ===\n'

assert_eq "cortex.yaml → meta-factory" \
  "meta-factory" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.yaml")"

assert_eq "cortex.work.yaml → work" \
  "work" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.work.yaml")"

assert_eq "cortex.halden.yaml → halden" \
  "halden" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.halden.yaml")"

assert_eq "cortex.my-stack.yaml → my-stack" \
  "my-stack" \
  "$(config_file_to_slug "${CONFIG_DIR}/cortex.my-stack.yaml")"

# Unrecognised filename should fail (non-zero exit).
if config_file_to_slug "${CONFIG_DIR}/bot.yaml" 2>/dev/null; then
  fail "bot.yaml should return non-zero"
else
  pass "bot.yaml returns non-zero (not a cortex config)"
fi

# ─── Section 2: discover_stack_slugs ─────────────────────────────
printf '\n=== discover_stack_slugs ===\n'

# Empty dir — no stacks.
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_eq "empty config dir → no slugs" "" "${SLUGS}"

# Single default config.
touch "${CONFIG_DIR}/cortex.yaml"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_eq "cortex.yaml only → meta-factory" "meta-factory" "${SLUGS}"

# Add work stack.
touch "${CONFIG_DIR}/cortex.work.yaml"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_contains "cortex.yaml + cortex.work.yaml includes meta-factory" "meta-factory" "${SLUGS}"
assert_contains "cortex.yaml + cortex.work.yaml includes work" "work" "${SLUGS}"

# Add halden stack.
touch "${CONFIG_DIR}/cortex.halden.yaml"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_contains "three configs includes meta-factory" "meta-factory" "${SLUGS}"
assert_contains "three configs includes work" "work" "${SLUGS}"
assert_contains "three configs includes halden" "halden" "${SLUGS}"

# Non-cortex YAML files must NOT be discovered.
touch "${CONFIG_DIR}/other.yaml"
touch "${CONFIG_DIR}/readme.txt"
SLUGS="$(discover_stack_slugs "${CONFIG_DIR}")"
assert_not_contains "other.yaml not included" "other" "${SLUGS}"
assert_not_contains "readme.txt not included" "readme" "${SLUGS}"

# Line count matches file count (3 cortex*.yaml files → 3 slugs).
SLUG_COUNT="$(discover_stack_slugs "${CONFIG_DIR}" | wc -l | tr -d ' ')"
assert_eq "3 cortex*.yaml → 3 slugs" "3" "${SLUG_COUNT}"

# ─── Section 3: render_stack_plist — meta-factory ─────────────────
printf '\n=== render_stack_plist: meta-factory ===\n'

# Write a minimal meta-factory config with an agents[].id field.
cat > "${CONFIG_DIR}/cortex.yaml" <<'EOF'
agents:
  - id: my-test-agent
    token: "fake"
EOF

MF_TEMPLATE="${REPO_ROOT}/src/services/ai.meta-factory.cortex.meta-factory.plist"
MF_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.meta-factory.plist"

if [ -f "${MF_TEMPLATE}" ]; then
  render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "meta-factory" "${MOCK_BIN}/bun"
  assert_file_exists "meta-factory plist rendered" "${MF_DST}"
  assert_contains "meta-factory plist contains label" "ai.meta-factory.cortex.meta-factory" "$(cat "${MF_DST}")"
  assert_contains "meta-factory plist agent name substituted" "my-test-agent" "$(cat "${MF_DST}")"
  assert_not_contains "meta-factory plist has no leftover placeholder" "__AGENT_NAME__" "$(cat "${MF_DST}")"
  assert_not_contains "meta-factory plist has no leftover CORTEX_DIR" "__CORTEX_DIR__" "$(cat "${MF_DST}")"
else
  printf '  ⊘ template %s not found — skipping meta-factory render tests\n' "${MF_TEMPLATE}"
fi

# ─── Section 4: render_stack_plist — work ─────────────────────────
printf '\n=== render_stack_plist: work ===\n'

WORK_TEMPLATE="${REPO_ROOT}/src/services/ai.meta-factory.cortex.work.plist"
WORK_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"

if [ -f "${WORK_TEMPLATE}" ]; then
  render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "work" "${MOCK_BIN}/bun"
  assert_file_exists "work plist rendered" "${WORK_DST}"
  assert_contains "work plist contains label" "ai.meta-factory.cortex.work" "$(cat "${WORK_DST}")"
  assert_not_contains "work plist has no leftover CORTEX_DIR" "__CORTEX_DIR__" "$(cat "${WORK_DST}")"
else
  printf '  ⊘ template %s not found — skipping work render tests\n' "${WORK_TEMPLATE}"
fi

# ─── Section 5: render_stack_plist — generic (halden) ─────────────
printf '\n=== render_stack_plist: halden (generic template) ===\n'

GENERIC_TEMPLATE="${REPO_ROOT}/src/services/ai.meta-factory.cortex.stack.plist"
HALDEN_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.halden.plist"

if [ -f "${GENERIC_TEMPLATE}" ]; then
  render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "halden" "${MOCK_BIN}/bun"
  assert_file_exists "halden plist rendered via generic template" "${HALDEN_DST}"
  assert_contains "halden plist label correct" "ai.meta-factory.cortex.halden" "$(cat "${HALDEN_DST}")"
  assert_contains "halden plist --config flag correct" "cortex.halden.yaml" "$(cat "${HALDEN_DST}")"
  assert_not_contains "halden plist has no leftover STACK_SLUG" "__STACK_SLUG__" "$(cat "${HALDEN_DST}")"
  assert_not_contains "halden plist has no leftover CONFIG_FILE" "__CONFIG_FILE__" "$(cat "${HALDEN_DST}")"
  assert_not_contains "halden plist has no leftover CORTEX_DIR" "__CORTEX_DIR__" "$(cat "${HALDEN_DST}")"
else
  fail "generic stack template missing: ${GENERIC_TEMPLATE}"
fi

# ─── Section 6: render_stack_plist — missing config removes stale plist
printf '\n=== render_stack_plist: stale plist cleanup ===\n'

# Create a stale plist for a stack whose config was deleted.
STALE_SLUG="vanished"
STALE_DST="${LAUNCH_DIR}/ai.meta-factory.cortex.${STALE_SLUG}.plist"
touch "${STALE_DST}"
# Do NOT create cortex.vanished.yaml — the config is absent.

render_stack_plist "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}" "${STALE_SLUG}" "${MOCK_BIN}/bun" || true
assert_file_not_exists "stale plist removed when config absent" "${STALE_DST}"

# ─── Section 7: render_cortex_plists drives relay + all stacks ────
printf '\n=== render_cortex_plists (integration) ===\n'

# Only runs on Darwin; skip on other hosts but still count the skip.
if [ "$(uname)" = "Darwin" ]; then
  # Reset LAUNCH_DIR for a clean run.
  rm -f "${LAUNCH_DIR}"/*.plist 2>/dev/null || true
  # Config dir has: cortex.yaml, cortex.work.yaml, cortex.halden.yaml (from above).
  render_cortex_plists "${REPO_ROOT}" "${LAUNCH_DIR}" "${CONFIG_DIR}"

  RELAY_PLIST="${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist"
  assert_file_exists "relay plist rendered by render_cortex_plists" "${RELAY_PLIST}"
  assert_file_exists "meta-factory plist rendered by render_cortex_plists" \
    "${LAUNCH_DIR}/ai.meta-factory.cortex.meta-factory.plist"
  assert_file_exists "work plist rendered by render_cortex_plists" \
    "${LAUNCH_DIR}/ai.meta-factory.cortex.work.plist"
  assert_file_exists "halden plist rendered by render_cortex_plists" \
    "${LAUNCH_DIR}/ai.meta-factory.cortex.halden.plist"
else
  printf '  ⊘ render_cortex_plists integration test skipped (non-Darwin host)\n'
fi

# ─── Summary ──────────────────────────────────────────────────────
printf '\n'
printf 'Results: %d passed, %d failed\n' "${PASS}" "${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
