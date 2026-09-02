-- 009 · claim.placement
--
-- The client sent `placement` on every move-to-trading call and the server
-- destructured it as `override`, so INSIDE vs AT_BID was silently discarded.
--
-- It matters: posting INSIDE a 2-fil gap puts you at queue zero, and posting
-- AT the bid puts you behind everything already there. Same one-fil capture,
-- completely different chance of filling.

ALTER TABLE spread.claim
  ADD COLUMN IF NOT EXISTS placement text;

COMMENT ON COLUMN spread.claim.placement IS
  'INSIDE_GAP or AT_BID. The gap entry does not pay more — it is the same '
  'one-fil capture. It changes whether you FILL: queue zero against everything '
  'already resting at the bid.';
