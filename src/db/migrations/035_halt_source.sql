-- ===========================================================================
--  035 · halt_event.source — LIVE vs BACKFILL (G-2)
-- ===========================================================================
--  halt_event starts on 4 September, so symbolHistory says "0 halts" and the
--  skip list is a hand-typed constant. The backfill replays the same transition
--  detection over the captured awsat_market_quotes history and writes the halts
--  that already happened — marked BACKFILL so a live row is never confused with
--  a replayed one. A unique index makes the backfill idempotent: a second run
--  writes nothing.
-- ===========================================================================
ALTER TABLE spread.halt_event
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'LIVE';

-- One event per (symbol, day, kind, instant) — the backfill's idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS halt_event_dedupe
  ON spread.halt_event (symbol, trading_day, kind, detected_at);
