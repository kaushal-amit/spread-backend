-- ===========================================================================
--  017 · the trading tables say no themselves
-- ===========================================================================
--  Every invariant below was enforced by one code path remembering to check
--  it, and one of them (a sell larger than the position) was enforced by
--  nothing. 015 dropped spread.symbol with CASCADE and took the foreign key on
--  order_leg.symbol with it, so a typo made an orphan position.
--
--  Each constraint is NOT VALID on existing rows where the table might already
--  hold something (order_leg is empty on kse today, but a *_test database may
--  not be), then validated — so the migration never fails on history it did
--  not write.
-- ===========================================================================

-- Enumerations. The API validated these on /record only; /hit-bid, /resolve
-- and the reconciliation wrote whatever they were given.
ALTER TABLE spread.order_leg
  DROP CONSTRAINT IF EXISTS order_leg_side_valid,
  ADD  CONSTRAINT order_leg_side_valid
       CHECK (side IN ('BUY','SELL')) NOT VALID;
ALTER TABLE spread.order_leg VALIDATE CONSTRAINT order_leg_side_valid;

ALTER TABLE spread.order_leg
  DROP CONSTRAINT IF EXISTS order_leg_status_valid,
  ADD  CONSTRAINT order_leg_status_valid
       CHECK (status IN ('POSTED','FILLED','CANCELLED','EXPIRED','CARRIED','AUCTION_SUBMITTED')) NOT VALID;
ALTER TABLE spread.order_leg VALIDATE CONSTRAINT order_leg_status_valid;

ALTER TABLE spread.order_leg
  DROP CONSTRAINT IF EXISTS order_leg_quantities_sane,
  ADD  CONSTRAINT order_leg_quantities_sane
       CHECK (shares > 0 AND price_fils > 0
              AND (filled_shares IS NULL OR (filled_shares > 0 AND filled_shares <= shares))) NOT VALID;
ALTER TABLE spread.order_leg VALIDATE CONSTRAINT order_leg_quantities_sane;

-- A FILLED leg has a fill quantity. NULL here is what let filled_shares be
-- "whatever shares was" and made a partial fill unrepresentable.
ALTER TABLE spread.order_leg
  DROP CONSTRAINT IF EXISTS order_leg_fill_has_quantity,
  ADD  CONSTRAINT order_leg_fill_has_quantity
       CHECK (status NOT IN ('FILLED','CARRIED') OR filled_shares IS NOT NULL) NOT VALID;
ALTER TABLE spread.order_leg VALIDATE CONSTRAINT order_leg_fill_has_quantity;

-- ONE filled buy per contract. Sells may be many (partial fills); the buy that
-- opened the contract is one row. Two FILLED buys on one seq were accepted and
-- contracts() picked whichever came first.
CREATE UNIQUE INDEX IF NOT EXISTS order_leg_one_buy_per_contract
  ON spread.order_leg (symbol, contract_seq)
  WHERE side = 'BUY' AND status IN ('FILLED','CARRIED');

-- The read every trading write starts with: "the latest leg in this symbol".
CREATE INDEX IF NOT EXISTS order_leg_symbol_posted_idx
  ON spread.order_leg (symbol, posted_at DESC);

-- 015 took this with spread.symbol. public.instruments is the canonical list
-- and reading it is allowed; a FOREIGN KEY reads. A *_test database without
-- the scraper's tables cannot pass 002, so the table is present wherever this
-- runs, but the guard keeps the migration honest.
DO $$
BEGIN
  IF to_regclass('public.instruments') IS NOT NULL THEN
    ALTER TABLE spread.order_leg DROP CONSTRAINT IF EXISTS order_leg_symbol_fkey;
    ALTER TABLE spread.order_leg
      ADD CONSTRAINT order_leg_symbol_fkey FOREIGN KEY (symbol)
      REFERENCES public.instruments(symbol) NOT VALID;
    ALTER TABLE spread.claim DROP CONSTRAINT IF EXISTS claim_symbol_fkey;
    ALTER TABLE spread.claim
      ADD CONSTRAINT claim_symbol_fkey FOREIGN KEY (symbol)
      REFERENCES public.instruments(symbol) NOT VALID;
  END IF;
END $$;

-- cash_movement.kind: the enum lived in a comment. FEE_CORRECTION is what the
-- reconciliation writes and it was not in the comment either.
ALTER TABLE spread.cash_movement
  DROP CONSTRAINT IF EXISTS cash_movement_kind_valid,
  ADD  CONSTRAINT cash_movement_kind_valid
       CHECK (kind IN ('DEPOSIT','WITHDRAWAL','ADJUSTMENT','BUY','SELL','FEE','FEE_CORRECTION')) NOT VALID;
ALTER TABLE spread.cash_movement VALIDATE CONSTRAINT cash_movement_kind_valid;

-- /ledger orders by (at, id); the index was on (trading_day, at).
CREATE INDEX IF NOT EXISTS cash_movement_at_idx ON spread.cash_movement (at, id);

ALTER TABLE spread.claim
  DROP CONSTRAINT IF EXISTS claim_amount_positive,
  ADD  CONSTRAINT claim_amount_positive CHECK (amount_kd > 0) NOT VALID;
ALTER TABLE spread.claim VALIDATE CONSTRAINT claim_amount_positive;

-- fee_source gains the value the reconciliation is about to need (D-05): a
-- leg whose broker row has been pruned keeps BROKER and is not re-labelled.
ALTER TABLE spread.order_leg DROP CONSTRAINT IF EXISTS order_leg_fee_source_valid;
ALTER TABLE spread.order_leg
  ADD CONSTRAINT order_leg_fee_source_valid
  CHECK (fee_source IS NULL OR fee_source IN ('BROKER','COMPUTED','AMBIGUOUS','IMPORTED'));
