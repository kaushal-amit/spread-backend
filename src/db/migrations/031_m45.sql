-- ===========================================================================
--  031 · spread.m45 — the 09:00–09:45 range-over-cost column (A5, Item 6)
-- ===========================================================================
--  A ranking column, NOT a gate: how far a symbol ranged in the first 45 minutes
--  relative to the cost of trading it (spread + commission). Its own table, read
--  by (symbol, trading_day) — it is NOT joined into spread.symbol_day or the
--  migration-016 bridge, and does not depend on either existing (the done-when of
--  Step 5 drops the bridge; A5 must survive that).
--
--  WRITTEN ONCE per day. The +245.8 vs −223.2 swing between an early read and a
--  late one is the whole point: the number is frozen at 09:45 and the job refuses
--  to overwrite it. reason IS NULL exactly when range_over_cost_ratio IS NOT NULL —
--  a value XOR a reason it could not be computed (THIN), never both, never neither.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS spread.m45 (
  symbol          text        NOT NULL,
  trading_day     date        NOT NULL,
  range_over_cost_ratio numeric,
  range_pct       numeric,
  spread_pct      numeric,
  commission_pct  numeric,
  captures        integer     NOT NULL DEFAULT 0,
  active_minutes  integer     NOT NULL DEFAULT 0,
  reason          text,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, trading_day),
  CONSTRAINT m45_symbol_upper CHECK (symbol = upper(symbol)),
  CONSTRAINT m45_value_xor_reason CHECK ((range_over_cost_ratio IS NULL) = (reason IS NOT NULL))
);

-- THIN counts activity, not captures: fewer than this many volume-increasing
-- minutes in the window and the column is NULL / THIN rather than a value.
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('m45_min_active_minutes', 10, 'minutes', 'A5', 'the m45 window needs at least this many volume-increasing minutes, else THIN', true)
ON CONFLICT (key) DO NOTHING;
