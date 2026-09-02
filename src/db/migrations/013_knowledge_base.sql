-- ===========================================================================
--  013_knowledge_base.sql — the knowledge base, in the schema that owns it
--
--  These tables were built in the SCRAPER by mistake (its migrations 030/031)
--  and are inert there: nothing reads them, and the scraper's nine thresholds
--  now live in src/config/thresholds.js. They belong here, where the AI layer
--  and the sizing endpoints are.
--
--  The public.* copies get dropped once this is populated and read from.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS spread.kb_threshold (
  key         text PRIMARY KEY,
  -- `value` and `prev_value` carry no unit in their NAME because the unit is a
  -- COLUMN here: a threshold table holds fils, percentages, counts and rates in
  -- one place, so value_kd would be wrong on most rows. The naming rule assumes
  -- one unit per column and this table is the exception.
  value       numeric NOT NULL,
  unit        text NOT NULL,
  source_cr   text,
  note        text,
  prev_value  numeric,
  changed_on  date,
  changed_by  text,
  still_true  boolean NOT NULL DEFAULT true
);

COMMENT ON COLUMN spread.kb_threshold.prev_value IS
  'What it was before. A threshold that moved without anyone recording the old '
  'value cannot be argued about afterwards.';

-- ---------------------------------------------------------------------------
-- kb_rule — judgement, assembled into the system prompt.
--
-- One row per `##` section of a skill file. The headings are the author''s own
-- unit of thought: splitting finer means someone else decides where a rule
-- ends, and a rule severed from its evidence stops being credible. Splitting
-- coarser makes scoping pointless.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spread.kb_rule (
  id            bigserial PRIMARY KEY,
  rule          text NOT NULL,
  heading       text,
  source_file   text,
  scope         text NOT NULL,
  symbol        text,
  trigger_state text,
  source_cr     text,
  added_on      date DEFAULT current_date,
  still_true    boolean NOT NULL DEFAULT true,

  -- What this replaces. kse-trade-claim-checklist holds CORRECTIONS to earlier
  -- findings: when one is marked still_true = false, the correction must point
  -- at what it replaced, or "the markup rule reversed on 99 cases" and the
  -- original become two unrelated rows and nobody can tell which won.
  supersedes    bigint REFERENCES spread.kb_rule(id),

  -- Raw signals for judging whether a section is a rule or the prose that sets
  -- one up. FACTS, not a classification: a heuristic list would look
  -- authoritative and send someone to the wrong sections at exactly the moment
  -- they are debugging degraded answers.
  -- Where the section sits in its file, and part of its identity: a heading is
  -- NOT unique within one. kse-auction-and-tip-trades has two sections called
  -- "The rule" and two called "The case". Keyed on heading alone the second
  -- overwrote the first — 72 rows imported, 70 stored, and the difference was
  -- visible only because the counts were printed.
  section_no      integer,

  word_count      integer,
  has_number      boolean,
  has_code_block  boolean,
  has_checkbox    boolean
);

ALTER TABLE spread.kb_rule DROP CONSTRAINT IF EXISTS kb_rule_scope_valid;
ALTER TABLE spread.kb_rule ADD CONSTRAINT kb_rule_scope_valid
  CHECK (scope IN ('GLOBAL', 'STOCK', 'SITUATIONAL'));

-- A CHECK, not a convention: a typo in trigger_state would never match, the
-- rule would silently never load, and nothing would report it.
ALTER TABLE spread.kb_rule DROP CONSTRAINT IF EXISTS kb_rule_trigger_state_valid;
ALTER TABLE spread.kb_rule ADD CONSTRAINT kb_rule_trigger_state_valid CHECK (
  trigger_state IS NULL OR trigger_state IN (
    'NO_PROTECTION', 'BUYERS_8_5', 'WALL_PLACED', 'WALL_PULLED',
    'BAIT_BID', 'FROZEN', 'BID_EMPTY', 'WAKEUP',
    'TARGET_SET', 'PRE_OPEN', 'TIP_TRADE', 'POSITION_OPEN'));

-- Re-runnable import: a section is identified by its file and heading.
CREATE UNIQUE INDEX IF NOT EXISTS kb_rule_source_idx
  ON spread.kb_rule (source_file, section_no);
CREATE INDEX IF NOT EXISTS kb_rule_scope_idx
  ON spread.kb_rule (scope, symbol, trigger_state) WHERE still_true;

COMMENT ON COLUMN spread.kb_rule.trigger_state IS
  'NULL on import, and deliberately. Almost nothing in the prose names a signal '
  'state, so assigning one would be a guess — and a wrong trigger_state means '
  'the rule NEVER LOADS and nothing reports it. Tagged later, through the API, '
  'when a rule demonstrably belongs to a state.';

CREATE TABLE IF NOT EXISTS spread.kb_phrase (
  event      text PRIMARY KEY,
  text       text NOT NULL,
  still_true boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE spread.kb_phrase IS
  'Short labels for the ladder. Refreshed every 15 seconds across 20 rows — '
  '80 model calls a minute is too slow and too expensive, and a string literal '
  'cannot be edited without a deploy.';
