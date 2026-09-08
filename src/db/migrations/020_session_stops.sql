-- ===========================================================================
--  020 · the thresholds of the market gate and the session stops (R-19, R-20)
-- ===========================================================================
--  FLOW step 3 and "THE SESSION STOPS" — the rules the terminal exists to
--  enforce, and the ones that were not in the code:
--
--    breadth under 35              stop
--    falling 7+ points in an hour  stop, whatever the level
--    flat 35–50                    careful — one position, take 2 fils
--    two losing contracts          stop for the day
--    after any loss                30 minutes before re-entering
--    12:45                         flat
--
--  Every number is a kb_threshold row with the rule that set it, read by
--  src/services/stops.js. Nothing here is in a source file. Idempotent.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('breadth_stop_pct',         35,   'percent', 'FLOW step 3', 'breadth under this: no trade at all. 2 Sep opened at 24% and never rose', true),
  ('breadth_careful_pct',      50,   'percent', 'FLOW step 3', 'flat 35–50: one position, take 2 fils', true),
  ('breadth_drop_stop_pts',    7,    'points',  'FLOW step 3', 'falling this many points in an hour: stop, whatever the level. 31 Aug: 47 → 40 → 36', true),
  ('breadth_drop_window_mins', 60,   'minutes', 'FLOW step 3', 'the window the drop is measured over', true),
  ('careful_max_target_ticks', 2,    'ticks',   'FLOW step 3', 'in careful mode the target is 2 fils', true),
  ('loss_stop_contracts',      2,    'count',   'FLOW session stops', 'two losing contracts: stop for the day. 30 Aug, five MRC contracts, the fifth lost 12.59', true),
  ('loss_cooloff_mins',        30,   'minutes', 'FLOW session stops', 'after any loss, this long before re-entering', true),
  ('flat_by_hhmm',             1245, 'hhmm',    'FLOW step 7',  'flat by this clock, not into the auction. 30 Aug: a resting limit filled at 206 in the closing auction', true)
ON CONFLICT (key) DO NOTHING;
