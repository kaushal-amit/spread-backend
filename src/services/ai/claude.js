'use strict';
/**
 * ============================================================================
 *  claude.js — the model call, with the boundary around it
 * ============================================================================
 * Server-side only. The browser POSTs a question and receives validated text;
 * it never sees the key and never calls the model.
 *
 * The flow, and every step matters:
 *
 *   1  the frozen registry gathers data     no SQL from the model
 *   2  Claude reasons over it               explaining, not deciding
 *   3  the boundary validates the response  mechanical, not a prompt
 *   4  spread.ai_note records it            so it can be SCORED later
 *
 * Eleven sessions of commentary previously existed only in chat history and
 * could not be scored — a TAKE that lost money and a TAKE that made money look
 * identical in a chat window.
 * ============================================================================
 */

const { pool } = require('../../db');
const boundary = require('./boundary');
const tools = require('./tools');
const schema = require('./schema');

/**
 * ─── THE CAP ───────────────────────────────────────────────────────────────
 * Eight tool calls, then the model answers with what it has. A loop with no
 * ceiling can spend a minute and a pound on a question that needed one query,
 * and an operator waiting for a number will not wait a minute.
 */
const MAX_TOOL_CALLS = Number(process.env.AI_MAX_TOOL_CALLS || 8);
const registry = require('./registry');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const API = 'https://api.anthropic.com/v1/messages';

/*
 * The prompt states the constraint, and the VALIDATOR enforces it. A prompt is
 * a request; boundary.js is the enforcement. Both, because a model that reads
 * the constraint produces better prose than one that gets rejected.
 */
const SYSTEM = `You are the tape commentator for SPREAD, a single-operator passive
market-making strategy on Boursa Kuwait. One position at a time, 1-3 KD per round
trip, so one bad exit erases a week.

WHAT YOU DO
- Explain what the book and the gates are showing.
- Name the action when the operator holds a position: hold, post the offer, step
  down, or sell now.
- Cite the record when a pattern repeats. "The third reposition cost 44.94 on
  29 July" lands; "be careful" does not.

WHAT YOU NEVER DO
- Never state a price or a share count of your own. The engine sets every number.
  You may REPEAT a number you were given; you may not produce one.
- Never predict direction. 131 attempts have failed and the base rate for "fell
  yesterday, rises today" is 44% — a coin flip.
- Never state a number that is not in the data you were given. An invented
  figure is indistinguishable from a real one in prose.
- Never claim a direction from book depth unless you were given 100+ snapshots.
  A nine-minute reading of one session gave the opposite of the full session.

STYLE
Two sentences. Facts and one action. No reassurance, no hedging.`;

/** Gather everything the model may reason over. Frozen tools only. */
async function gather(symbol, tradingDay, { db = pool, budgetKd } = {}) {
  const safe = (p) => p.catch(() => null);
  const [book, profile, day, depthSig, screen] = await Promise.all([
    safe(registry.call('getBook', { symbol }, { db })),
    safe(registry.call('getProfile', { symbol }, { db })),
    safe(registry.call('getSymbolDay', { symbol, days: 3 }, { db })),
    safe(registry.call('getDepthSignal', { symbol, date: tradingDay }, { db })),
    safe(registry.call('getScreenResult', { date: tradingDay, budgetKd }, { db })),
  ]);
  return { symbol, tradingDay, book, profile, recentDays: day,
    depth: depthSig, screen, budgetKd };
}

/**
 * Ask. Returns validated text, or a refusal — never unvalidated prose.
 */
