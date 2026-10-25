#!/bin/bash
# L1 binary re-verification: prove the compiled ./trade artifact carries the same guards.
set -u
WT=/tmp/tp-458199de-L1
cd "$WT" || exit 1
EV="$WT/docs/qa/evidence/tp-458199de-L1-20261025-233211-commit-c7d3e52"
FAKEHOME="$WT/fakehome"
export HOME="$FAKEHOME"
DB="$WT/db/evidence-bin/guards.db"
mkdir -p "$WT/db/evidence-bin"; rm -f "$DB" "$DB"-wal "$DB"-shm

rows() {
  local db="$1"
  if [ ! -f "$db" ]; then echo "DB_ABSENT (ledger file not created)"; return; fi
  sqlite3 "$db" "select 'accounts='||(select count(*) from accounts)||' lots='||(select count(*) from lots)||' signals='||(select count(*) from signals)||' trades='||(select count(*) from trades)||' dividends='||(select count(*) from dividends)||' symbols='||(select count(*) from symbols);" 2>&1
}
case_run() {
  local name="$1"; local expect="$2"; shift 3
  printf 'cd %s && HOME=%s env -u LOT_TRADER_DB -u TRADE_DB_PATH ./trade %s --db %s\n' "$WT" "$FAKEHOME" "$*" "$DB" > "$EV/BIN-$name.cmd"
  rows "$DB" > "$EV/BIN-$name.rows-before.txt"
  env -u LOT_TRADER_DB -u TRADE_DB_PATH ./trade "$@" --db "$DB" > "$EV/BIN-$name.stdout" 2> "$EV/BIN-$name.stderr"
  echo "$?" > "$EV/BIN-$name.exit"
  rows "$DB" > "$EV/BIN-$name.rows-after.txt"
  local code; code=$(cat "$EV/BIN-$name.exit"); local verdict="!!UNEXPECTED!!"
  if [ "$expect" = "zero" ] && [ "$code" = "0" ]; then verdict="OK-as-expected"; fi
  if [ "$expect" = "nonzero" ] && [ "$code" != "0" ]; then verdict="OK-as-expected"; fi
  printf '%-26s expect=%-7s exit=%-3s %-15s | before: %s | after: %s\n' "$name" "$expect" "$code" "$verdict" "$(cat "$EV/BIN-$name.rows-before.txt")" "$(cat "$EV/BIN-$name.rows-after.txt")"
}

echo "artifact: $(ls -l trade | awk '{print $5}') bytes | sha256 $(shasum -a 256 trade | cut -d' ' -f1)" | tee "$EV/BIN-ARTIFACT.txt"
echo
case_run "LEGAL-BUY-2.0001" zero -- lot buy --symbol 518880.SH --price 2.0001 --qty 100 --account ACCA --fee 0 --skip-risk --json
case_run "BUY-PRICE-NAN"  nonzero -- lot buy --symbol 518880.SH --price abc  --qty 100 --account ACCA --reason d09 --fee 0 --skip-risk --json
case_run "BUY-PRICE-ZERO" nonzero -- lot buy --symbol 518880.SH --price 0    --qty 100 --account ACCA --reason d09 --fee 0 --skip-risk --json
case_run "BUY-PRICE-NEG"  nonzero -- lot buy --symbol 518880.SH --price -2.5 --qty 100 --account ACCA --reason d09 --fee 0 --skip-risk --json
PARENT=$(sqlite3 "$DB" "select lot_id from lots order by rowid limit 1;")
case_run "ADD-PRICE-NAN"   nonzero -- lot add --parent-lot-id "$PARENT" --price abc --amount 10000 --account ACCA --fee 0 --skip-risk --json
case_run "CLOSE-PRICE-NEG" nonzero -- lot close --lot-id "$PARENT" --price -2.5 --qty 100 --fee 0 --json
FUTURE=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=50)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
case_run "ADD-TIME-FORGERY" nonzero -- lot add --parent-lot-id "$PARENT" --price 2.250 --account ACCA --skip-risk --time "$FUTURE" --reason forged_future --fee 0 --json
case_run "LEGAL-BUY-8.199" zero -- lot buy --symbol 518880.SH --price 8.199 --qty 100 --account ACCA --fee 0 --skip-risk --json
echo "EV=$EV"
