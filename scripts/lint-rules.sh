#!/bin/sh
# Rule enforcement. Runs on every verify, not once.
#
# A2 happened because a SECOND implementation appeared LATER, not because two
# were written at the same time.
fail=0
chk() {
  hits=$(eval "$2" 2>/dev/null)
  if [ -n "$hits" ]; then
    echo "FAIL  $1"; echo "$hits" | sed 's/^/        /'; fail=1
  else
    echo "ok    $1"
  fi
}
echo "=== one module owns each thing ==="
chk "only commission.js computes a fee" \
  "grep -rn '0\.0015\|0\.250\|settlementPerExecution' src/ --include=*.js | grep -v 'lib/commission.js' | grep -v 'config/spread.config.js'"
chk "only pricing.js rounds to a lot" \
  "grep -rnE 'floor\(.*/ *100\) *\* *100' src/ --include=*.js | grep -v 'lib/pricing.js'"
# A5 · spread.m45 is written by exactly one module (jobs/m45.js). No live
# recompute anywhere else — the number is frozen at 09:45 and read by the board.
chk "only jobs/m45.js writes spread.m45" \
  "grep -rniE '(INSERT INTO|UPDATE|DELETE FROM) +spread\.m45' src/ --include=*.js | grep -v 'jobs/m45.js'"
chk "nothing writes to public.*" \
  "grep -rniE '(INSERT INTO|UPDATE|DELETE FROM) +public\.' src/ --include=*.js --include=*.sql"
# The suites once wrote public.* from six files, and one of them deleted the
# day's legs against whatever DATABASE_URL named. test/fixtures.js is the ONE
# file allowed to write the scraper's tables, and it runs only behind dbguard.
chk "tests write public.* only through test/fixtures.js" \
  "grep -rniE '(INSERT INTO|UPDATE|DELETE FROM) +public\.' test/ --include=*.js | grep -v 'test/fixtures.js'"
# R-43 · the public.* tables test/fixtures.js is allowed to write, named so the
# grant is explicit and self-checking. Keep this list in sync with the code —
# the check fails if fixtures.js writes a public.* table not named here, or stops
# writing one that is.
#   app_config · awsat_market_quotes · awsat_market_summary · awsat_order_list ·
#   awsat_stock_depth · depth_watchlist · instruments · market_day · position ·
#   signal_log · symbol_day · tradingview_history
FIXTURE_PUBLIC_TABLES="app_config awsat_market_quotes awsat_market_summary awsat_order_list awsat_stock_depth depth_watchlist instruments market_day position signal_log symbol_day tradingview_history"
DOC_SORTED=$(printf '%s\n' $FIXTURE_PUBLIC_TABLES | sort -u)
ACTUAL_SORTED=$(grep -oE 'INSERT INTO public\.[a-z_]+' test/fixtures.js | sed -E 's/INSERT INTO public\.//' | sort -u)
FIXTURE_MISMATCH=""
[ "$DOC_SORTED" = "$ACTUAL_SORTED" ] || FIXTURE_MISMATCH="documented fixture public.* tables differ from fixtures.js INSERTs"
chk "the documented fixture public.* table list matches fixtures.js (R-43)" \
  "echo \"$FIXTURE_MISMATCH\" | grep ."
chk "every DB suite is behind dbguard" \
  "grep -lE \"require\\('../src/db'\\)\" test/*.test.js | xargs grep -L requireTestDb"
chk "gates read stored columns, never recompute in a screening query" \
  "grep -rn 'percentile_cont' src/services/ --include=*.js 2>/dev/null"
# A DATE column arrives as a STRING from the driver. Calling a Date method on
# one throws; building a Date from one and reading it with local getters shifts
# the day. Both have happened. lib/day.js accepts either form.
chk "date conversions go through lib/day.js" \
  "grep -rn 'toISOString()' src/ --include=*.js | grep -v 'lib/day.js' | grep -vE 'new Date\\(|kuwaitNow|k\\.toISOString'"

echo
[ $fail -eq 0 ] && echo "ALL PASS" || echo "RULE VIOLATIONS"
exit $fail
