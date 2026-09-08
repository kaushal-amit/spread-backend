-- ===========================================================================
--  034 · one scoring home (G-3)
-- ===========================================================================
--  A scored halt lived in TWO places: px_20min_fils / was_right on
--  spread.halt_event, and px_5/15/60min / was_right on public.signal_log (the
--  scraper's mirror + signals.score). Two homes drift. public.signal_log is the
--  one home — every signal is scored there — and the backend reads it (read-only
--  is allowed). Drop the halt_event scoring columns so nothing writes a second,
--  divergent answer. symbolHistory now joins signal_log scores to halt_event by
--  (symbol, fired_at).
-- ===========================================================================
ALTER TABLE spread.halt_event
  DROP COLUMN IF EXISTS px_20min_fils,
  DROP COLUMN IF EXISTS was_right;
