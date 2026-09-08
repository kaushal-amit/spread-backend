-- ===========================================================================
--  024 · the 20-minute time stop (R-21, FLOW step 6)
-- ===========================================================================
--  "A position that has not moved in 20 minutes is closed at the bid, whatever
--  the book looks like." Two reasons: with one position at a time, capital in a
--  frozen book blocks the next setup; and the losses come from waiting — 2 Sep
--  C1 bought 164, watched it, and sold 162 for −11.45. The rule lives in
--  kb_threshold so it changes without a deploy. Idempotent.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('time_stop_mins', 20, 'minutes', 'FLOW step 6', 'a filled buy that has not printed above entry for this long is a time stop — close it at the bid', true),
  -- R-26 · FLOW step 4 check 3: a price move carried by a print under this size
  -- is painted, not real demand. Not a gate — a marker beside the BOOK row.
  ('paint_max_shares', 100, 'shares', 'FLOW step 4', 'the last price move carried by a print under this many shares is painted', true)
ON CONFLICT (key) DO NOTHING;
