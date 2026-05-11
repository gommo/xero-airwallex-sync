#!/bin/bash
# Daily Airwallex → Xero sync wrapper. Invoked by launchd or manually.
# Sends a Pushover notification at end of run (success or failure).
set -uo pipefail

export PATH="/Users/colin/.nodenv/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/colin/dev/tributech/clients/xero-airwallex-sync

LOG_DIR="./data"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/sync.log"
RUN_LOG="$LOG_DIR/last-run.log"
: > "$RUN_LOG"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
START=$(ts)

run_step() {
  local label="$1"; shift
  echo "----- $(ts) $label -----" | tee -a "$LOG" "$RUN_LOG"
  "$@" 2>&1 | tee -a "$LOG" "$RUN_LOG"
  return ${PIPESTATUS[0]}
}

echo "===== $START starting daily sync =====" | tee -a "$LOG" "$RUN_LOG"

run_step "airwallex pull"          pnpm sync airwallex;          A=$?
run_step "post new SETTLED rows"   pnpm sync post --commit;       P=$?
run_step "update existing rows"    pnpm sync update-xero --commit; U=$?

END=$(ts)
echo "===== $END finished (airwallex=$A post=$P update=$U) =====" | tee -a "$LOG" "$RUN_LOG"

# ---- Pushover notification ----
get_env() { grep -E "^${1}=" .env.local 2>/dev/null | head -1 | cut -d= -f2-; }
PUSHOVER_USER_KEY=$(get_env PUSHOVER_USER_KEY)
PUSHOVER_APP_TOKEN=$(get_env PUSHOVER_APP_TOKEN)

if [ -z "$PUSHOVER_USER_KEY" ] || [ -z "$PUSHOVER_APP_TOKEN" ]; then
  echo "(Pushover creds not set in .env.local — skipping notification)" | tee -a "$LOG"
  exit 0
fi

if [ "$A" -eq 0 ] && [ "$P" -eq 0 ] && [ "$U" -eq 0 ]; then
  TITLE="Airwallex→Xero sync OK"
  PRIORITY=0
  MESSAGE=$(pnpm --silent sync summary 2>/dev/null)
else
  TITLE="Airwallex→Xero sync FAILED"
  PRIORITY=1
  # Strip ANSI color codes from log tail for readability on phones
  TAIL=$(tail -30 "$RUN_LOG" | sed -E $'s/\x1b\\[[0-9;]*[mGK]//g')
  MESSAGE=$(printf "Exit codes: airwallex=%s post=%s update=%s\n\n%s" "$A" "$P" "$U" "$TAIL")
fi

# Truncate to Pushover's 1024 char message limit
MESSAGE_TRUNC=$(printf "%s" "$MESSAGE" | head -c 1020)

curl -sS \
  --form-string "token=$PUSHOVER_APP_TOKEN" \
  --form-string "user=$PUSHOVER_USER_KEY" \
  --form-string "title=$TITLE" \
  --form-string "message=$MESSAGE_TRUNC" \
  --form-string "priority=$PRIORITY" \
  https://api.pushover.net/1/messages.json >> "$LOG" 2>&1 || true
echo >> "$LOG"
