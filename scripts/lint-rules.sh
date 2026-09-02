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
chk "nothing writes to public.*" \
  "grep -rniE '(INSERT INTO|UPDATE|DELETE FROM) +public\.' src/ --include=*.js --include=*.sql"
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
