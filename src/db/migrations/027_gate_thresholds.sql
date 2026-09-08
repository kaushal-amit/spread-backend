-- ===========================================================================
--  027 · the gate thresholds move into kb_threshold (R-36, BACKEND_spec §1.1)
-- ===========================================================================
--  Until now the screening gates read their numbers from spread.config.js while
--  the sizing/stop services read spread.kb_threshold: two threshold stores, so
--  changing 30 → 45 in the table moved one and not the other. These rows carry
--  the gate thresholds — the SAME values that lived in spread.config.js, moved,
--  not re-guessed — so config.js can keep the evidence and the shape while the
--  table becomes the one place a number changes without a deploy.
--
--  tick_min_price already exists (100 fils); the rest are new. Idempotent: a row
--  already present keeps its (possibly operator-edited) value.
-- ===========================================================================
INSERT INTO spread.kb_threshold (key, value, unit, source_cr, note, still_true) VALUES
  ('net_floor_kd',            0.5,  'KD',     'G2', 'the smallest net a fill must clear after commission', true),
  ('avg_trade_shares_min',    3000, 'shares', 'G3', 'a stock trading in smaller clips fills your order too slowly', true),
  ('moves_min',               15,   'moves',  'G4', 'distinct price moves a session, never a trade count', true),
  ('up2_min',                 3,    'moves',  'G4', 'two-tick moves required when the target is +2 fils', true),
  ('tiny_pct_max',            20,   'percent','G5', 'share of moves carried by sub-100-share prints — above this the tape is paint', true),
  ('postable_min_pct',        20,   'percent','G6', 'share of the SESSION a postable spread must be present', true),
  ('exitable_ratio_min_pct',  70,   'percent','G7', 'share of the session the offer sits within 2x the bid', true),
  ('exitable_size_min_pct',   60,   'percent','G7', 'share of the session the offer sits within 3x your shares', true),
  ('dist_volume_ratio',       2.0,  'x',      'G8', 'volume spike multiple — BOTH this and the flow ratio, or neither', true),
  ('dist_flow_ratio',         1.3,  'x',      'G8', 'sell-flow-over-buy-flow multiple that marks distribution', true),
  ('days_active_min',         3,    'days',   'G9', 'sessions in the last five a stock must actually have traded', true),
  ('gap2_min_pct',            30,   'percent','TARGET', 'share of the session a 2-fil spread must be present to allow a 2-tick capture', true),
  ('range3_min_fils',         6,    'fils',   'TARGET', 'session range a 3-tick capture needs before it is offered', true)
ON CONFLICT (key) DO NOTHING;
