-- ===========================================================================
--  040_session_clocks.sql — the step-down clocks are kb_threshold rows
--
--  Four intraday clocks lived as literals in four places: '11:00' in
--  spread.config EXIT.stepDownAtClock, 720 (12:00) in /api/session's countdown
--  and socket.js sessionPhase, '12:30' in EXIT.hardExitAtClock, and 1245 as
--  the kb row flat_by_hhmm. They are one set of operator thresholds, read by
--  lib/session.js — one source — and seeded here with today's values.
--  12:30 (hard exit) and 12:45 (flat by, 020) are the documented ones; 11:00
--  and 12:00 are carried as they were and await the operator's confirmation.
--  The exchange's own clocks (open 09:00, continuous trading to 13:00, closing
--  auction to 13:25, data complete from 13:26) are facts, not thresholds, and
--  stay in spread.config SESSION.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('step_down_hhmm',    1100, 'hhmm', 'FLOW step 7', 'the step-down: after this, drift turns negative — was EXIT.stepDownAtClock (11:00); to be confirmed', true),
  ('late_session_hhmm', 1200, 'hhmm', 'FLOW step 7', 'the late session: the countdown target and the "late" phase — was the 720 literal (12:00); to be confirmed', true),
  ('hard_exit_hhmm',    1230, 'hhmm', 'FLOW step 7', 'the flatten WARNING; the flat-by RULE is flat_by_hhmm (12:45) — was EXIT.hardExitAtClock', true)
ON CONFLICT (key) DO NOTHING;
