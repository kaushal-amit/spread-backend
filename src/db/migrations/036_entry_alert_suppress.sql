-- ===========================================================================
--  036 · entry_alert.suppressed — the depth veto is RECORDED, not dropped
-- ===========================================================================
--  SPR-06/23 · An entry window can open on spread alone while the depth read
--  says SELL or WAIT. Firing the phone on those was the false-alarm source:
--  today's entry_alert rows are SELL 57 · WAIT 18 · BUY 1, and every non-BUY
--  went to the phone.
--
--  The decision (locked 8 Sep): a non-BUY depth VETOES the phone alert but the
--  window is still real and still recorded — off the phone, in the feed and the
--  table — with the reason it was held back. Dropping it silently would hide a
--  window that a later BUY-depth read might reopen; recording it keeps the
--  measurement honest and lets the feed show "held: depth SELL".
--
--  Gated on depth_signal HAVING DATA (a sufficient sample). A null/insufficient
--  depth read does not veto — spread-only alerting is unchanged there.
-- ===========================================================================
ALTER TABLE spread.entry_alert
  ADD COLUMN IF NOT EXISTS suppressed        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suppressed_reason text;
