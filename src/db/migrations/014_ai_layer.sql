-- ===========================================================================
--  014_ai_layer.sql — the AI layer's own tables, in the schema that owns them
--
--  Built in the SCRAPER by mistake (its migration 031) and inert there. They
--  belong here, with claude.js and boundary.js.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS spread.ai_chat (
  id           bigserial PRIMARY KEY,
  asked_at     timestamptz NOT NULL DEFAULT now(),
  trading_day  date NOT NULL,
  symbol       text,
  question     text NOT NULL,
  answer       text,
  context_json jsonb,
  model        text,
  tool_calls   integer,
  tokens       integer,
  flagged      boolean DEFAULT false,

  -- The model said it could not answer with the tools available.
  --
  -- A refusal is a BETTER answer than a plausible one built from a query
  -- nobody can check — and after twenty sessions this list names the eleventh
  -- tool to build. Without the flag those answers are indistinguishable from
  -- ordinary ones in the log.
  unanswerable boolean DEFAULT false,

  -- Which tools produced the answer.
  --
  -- When an answer is wrong the first question is which tools it used, and
  -- without this column that means reading ai_query_log and correlating on
  -- timestamps.
  tools_called text[]
);

CREATE INDEX IF NOT EXISTS ai_chat_thread_idx
  ON spread.ai_chat (trading_day, symbol, asked_at DESC);
CREATE INDEX IF NOT EXISTS ai_chat_unanswerable_idx
  ON spread.ai_chat (asked_at DESC) WHERE unanswerable;

COMMENT ON COLUMN spread.ai_chat.context_json IS
  'NOT optional. Without it "why did it say hold at 09:31" is unanswerable a '
  'week later; with it the exact input replays.';
COMMENT ON COLUMN spread.ai_chat.symbol IS
  'The thread key. One thread per stock, NULL is the TODAY thread.';

CREATE TABLE IF NOT EXISTS spread.ai_memory (
  id                bigserial PRIMARY KEY,
  learned_on        date NOT NULL DEFAULT current_date,
  symbol            text,
  fact              text NOT NULL,
  source            text,
  confirmed_by_user boolean DEFAULT false,
  still_true        boolean DEFAULT true,
  exported          boolean DEFAULT false
);

CREATE INDEX IF NOT EXISTS ai_memory_active_idx
  ON spread.ai_memory (symbol) WHERE confirmed_by_user AND still_true;

CREATE TABLE IF NOT EXISTS spread.ai_query_log (
  id          bigserial PRIMARY KEY,
  chat_id     bigint REFERENCES spread.ai_chat(id),
  ran_at      timestamptz DEFAULT now(),
  tool        text NOT NULL,
  args        jsonb,
  rows_returned integer,
  duration_ms integer,
  error       text
);

COMMENT ON TABLE spread.ai_query_log IS
  'One row per TOOL call, not per SQL statement: the model never writes SQL. '
  'It chooses which of ten parameterised registry calls to make and with what '
  'arguments, so every number it sees is traceable to a column — which is what '
  'makes boundary.js able to reject an invented one.';
