-- ===========================================================================
--  041_partial_fill_stop_override.sql — the rest of a partial fill, the stop
--  recorded at the fill, and the override that a post carries
-- ===========================================================================
--  Three columns, three silences they end:
--
--  rest_status · a FILLED leg with filled_shares < shares had a remainder that
--    the ledger forgot: it was still resting in Awsat, and when it filled the
--    only way to record it (a second BUY) was REFUSED as a second contract.
--    'POSTED' = the remainder is resting; 'FILLED' = it filled into this same
--    leg (filled_shares grew, a second execution, a second fee); 'CANCELLED' =
--    pulled. NULL = not tracked — the rows from before this migration, where
--    the remainder's fate is unknown and is NOT invented as resting.
--
--  stop_fils · the R-22 stop, recorded ON THE BUY LEG at the moment it fills
--    (from the aged ladder at that instant). It does not move with the ladder
--    afterwards — "the stop was set before the fill; moving it is how the large
--    losses happened". NULL = no shelf had aged when it filled (the leg's note
--    says so). stop_hit_at is set once, by the row poller, when the bid prints
--    at or through it; the STOP HIT alert fires from that write.
--
--  is_override / override_reason · a POSTED BUY that the sizing band or the
--    board's bucket would have refused, taken anyway. The reason is the
--    operator's words; the failing facts are in the note. Counted on
--    /api/orders so an override habit is visible, never silent.
-- ===========================================================================
ALTER TABLE spread.order_leg
  ADD COLUMN IF NOT EXISTS rest_status     text,
  ADD COLUMN IF NOT EXISTS stop_fils       numeric,
  ADD COLUMN IF NOT EXISTS stop_hit_at     timestamptz,
  ADD COLUMN IF NOT EXISTS is_override     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason text;

ALTER TABLE spread.order_leg DROP CONSTRAINT IF EXISTS order_leg_rest_status_valid;
ALTER TABLE spread.order_leg ADD CONSTRAINT order_leg_rest_status_valid
  CHECK (rest_status IS NULL OR rest_status IN ('POSTED','FILLED','CANCELLED')) NOT VALID;
ALTER TABLE spread.order_leg VALIDATE CONSTRAINT order_leg_rest_status_valid;

-- A resting remainder only makes sense on a FILLED leg that did not fill whole.
ALTER TABLE spread.order_leg DROP CONSTRAINT IF EXISTS order_leg_rest_on_partial;
ALTER TABLE spread.order_leg ADD CONSTRAINT order_leg_rest_on_partial
  CHECK (rest_status IS DISTINCT FROM 'POSTED'
         OR (status = 'FILLED' AND filled_shares IS NOT NULL AND filled_shares < shares)) NOT VALID;
ALTER TABLE spread.order_leg VALIDATE CONSTRAINT order_leg_rest_on_partial;

-- The poller's read: open buys with a stop that has not been hit.
CREATE INDEX IF NOT EXISTS order_leg_stop_armed_idx
  ON spread.order_leg (symbol)
  WHERE side = 'BUY' AND status IN ('FILLED','CARRIED') AND stop_fils IS NOT NULL AND stop_hit_at IS NULL;

COMMENT ON COLUMN spread.order_leg.rest_status IS
  'The remainder of a partial fill: POSTED (still resting), FILLED (filled into this leg), '
  'CANCELLED. NULL = not tracked (pre-041 rows) — never read as resting.';
COMMENT ON COLUMN spread.order_leg.stop_fils IS
  'R-22 stop recorded at the fill; fixed thereafter. NULL = no aged shelf when it filled.';
COMMENT ON COLUMN spread.order_leg.is_override IS
  'The post was outside the sizing band or the card was not TAKE, and the operator took it anyway.';
