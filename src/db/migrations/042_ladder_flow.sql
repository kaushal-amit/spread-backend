-- ===========================================================================
--  042_ladder_flow.sql — F8 · the flow markers' thresholds and phrases
-- ===========================================================================
--  services/ladderFlow.js decides PLACED / PULLED / TRADED / RELOCATED / PARKED
--  / WALKDOWN over the capture history and the session's volume series, and
--  the PHANTOM banner from the previous session's closing bid. Each figure it
--  compares against is a kb_threshold row here (the code's fallbacks are these
--  values), and each label is a kb_phrase row — editable without a deploy.
--  The evidence behind each is the reference's: MRC 210 +70,000 while 2,000
--  traded (PLACED); −102,151 with 33,094 traded (PULLED); 50,000 moved
--  207→205 in one capture (RELOCATED); 197 × 155,000 with zero changes in 49
--  captures (PARKED); ABAR 239→228→226→225 untraded (WALKDOWN); ABAR
--  1,827,769 bid at the close, 20,000 next morning (PHANTOM).
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('flow_change_min_qty', 20000, 'shares', 'F8 · ladder flow', 'a level must grow or shrink by at least this between captures to be PLACED / PULLED / TRADED; a vanished or relocated level must have been at least this', true),
  ('parked_max_changes',  2,     'count',  'F8 · ladder flow', 'a bid present most of the session (ceiling_presence_pct) with at most this many size changes is PARKED', true),
  ('walkdown_min_steps',  3,     'count',  'F8 · ladder flow', 'the touch offer must have stepped down this many distinct prices untraded to be a WALKDOWN', true),
  ('walkdown_max_age_mins', 20,  'min',    'F8 · ladder flow', 'a WALKDOWN is shown only while its last step is at most this old', true),
  ('phantom_shrink_pct',  90,    'pct',    'F8 · ladder flow', 'the previous close''s touch bid gone by at least this much at the first capture, nothing traded → the CLOSING BID observation', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO spread.kb_phrase (event, text, still_true) VALUES
  ('PLACED_TRADING', '+{n} while up to {p} traded', true),
  ('TRADED',         '{n} traded',                  true),
  ('WALKDOWN',       'walk-down, step {n}',         true)
ON CONFLICT (event) DO NOTHING;
