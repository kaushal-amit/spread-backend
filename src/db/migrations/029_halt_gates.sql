-- ===========================================================================
--  029 · the two new halt-resume gates (A3, HALT_DETECTOR_spec §4/§9)
-- ===========================================================================
--  Gate 7 (ratio): at the resume the offer must sit within 3x the bid, or
--  sellers are still queued and the bounce will not clear. A kb row so the
--  multiple changes without a deploy. Gate 5 (repeat — SECOND HALT · CASCADE)
--  needs no threshold: it counts this symbol's halts today from halt_event.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('halt_offer_over_bid_max', 3, 'x', 'HALT §9', 'at a resume the offer must be within this multiple of the bid, else SELLERS STILL QUEUED', true)
ON CONFLICT (key) DO NOTHING;
