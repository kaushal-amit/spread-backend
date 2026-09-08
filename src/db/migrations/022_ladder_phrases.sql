-- ===========================================================================
--  022 · ladder phrases (R-24)
-- ===========================================================================
--  spread.kb_phrase was created in 013 and left empty — on the no-INSERT list,
--  read by nothing, and therefore a candidate to be dropped in the scraper
--  hand-off. The ladder markers (BAIT, AGED, UNDERCUT, CEILING, SHELF, NOPROT,
--  CATCH — and the flow-delta labels for later) are deterministic and refresh
--  every 15 seconds across 20 rows: 80 model calls a minute is too slow and too
--  expensive, so the SHORT LABEL comes from this table, editable without a
--  deploy, while the marker DECISION is computed in depth.js. {n} and {p} are
--  substituted by the caller (services/phrases.js), never by a model. Seeding
--  it is what keeps it. Idempotent.
-- ===========================================================================
INSERT INTO spread.kb_phrase (event, text, still_true) VALUES
  ('AGED',      'held {n}m',                     true),
  ('BAIT',      '{n}m old',                      true),
  ('THIN',      'thin — clears fast',            true),
  ('PARKED',    'parked, {n} changes',           true),
  ('CEILING',   'ceiling · {n}% of session',     true),
  ('UNDERCUT',  'undercut — seller below {n}',   true),
  ('PLACED',    '+{n}, nothing traded',          true),
  ('PULLED',    '−{n} withdrawn',                true),
  ('RELOCATED', '{n} moved from {p}',            true),
  ('SHELF',     'round number — stops sit here', true),
  ('NOPROT',    '{n} — nothing beneath',         true),
  ('CATCH',     'catch bid — price chosen',      true)
ON CONFLICT (event) DO NOTHING;
