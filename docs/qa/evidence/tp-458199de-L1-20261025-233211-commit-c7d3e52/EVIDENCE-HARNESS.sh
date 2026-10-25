#!/bin/bash
# L1 evidence harness: D-09 / D-01 / D-06 manual CLI proof.
set -u
WT=/tmp/tp-458199de-L1
REAL_HOME=/Users/ivywu
cd "$WT" || exit 1
TS=$(date +%Y%m%d-%H%M%S)
SHA=$(git rev-parse --short HEAD)
EV="$WT/docs/qa/evidence/tp-458199de-L1-${TS}-commit-${SHA}"
mkdir -p "$EV"
DBDIR="$WT/db/evidence"
mkdir -p "$DBDIR"
FAKEHOME="$WT/fakehome"
export HOME="$FAKEHOME"
DB=""

rows() {
  local db="$1"
  if [ ! -f "$db" ]; then echo "DB_ABSENT (ledger file not created)"; return; fi
  sqlite3 "$db" "select 'accounts='||(select count(*) from accounts)||' lots='||(select count(*) from lots)||' signals='||(select count(*) from signals)||' trades='||(select count(*) from trades)||' dividends='||(select count(*) from dividends)||' symbols='||(select count(*) from symbols);" 2>&1
}

# case_run <NAME> <expected_exit:zero|nonzero> -- <cli args...>   (uses global $DB)
case_run() {
  local name="$1"; local expect="$2"; shift 3
  printf 'cd %s && HOME=%s env -u LOT_TRADER_DB -u TRADE_DB_PATH bun run src/cli.ts %s --db %s\n' "$WT" "$FAKEHOME" "$*" "$DB" > "$EV/$name.cmd"
  rows "$DB" > "$EV/$name.rows-before.txt"
  env -u LOT_TRADER_DB -u TRADE_DB_PATH bun run src/cli.ts "$@" --db "$DB" > "$EV/$name.stdout" 2> "$EV/$name.stderr"
  echo "$?" > "$EV/$name.exit"
  rows "$DB" > "$EV/$name.rows-after.txt"
  local code; code=$(cat "$EV/$name.exit")
  local verdict="!!UNEXPECTED!!"
  if [ "$expect" = "zero" ] && [ "$code" = "0" ]; then verdict="OK-as-expected"; fi
  if [ "$expect" = "nonzero" ] && [ "$code" != "0" ]; then verdict="OK-as-expected"; fi
  printf '%-23s expect=%-7s exit=%-3s %-15s | before: %s | after: %s\n' "$name" "$expect" "$code" "$verdict" "$(cat "$EV/$name.rows-before.txt")" "$(cat "$EV/$name.rows-after.txt")"
}

echo "== REAL-USER LEDGER ISOLATION (must be byte-identical at the end) =="
shasum -a 256 "$REAL_HOME/.trade/trade.db" | tee "$EV/LEDGER-ISOLATION-before.txt"
ls -la "$REAL_HOME/.lot-trader/" | tee "$EV/LOT-TRADER-DIR-before.txt"

DB="$DBDIR/guards.db"; rm -f "$DB" "$DB"-wal "$DB"-shm
echo
echo "== [DB guards.db] LEGAL seed = legal case #1: price 2.0001, --fee 0 =="
case_run "LEGAL-BUY-2.0001" zero -- lot buy --symbol 518880.SH --price 2.0001 --qty 100 --account ACCA --fee 0 --skip-risk --json

echo
echo "== [DB guards.db] D-09 violation side (3 buys) =="
case_run "BUY-PRICE-NAN"  nonzero -- lot buy --symbol 518880.SH --price abc  --qty 100 --account ACCA --reason d09 --fee 0 --skip-risk --json
case_run "BUY-PRICE-ZERO" nonzero -- lot buy --symbol 518880.SH --price 0    --qty 100 --account ACCA --reason d09 --fee 0 --skip-risk --json
case_run "BUY-PRICE-NEG"  nonzero -- lot buy --symbol 518880.SH --price -2.5 --qty 100 --account ACCA --reason d09 --fee 0 --skip-risk --json

echo
echo "== [DB guards.db] D-09 covering the other two write paths (lot add / lot close) =="
PARENT=$(sqlite3 "$DB" "select lot_id from lots order by rowid limit 1;")
echo "parent lot = $PARENT" | tee "$EV/PARENT-LOT.txt"
case_run "ADD-PRICE-NAN"   nonzero -- lot add   --parent-lot-id "$PARENT" --price abc  --amount 10000 --account ACCA --fee 0 --skip-risk --json
case_run "CLOSE-PRICE-NEG" nonzero -- lot close --lot-id "$PARENT" --price -2.5 --qty 100 --fee 0 --json

echo
echo "== [DB guards.db] D-01 violation side: forged future fill time =="
FUTURE=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=50)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
echo "forged --time = $FUTURE" | tee "$EV/FORGED-TIME.txt"
case_run "ADD-TIME-FORGERY" nonzero -- lot add --parent-lot-id "$PARENT" --price 2.250 --account ACCA --skip-risk --time "$FUTURE" --reason forged_future --fee 0 --json
case_run "BUY-TIME-FORGERY" nonzero -- lot buy --symbol 518880.SH --price 2.250 --qty 100 --account ACCA --skip-risk --time "$FUTURE" --reason forged_future --fee 0 --json

echo
echo "== [DB guards.db] LEGAL case #2: price 8.199, --fee 0 =="
case_run "LEGAL-BUY-8.199" zero -- lot buy --symbol 518880.SH --price 8.199 --qty 100 --account ACCA --fee 0 --skip-risk --json

echo
echo "== [DB guards.db] LEGAL case #3: real history backfill (parent -72h, add -49h) =="
PAST_PARENT=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=72)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
PAST_ADD=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=49)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
case_run "LEGAL-BUY-BACKFILL-72H" zero -- lot buy --symbol 510300.SH --price 3.500 --qty 1000 --account ACCA --fee 0 --skip-risk --time "$PAST_PARENT" --json
PASTPARENT=$(sqlite3 "$DB" "select lot_id from lots where symbol='510300.SH' order by rowid limit 1;")
case_run "LEGAL-ADD-BACKFILL-49H" zero -- lot add --parent-lot-id "$PASTPARENT" --price 3.400 --amount 10000 --account ACCA --fee 0 --skip-risk --time "$PAST_ADD" --json

echo
echo "== [DB d06.db] D-06 hard-cap message + legal under-cap control =="
DB="$DBDIR/d06.db"; rm -f "$DB" "$DB"-wal "$DB"-shm
case_run "D06-OTHER-PARK" zero -- lot buy --symbol 518880.SH --price 10.00 --qty 700 --account ACCB --fee 0 --skip-risk --json
case_run "D06-OVER-CAP"   nonzero -- lot buy --symbol 159915.SZ --price 3.0005 --qty 1000 --account ACCB --fee 0 --json
case_run "D06-UNDER-CAP"  zero -- lot buy --symbol 159915.SZ --price 3.0000 --qty 900 --account ACCB --fee 0 --json

echo
echo "== REAL-USER LEDGER ISOLATION (after) =="
shasum -a 256 "$REAL_HOME/.trade/trade.db" | tee "$EV/LEDGER-ISOLATION-after.txt"
ls -la "$REAL_HOME/.lot-trader/" | tee "$EV/LOT-TRADER-DIR-after.txt"
echo "EV=$EV"
