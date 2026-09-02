-- 005 · Orders, cash, claims, overrides
--
-- A CONTRACT is COALESCE(carried_from_day, trading_day) + symbol + seq.
-- A buy on the 29th and a sell on the 30th are ONE contract; keying on
-- trading_day alone lost every cross-day pair.

CREATE TABLE IF NOT EXISTS spread.order_leg (
  id                      bigserial PRIMARY KEY,
  trading_day             date NOT NULL,
  symbol                  text NOT NULL REFERENCES spread.symbol(symbol),
  contract_seq            int NOT NULL,

  side                    text NOT NULL,   -- BUY | SELL
  status                  text NOT NULL,   -- POSTED|FILLED|CANCELLED|EXPIRED|CARRIED|AUCTION_SUBMITTED
  price_fils              numeric NOT NULL,
  shares                  bigint NOT NULL,
  filled_shares           bigint,
  commission_kd           numeric,

  -- THE SETTLEMENT FEE IS PER EXECUTION, proven exactly. A 6,100 sell that
  -- filled as 5,350 + 750 was charged 2.285 against a formula expecting 1.680:
  -- 0.500 for the second settlement plus 0.105 because the 96.75 KD piece fell
  -- under the 0.250 minimum. Only that explanation reproduces the figure.
  executions              int,
  execution_sizes         jsonb,

  -- The four columns that settle whether fragmentation is predictable.
  -- E[executions] ~= 1 + shares / avg_trade_size, and twenty fills will say
  -- whether that or queue share is the predictor.
  shares_ahead_at_post    bigint,
  avg_trade_shares_at_post  numeric,
  queue_share_pct_at_post       numeric,
  placement               text,            -- AT_BID | INSIDE_GAP

  broker_order_id         text,
  -- The broker's own figure, commission included. No model involved, which is
  -- why it is the reconciliation anchor.
  broker_net_value_kd     numeric,

  posted_at               timestamptz,
  resolved_at             timestamptz,
  carried_from_day        date,
  exit_venue              text,            -- MARKET | AUCTION
  peak_bid_fils           numeric,
  target_ticks            int,
  note                    text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_leg_day_idx    ON spread.order_leg (trading_day, symbol);
CREATE INDEX IF NOT EXISTS order_leg_open_idx   ON spread.order_leg (status)
  WHERE status IN ('POSTED','FILLED','CARRIED');
CREATE INDEX IF NOT EXISTS order_leg_contract_idx
  ON spread.order_leg (symbol, COALESCE(carried_from_day, trading_day), contract_seq);

COMMENT ON COLUMN spread.order_leg.executions IS
  'How many executions filled this order. The settlement fee is charged PER '
  'EXECUTION and the 0.250 minimum applies per execution too, so a two-piece '
  'fill costs 0.50-0.75 more than the single-order formula predicts.';

COMMENT ON COLUMN spread.order_leg.broker_net_value_kd IS
  'The broker''s own net, commission included. No model. This is what charged-'
  'versus-expected reconciliation compares against.';

-- ---------------------------------------------------------------------------
-- The cash ledger. APPEND-ONLY.
--
-- budget_kd was a number typed into a box each morning. It had no history, did
-- not compound, and bore no relation to the money held — the screen read
-- "Free 800 KD" while the broker read 55.7450.
--
-- Buying power is now the settled balance. A profitable trip raises it by
-- itself. A mistake is corrected with an ADJUSTMENT row, never an edit —
-- otherwise the balance can be made to say anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.cash_movement (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  trading_day   date NOT NULL,
  kind          text NOT NULL,   -- DEPOSIT|WITHDRAWAL|BUY|SELL|FEE|ADJUSTMENT
  amount_kd     numeric NOT NULL,  -- SIGNED. deposits and sells +, buys and fees -
  order_leg_id  bigint REFERENCES spread.order_leg(id),
  -- If Boursa Kuwait settles T+2, proceeds are not buying power the same day
  -- and intra-session recycling does not exist. The column is here so that
  -- answer is a config change rather than a migration.
  settles_on    date,
  note          text
);

CREATE INDEX IF NOT EXISTS cash_movement_day_idx   ON spread.cash_movement (trading_day, at);
CREATE INDEX IF NOT EXISTS cash_movement_order_idx ON spread.cash_movement (order_leg_id);

COMMENT ON TABLE spread.cash_movement IS
  'Append-only. Every FILLED leg writes two rows — notional and fee — in the '
  'same transaction as the leg. A fill that does not move cash is the same '
  'class of bug as a fill that does not save.';

-- Capital reserved with no order placed. Stops the same money being offered to
-- three stocks at once. Does NOT post to the ledger.
CREATE TABLE IF NOT EXISTS spread.claim (
  trading_day   date NOT NULL,
  symbol        text NOT NULL REFERENCES spread.symbol(symbol),
  amount_kd     numeric NOT NULL,
  is_override   boolean NOT NULL DEFAULT false,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trading_day, symbol)
);

-- The reject list sorted by net shows when a THRESHOLD is wrong.
-- This shows when YOUR JUDGEMENT is. Same idea, opposite direction.
CREATE TABLE IF NOT EXISTS spread.override_log (
  id                    bigserial PRIMARY KEY,
  at                    timestamptz NOT NULL DEFAULT now(),
  trading_day           date NOT NULL,
  symbol                text NOT NULL,
  verdict_at_override   text NOT NULL,
  gates_overridden      text[] NOT NULL,
  reason                text,
  outcome               text,      -- filled when the contract closes
  outcome_kd            numeric
);
