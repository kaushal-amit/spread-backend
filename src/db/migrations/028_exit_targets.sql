-- ===========================================================================
--  028 · the exit target moves into kb_threshold (A1, Item 1)
-- ===========================================================================
--  FLOW step 7's exit target was a constant in spread.config.js. It becomes a
--  kb row under the R-36 store so a re-measurement can change it without a
--  deploy. The seed is the CURRENT rule — +2 fils normally, +6 on a trending
--  day — NOT a new number: A1 is gated on re-running the walk-forward at the
--  12:45 touch bid (scripts/walkforward-exit.js), and the winner is only seeded
--  once measured. exit_hold_to_flat: when no target is hit, hold to flat_by_hhmm
--  rather than taking the first profitable tick. Idempotent.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('exit_target_normal_fils',   2, 'fils', 'FLOW step 7', 'the standing exit target; the measured winner replaces this after the 12:45-bid walk-forward (A1)', true),
  ('exit_target_trending_fils', 6, 'fils', 'FLOW step 7', 'the exit target on a trending (RISK ON) day — stays 6, nothing has measured 8', true),
  ('exit_hold_to_flat',         1, 'bool', 'A1',          'when no target is hit, hold the position to flat_by_hhmm rather than taking the first profitable tick (1 = on)', true)
ON CONFLICT (key) DO NOTHING;
