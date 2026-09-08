-- ===========================================================================
--  037 · halt_event delivery record (H-D1)
-- ===========================================================================
--  At 11:16:50 the detector produced a clean TRADEABLE for UPAC and NOBODY saw
--  it — the detection half works, the delivery half left no trace. "Was UPAC
--  sent?" must be a QUERY, not a guess.
--
--  Every TRADEABLE resume attempts delivery to the operator's phone within one
--  scan, and the attempt is stamped here:
--    delivery_channel  which path was tried (gupshup / meta / … / 'console'
--                      when no provider is configured — the send is LOGGED, not
--                      silent, and that is recorded too)
--    delivered_at      when the send SUCCEEDED (NULL while unsent or failed)
--    delivery_error    why it did not go out (NULL on success)
--  A TRADEABLE row with all three NULL is a delivery that was never attempted —
--  the defect this closes.
-- ===========================================================================
ALTER TABLE spread.halt_event
  ADD COLUMN IF NOT EXISTS delivery_channel text,
  ADD COLUMN IF NOT EXISTS delivered_at     timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_error   text;