async function ask({ symbol, tradingDay, question, position = null, surface = 'DETAIL',
                     budgetKd, db = pool } = {}) {
  registry.assertReady();

  const input = await gather(symbol, tradingDay, { db, budgetKd });
  if (position) input.position = position;

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // No key is a reason to say so, NOT a reason to invent. The previous
    // agent's failure mode was producing confident commentary with no data.
    return { ok: false, code: 'NO_KEY',
      text: 'The commentary layer has no API key configured. It will not produce ' +
            'commentary without one.' };
  }

  /**
   * ─── THE LOOP ─────────────────────────────────────────────────────────────
   *
   * The model picks WHICH of ten parameterised tools to call, never what SQL
   * to run. Every result carries its source and its counts, so boundary.js can
   * still trace each number to a column — which is the whole reason an answer
   * here can be trusted.
   *
   * Free SQL would have made "a depth claim on 9 snapshots is rejected"
   * unenforceable: the boundary would have to understand the query to know how
   * many snapshots were behind it. That rule exists because nine minutes of
   * depth once inverted the sign.
   */
  const schemaText = await schema.summary().catch(() => '(schema unavailable)');

  const kb = await db.query(
    `SELECT heading, rule FROM spread.kb_rule
      WHERE still_true AND (scope = 'GLOBAL' OR symbol = $1)
      ORDER BY scope, source_file, section_no`, [symbol || null])
    .then((r) => r.rows).catch(() => []);

  const messages = [{
    role: 'user',
    content: `Operator question: ${question || 'What is happening?'}\n\n`
      + `Today: ${tradingDay}${symbol ? `\nSymbol in focus: ${symbol}` : ''}`,
  }];

  const results = [];
  const toolsCalled = [];
  let text = '';
  let usage = null;
  let unanswerable = false;

  for (let turn = 0; turn <= MAX_TOOL_CALLS; turn += 1) {
    const last = turn === MAX_TOOL_CALLS;
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key,
                 'anthropic-workspace-id': 'wrkspc_014mEisL4okKnLD4qBkBLAs8',
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system: `${SYSTEM}\n\nSCHEMA (generated, do not assume columns beyond these):\n${schemaText}`
          + `\n\nKNOWLEDGE BASE:\n${kb.map((k) => k.rule).join('\n\n')}`
          + '\n\nYou have ten tools. You cannot write SQL and you cannot reach '
          + 'anything the tools do not return. If the tools cannot answer the '
          + 'question, SAY SO plainly and begin your answer with '
          + 'CANNOT_ANSWER: — a refusal is better than a plausible answer built '
          + 'from data nobody can check.'
          + (last ? '\n\nNo further tool calls are available. Answer with what you have.' : ''),
        messages,
        ...(last ? {} : { tools: tools.schemas() }),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, code: 'MODEL_ERROR', text: `model call failed (${res.status})`, body };
    }

    const data = await res.json();
    usage = data.usage || usage;
    const blocks = data.content || [];
    text = blocks.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const calls = blocks.filter((c) => c.type === 'tool_use');

    if (!calls.length) break;

    messages.push({ role: 'assistant', content: blocks });
    const toolResults = [];
    for (const c of calls) {
      let out;
      try {
        out = await tools.call(c.name, c.input || {});
        toolsCalled.push(c.name);
        results.push(out);
      } catch (e) {
        // Recorded as a FAILED result, not dropped: the boundary fails closed
        // on a tool it never saw, and a silently dropped error would let an
        // answer through on numbers nobody checked.
        out = { tool: c.name, error: e.message };
        results.push(out);
      }
      await db.query(
        `INSERT INTO spread.ai_query_log (tool, args, rows_returned, duration_ms, error)
         VALUES ($1,$2,$3,$4,$5)`,
        [c.name, JSON.stringify(c.input || {}), out.rows_returned ?? null,
          out.duration_ms ?? null, out.error || null]).catch(() => {});

      toolResults.push({
        type: 'tool_result', tool_use_id: c.id,
        content: JSON.stringify(out.error ? { error: out.error } : {
          source: out.source, rows_returned: out.rows_returned,
          ...(out.snapshots !== undefined ? { snapshots: out.snapshots } : {}),
          rows: out.rows,
        }).slice(0, 60000),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  unanswerable = /^\s*CANNOT_ANSWER/i.test(text);

  const { input: union, missing } = boundary.unionOf(results);
  const response = { reasoning: text, verdict: null };
  // Which same-row derivation let each number through. Recorded so that after
  // twenty sessions we can tell whether the derived passes are real arithmetic
  // or coincidence — the only way to know whether widening the check was right.
  const derivations = [];
  const check = boundary.validate(response, union, { missingSources: missing, derivations });
  const cited = boundary.citedValues(response, union);

  await db.query(
    `INSERT INTO spread.ai_chat
       (trading_day, symbol, question, answer, context_json, model, tool_calls,
        tokens, unanswerable, tools_called, flagged)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tradingDay, symbol, question || '', text,
      JSON.stringify({ union, missing, derivations }),
      MODEL, toolsCalled.length, usage?.output_tokens ?? null,
      unanswerable, toolsCalled, !check.ok]).catch(() => {});

  await db.query(
    `INSERT INTO spread.ai_note
       (trading_day, surface, symbol, reasoning, cited_values, model, tokens,
        rejected, reject_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9);`,
    [tradingDay, surface, symbol, text, JSON.stringify(cited), MODEL,
      usage?.output_tokens ?? null, !check.ok,
      check.ok ? null : check.rejections.join(' | ')]).catch(() => {});

  if (!check.ok) {
    /**
     * THE ANSWER TRAVELS WITH THE REJECTION.
     *
     * This used to return only the rejection text, so the thing that would
     * explain WHY it was rejected lived solely in ai_chat.answer and had to be
     * queried out of the database. That is the wrong way round: a rejection
     * cannot be judged without seeing what was rejected, and every rejection
     * disagreed with is a case for widening the derivation set.
     */
    return {
      ok: false,
      code: 'REJECTED',
      rejections: check.rejections,
      text,
      refusal: 'That reading was refused by the boundary: '
        + check.rejections.map((r) => (typeof r === 'string' ? r : r.detail || r.why)).join(' | '),
      derivations,
      toolsCalled,
    };
  }

  return { ok: true, text, citedValues: cited, warnings: check.warnings,
    derivations, toolsCalled, toolCalls: toolsCalled.length, unanswerable };
}

module.exports = { ask, gather, SYSTEM, MODEL, MAX_TOOL_CALLS };
