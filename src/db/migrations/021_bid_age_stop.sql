-- ===========================================================================
--  021 · bid age and the stop (R-23, R-22)
-- ===========================================================================
--  FLOW step 5: size from the AGED bid, and "one fil below the nearest level
--  aged 30 minutes or more; never on a round number; never where the ladder
--  shows a gap." The thresholds already exist in public.kb_threshold (CR-50)
--  but were never copied into spread.kb_threshold, so bid_age was seeded and
--  read by nothing — SHUAIBA got a stop of 283 from the touch with a gap to
--  280 beneath it. Seed them, plus the round-number step for the stop.
--  Idempotent.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('bid_age_real_minutes', 30,     'minutes', 'CR-50', 'a level held this long is real support — size and stop only under an aged level', true),
  ('bid_age_bait_minutes', 5,      'minutes', 'CR-50', 'under this and large, the bid is bait, not support', true),
  ('bid_bait_min_qty',     100000, 'shares',  'CR-50', 'a bid this large and younger than bait_minutes is bait', true),
  ('stop_round_number_fils', 10,   'fils',    'FLOW step 5', 'a stop never lands on a multiple of this — the catch bid waits on round numbers', true)
ON CONFLICT (key) DO NOTHING;
