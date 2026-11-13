# xero-airwallex-sync

A small tool that syncs **non-AUD Airwallex wallet transactions** into Xero as **AUD-denominated bank account lines**, so you can stay on a cheap Xero plan and skip the multicurrency add-on.

## The problem

Xero's multicurrency support is paywalled behind their premium plans. But if you run an Airwallex global account, you've probably got USD/EUR/etc. wallets covering overseas subscriptions (Render, JetBrains, GitHub, OpenAI, etc.) that you'd still like to see in Xero for proper P&L tracking.

## What it does

1. Pulls Airwallex `financial_transactions` + `balances/history` into a local SQLite cache
2. For each `SETTLED` non-AUD transaction, looks up the **daily AUD↔CCY rate** on the txn date (via [frankfurter.app](https://www.frankfurter.app/) — free ECB rates, no key)
3. Posts each as a `SPEND`/`RECEIVE` Xero `BankTransaction` against a manually-pre-created AUD-denominated bank account (e.g. `AWX_..._Cash_USD`), using the converted AUD amount and a description like `USD 157.60 → AUD 219.81 @ 0.71698`
4. Tags lines as **GST Free Expenses** (`EXEMPTEXPENSES`) — overseas suppliers, no GST
5. Supports a **merchant → account-code mapping** table so RENDER.COM auto-codes to Product Hosting, etc.
6. Idempotent — re-runs skip already-posted txns by tracking `airwallex_id → xero_txn_id` locally
7. Handles **FX conversion legs** by surfacing them as manual hints — you reconcile them in Xero's AUD account using the native Transfer mechanic, which auto-creates the matching credit on the non-AUD side

The AUD wallet itself is **not** touched by this tool — Xero's built-in Airwallex bank feed already handles AUD.

## Setup

```sh
pnpm install
cp .env.local.example .env.local
# Fill in:
#   AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY  (read-only key is enough)
#   XERO_CLIENT_ID / XERO_CLIENT_SECRET      (Custom Connection in Xero — client_credentials, no OAuth dance)
#   XERO_TENANT_ID                            (your tenant UUID)
#   XERO_EXPENSE_CODE                         (default account code for unmapped merchants)
#   PUSHOVER_USER_KEY / PUSHOVER_APP_TOKEN    (optional, for daily notifications)
```

Pre-create the Xero bank account(s) yourself, named e.g. `AWX_<Org> Pty Ltd_Cash_USD` (type `Bank`, currency `AUD`).

## Daily use

```sh
pnpm sync airwallex              # pull txns + balance_history
pnpm sync plan                   # dry-run preview of planned Xero postings
pnpm sync post --commit          # actually post new SETTLED rows (idempotent)
pnpm sync update-xero --commit   # refresh metadata on existing rows (re-applies current mappings)
pnpm sync paypal && pnpm sync post --source paypal --commit   # Patreon payouts (see PayPal section)
pnpm sync summary                # plain-text status digest
```

## Merchant → account-code mappings

```sh
pnpm sync map add RENDER 492          # case-insensitive substring; longest pattern wins
pnpm sync map add JETBRAINS 486
pnpm sync map list
pnpm sync map remove RENDER
```

Discover available codes with `pnpm sync xero-chart` (Xero chart of accounts).

## Daily sync

Operator wrapper scripts are kept out of the repo (they hardcode absolute paths to my machine). To set up a daily run on macOS, drop the following two files into `scripts/` and load the LaunchAgent.

**`scripts/run-sync.sh`** — sequence + Pushover notification:

```sh
#!/bin/bash
set -uo pipefail
export PATH="/Users/<you>/.nodenv/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /path/to/xero-airwallex-sync

LOG=./data/sync.log
RUN_LOG=./data/last-run.log
mkdir -p ./data; : > "$RUN_LOG"

run() { echo "----- $(date -u +%FT%TZ) $1 -----" | tee -a "$LOG" "$RUN_LOG"; shift; "$@" 2>&1 | tee -a "$LOG" "$RUN_LOG"; return ${PIPESTATUS[0]}; }

run "airwallex pull"        pnpm sync airwallex;          A=$?
run "post new SETTLED"      pnpm sync post --commit;      P=$?

# Intentionally NOT chained in daily: `update-xero --commit`.
# It re-PUTs every existing row, which overwrites manual Xero edits.
# Run that one by hand when you want to push refreshed metadata
# (e.g. after adding a merchant mapping).

# read PUSHOVER_* from .env.local, build success or failure body, POST to api.pushover.net/1/messages.json
# success body comes from: pnpm --silent sync summary
```

**`scripts/com.tributech.xero-airwallex-sync.plist`** — macOS LaunchAgent that runs daily at 07:15:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.tributech.xero-airwallex-sync</string>
  <key>ProgramArguments</key><array><string>/path/to/scripts/run-sync.sh</string></array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>7</integer><key>Minute</key><integer>15</integer>
  </dict>
  <key>StandardOutPath</key><string>/path/to/data/launchd.out.log</string>
  <key>StandardErrorPath</key><string>/path/to/data/launchd.err.log</string>
</dict></plist>
```

Install:

```sh
chmod +x scripts/run-sync.sh
cp scripts/com.tributech.xero-airwallex-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.tributech.xero-airwallex-sync.plist

# Force a run now to verify:
launchctl start com.tributech.xero-airwallex-sync
tail -f data/sync.log
```

If launchd misfires (laptop asleep at 07:15), it'll run on next wake.

## Stripe: foreign balances and payouts to Airwallex

Xero has no multicurrency here, so every Stripe line is posted in AUD into the one Stripe bank account.

- **AUD balance:** Stripe's own AUD amounts are used as they are.
- **Foreign balances (USD, NZD, CAD, ...):** each row is converted to AUD at the ECB daily rate for its date, the same as Airwallex card spend. The reference shows the working, e.g. `Stripe Subscriptions/entries USD 7.00 → AUD 9.88 @ 0.70820`.
- **Conversions inside Stripe (foreign to AUD):** the money stays in the same Xero account, so only the cost is posted: the conversion fee, plus the difference between the AUD received and the ECB value (to `STRIPE_CODE_FX`, or the fees code if unset).
- **Foreign payouts to Airwallex (USD payout into the USD wallet):** the Stripe payout is matched to the Airwallex `DEPOSIT` (same currency and amount, "stripe" in the description, within ten days) and posted once as a Xero bank transfer from the Stripe account to the `AWX_..._Cash_<CCY>` account. The Airwallex planner skips that deposit, so it is never booked as income.
- **AUD payouts:** still not posted. Reconcile them by hand as a Transfer to the real bank.

```sh
pnpm sync stripe-plan --foreign                     # list every converted line and transfer (no writes)
pnpm sync update-xero --source stripe               # dry-run: posted Stripe rows whose AUD value changed
pnpm sync update-xero --source stripe --commit      # push those corrections to Xero
```

## PayPal: Patreon payouts

Patreon pays creator earnings to PayPal in USD. The Xero account `Paypal USD (Manual)` is AUD-denominated with no feed, so without this nothing lands in Xero until someone keys a Receive Money by hand (which is how six months of Old World Fanatics income went missing in 2026).

What it does: pulls PayPal transactions via the Transaction Search API, and posts each successful USD credit from Patreon Inc as a `RECEIVE` on the PayPal account, coded to `PAYPAL_PATREON_CODE` (212 Online Sale - Old World Fanatics), tax `EXEMPTEXPORT`, Project tracking `OldWorldFanatics`, converted at the ECB daily rate. The later PayPal sweep to AUD and on to CBA stays a plain Transfer; PayPal's own conversion rate shows up as a small residual on the account that the sweep absorbs. Currency conversions and withdrawals are logged as manual hints and never posted. `PAYPAL_POST_FROM` is a hard date floor so the hand-keyed history is never duplicated.

Setup: create a **Live** REST app at developer.paypal.com (Apps & Credentials, Live tab) on the business account that receives the payouts, tick **Transaction Search** under features, and put the client id and secret in `.env.local`. Transaction Search has a roughly three-hour lag and serves the last three years.

```sh
pnpm sync paypal                      # pull last 3 months (--since YYYY-MM-DD for more)
pnpm sync paypal-plan                 # dry-run: what would be posted
pnpm sync post --source paypal --commit
```

The daily `run-sync.sh` runs the pull and post automatically once `PAYPAL_CLIENT_ID` is set.

## Limitations

- Airwallex's `balances/history` (the only endpoint with merchant names) has a ~7-day rolling window. **Sync at least every few days** or older captures get logged with generic "Airwallex USD card purchase" descriptions instead of merchant names.
- The `/issuing/transactions` endpoint (which would give us forever-historical merchant data) is gated at the Airwallex org level — even an admin key with all issuing scopes ticked returns `access_denied_not_enabled`. Reach out to Airwallex support if you want this unlocked.
- The "USD bank account" balance in Xero will drift from the actual USD wallet balance × current rate, because each historical txn is converted at *its* day's rate. This is expected and correct accounting.

## License

Personal use. Adapt freely.
