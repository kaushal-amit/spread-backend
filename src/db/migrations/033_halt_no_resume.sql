-- ===========================================================================
--  033 · NO_RESUME — a halt that closed without reopening (G-6)
-- ===========================================================================
--  CB Auction → {Close-Of-Day, Closing, Close Auction Acceptance} is the session
--  ending on a halted symbol: it never resumed. That is a NO_RESUME event —
--  logged, not alerted, and it clears the open halt so it does not carry into
--  the next day. The kind CHECK must admit it.
-- ===========================================================================
ALTER TABLE spread.halt_event DROP CONSTRAINT IF EXISTS halt_event_kind_check;
ALTER TABLE spread.halt_event
  ADD CONSTRAINT halt_event_kind_check CHECK (kind = ANY (ARRAY['HALT','RESUME','NO_RESUME']));
