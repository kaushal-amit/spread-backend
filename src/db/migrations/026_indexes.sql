-- ===========================================================================
--  026 · the indexes the hot reads need (6.1)
-- ===========================================================================
--  The cursor feeds (6.4) page order_leg by (symbol, posted_at) and cash_movement
--  by (at, id); the board and the ladder read order_leg by symbol. These two
--  indexes back those keyset scans so pagination stays O(log n) as the ledger
--  grows. Idempotent (CREATE INDEX IF NOT EXISTS).
--
--  Deferred to a later migration (6.1/6.2 remainder), because each needs care
--  against live data rather than a blind apply:
--    · CHECK (symbol = upper(symbol)) on order_leg/claim, then dropping the
--      upper(symbol) predicates in the read queries — requires proving every
--      existing symbol is already uppercase first, and editing each query.
--    · v_depth's DISTINCT ON replaced with a window de-dupe.
--    · spread.session_drift computed hourly in the stats job and served from a
--      table instead of the per-request drift query in /session.
-- ===========================================================================
CREATE INDEX IF NOT EXISTS order_leg_symbol_posted   ON spread.order_leg (symbol, posted_at DESC);
CREATE INDEX IF NOT EXISTS cash_movement_at_id        ON spread.cash_movement (at DESC, id DESC);
