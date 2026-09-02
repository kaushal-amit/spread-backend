-- ===========================================================================
--  012_fee_reconciliation.sql — the broker's charge outranks our arithmetic
--
--  Commission is charged PER EXECUTION. A 6,100-share sell that filled as
--  5,350 + 750 was charged 2.285; the formula, assuming one execution, expects
--  1.680. Wrong by 0.605 KD on one trade, and ALWAYS IN THE SAME DIRECTION:
--  every split fill under-reports cost.
--
--  Under-reporting is the worse shape. An overstated cost makes a trade look
--  worse than it was; an understated one makes a losing strategy look viable.
-- ===========================================================================

ALTER TABLE spread.order_leg
  ADD COLUMN IF NOT EXISTS fee_source   text,
  ADD COLUMN IF NOT EXISTS fee_delta_kd numeric(12, 3);

ALTER TABLE spread.order_leg DROP CONSTRAINT IF EXISTS order_leg_fee_source_valid;
ALTER TABLE spread.order_leg ADD CONSTRAINT order_leg_fee_source_valid CHECK (
  fee_source IS NULL OR fee_source IN ('BROKER', 'COMPUTED', 'AMBIGUOUS'));

COMMENT ON COLUMN spread.order_leg.fee_source IS
  'BROKER: taken from awsat_order_list.net_value — the charge that actually '
  'landed. COMPUTED: our arithmetic, because no broker row matched. AMBIGUOUS: '
  'two or more broker rows matched (symbol, side, price, day) and neither was '
  'chosen — a guess between two candidates is worse than an honest COMPUTED.';

COMMENT ON COLUMN spread.order_leg.fee_delta_kd IS
  'broker minus computed. Stored rather than derived because the broker row may '
  'be pruned and the disagreement must outlive it — "how often, and by how '
  'much" is then one query across every trade rather than a join to a table '
  'that no longer holds the row.';

CREATE INDEX IF NOT EXISTS order_leg_fee_source_idx
  ON spread.order_leg (fee_source) WHERE fee_source IS NOT NULL;

-- ---------------------------------------------------------------------------
-- executions is a FLOOR, not a count.
--
-- executions_observed comes from a 60-second poll, so two fills inside one
-- interval are seen as one. The number can only be too low, which means the
-- fee computed from it can only be too low — the same direction as the bug it
-- corrects, just smaller.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN spread.order_leg.executions IS
  'How many executions the fee was computed from. A FLOOR when sourced from '
  'awsat_order_list.executions_observed: a 60-second poll cannot see two fills '
  'inside one interval, so the true count is this or higher.';
