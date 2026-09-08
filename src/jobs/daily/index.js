/**
 * ─── THIS JOB IS INERT ─────────────────────────────────────────────────────
 *
 * It computed spread.symbol_day and spread.market_day from the source views.
 * Both are now VIEWS over public.symbol_day and public.market_day, which the
 * SCRAPER computes from the same rows — so every UPDATE here would fail on a
 * view it cannot write.
 *
 * WHAT REPLACED IT: kse-scraper's daily.symbolday and daily.marketday. They
 * produce 3,769 rows across 28 sessions with S1-S10 passing; this job had never
 * run against a populated database.
 *
 * DO NOT WIRE IT BACK UP. Two analytics layers over one dataset is the shape
 * the public/spread boundary exists to prevent, and reviving this would
 * recreate it. If a measurement is missing, add it to the scraper's compute —
 * five columns came across that way (avg_spread_fils, avg_spread_pct,
 * days_active, down_days, peak_hour) rather than being recomputed here.
 */

'use strict';
/**
 * ============================================================================
 *  jobs/daily — build spread.symbol_day, refresh spread.symbol_profile
 * ============================================================================
 * Cron: `30 13 * * 0-4` KUWAIT TIME. If the server runs UTC that is `30 10`.
 * Retry at 14:30 when the first run writes FAILED or PARTIAL.
 *
 * Every gate the screen applies is computed HERE, once, into stored columns.
 * Nothing recomputes these ad hoc — that is exactly how the same check came to
 * be expressed two different ways three times, and the wrong statistic
 * inverted the answer on both stocks it mattered for.
 *
 * TWO GUARDS, and they are different things:
 *
 *   SESSION GUARD    has today's session finished? Refuses to write a partial
 *                    row from a session still in progress.
 *
 *   SEQUENCE GUARD   is the previous session already computed? A backfill run
 *                    out of order makes each day resolve prev_close against
 *                    the wrong session and inherits the exact error the
 *                    prev_session function was written to fix.
 * ============================================================================
 */

const { pool } = require('../../db');
const { SESSION, QUALITY } = require('../../config/spread.config');
const steps = require('./steps');
const { toDay } = require('../../lib/day');

// Kuwait WALL CLOCK, for hour-of-day only. The session DAY is never derived
// from this: that is spread.kuwait_day() (019), which rolls at 04:00.
const K = "AT TIME ZONE 'Asia/Kuwait'";

/**
 * Which table the scrapers write to.
 *
 * `public.stock_quotes` on the existing database; `spread.quote` on a new one
 * that owns its own source data. Resolved once from the catalogue rather than
 * assumed — assuming produced `relation "public.stock_quotes" does not exist`.
 */
let sourceTable = null;
async function resolveSourceTable(db) {
  if (sourceTable) return sourceTable;
  const { rows } = await db.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_name IN ('stock_quotes','quote')
        AND table_schema IN ('public','spread')
      ORDER BY CASE table_schema WHEN 'public' THEN 0 ELSE 1 END LIMIT 1;`);
  if (!rows[0]) {
    const e = new Error(
      'no quote source found. Expected public.stock_quotes (the existing database) ' +
      'or spread.quote (a new one). Run `npm run migrate` first.');
    e.code = 'NO_SOURCE';
    throw e;
  }
  sourceTable = `${rows[0].table_schema}.${rows[0].table_name}`;
  return sourceTable;
}

/** The session day. Rolls at 04:00 Kuwait, not midnight. */
function kuwaitDay(d = new Date()) {
  const k = new Date(d.getTime() + SESSION.timezoneOffsetHours * 3600000);
  if (k.getUTCHours() < SESSION.dayRollHourKuwait) k.setUTCDate(k.getUTCDate() - 1);
  return k.toISOString().slice(0, 10);
}

/**
 * GUARD A · has the session finished?
 *
 * Branching happens in JavaScript, not in a SQL CASE. A decision hidden inside
 * a query is a decision nobody reads.
 */
async function sessionGuard(day, db) {
  /*
   * Reads the RAW table, not v_quote_screening. The guard asks "did the
   * session finish", and finishing means the AUCTION finished — Close-Of-Day
   * runs to 13:25 and the screening view filters it out. Asking the view would
   * mean the guard could never see 13:25 and would refuse every day forever.
   */
  const src = await resolveSourceTable(db);
  const { rows: [r] } = await db.query(
    `SELECT count(*) AS rows_today,
            to_char(max(created_at ${K}), 'HH24:MI')       AS last_capture,
            max((created_at ${K})::time)                    AS last_time
       FROM ${src}
      WHERE spread.kuwait_day(created_at) = $1;`, [day]);

  const rowsToday = Number(r.rows_today);
  if (rowsToday === 0) {
    return { status: 'NO_DATA', rowsToday, lastCapture: null,
      detail: `no quotes captured for ${day} — the scraper did not run` };
  }
  if (!r.last_time || String(r.last_time) < SESSION.auctionCloseAt + ':00') {
    return { status: 'SESSION_INCOMPLETE', rowsToday, lastCapture: r.last_capture,
      detail: `last capture ${r.last_capture}, expected ${SESSION.auctionCloseAt} or later. ` +
              'Writing now would store a partial session as though it were complete.' };
  }
  return { status: 'READY', rowsToday, lastCapture: r.last_capture, detail: null };
}

/**
 * GUARD B · is the previous session computed?
 *
 * `prev_close_fils` resolves through spread.prev_session(), so if 9 August has
 * not been computed then 10 August takes its previous close from 6 August —
 * which is the same four-day error the function exists to prevent, reintroduced
 * by running order alone.
 *
 * Skipped for the earliest day in a backfill, which has nothing before it.
 */
async function sequenceGuard(day, db, { allowFirst = false } = {}) {
  const { rows: [p] } = await db.query('SELECT spread.prev_session($1::date) AS prev;', [day]);
  // A date is a day. The driver returns it as a string; slice guards anything
  // that does not, because a Date here prints as a full local timestamp and
  // the message then names a different day from the one it means.
  const prev = toDay(p?.prev);
  if (!prev) {
    return { status: allowFirst ? 'FIRST_DAY' : 'NO_PREVIOUS_SESSION',
      prev: null, detail: 'no earlier session in the calendar' };
  }

  const { rows: [c] } = await db.query(
    `SELECT count(*) AS n FROM spread.symbol_day WHERE trading_day = $1;`, [prev]);
  if (Number(c.n) === 0) {
    return { status: 'PREVIOUS_NOT_COMPUTED', prev,
      detail: `${prev} has no rows. Computing ${day} first would resolve its ` +
              `previous close against a session further back, which is the ` +
              `error prev_session() exists to prevent. Run ${prev} first.` };
  }
  return { status: 'OK', prev, rows: Number(c.n) };
}

/**
 * @param {object} opts
 * @param {string} opts.date       YYYY-MM-DD, defaults to the current session day
 * @param {boolean} opts.force     run despite SESSION_INCOMPLETE
 * @param {boolean} opts.allowFirst  this is the earliest day of a backfill
 */
async function run({ date, force = false, allowFirst = false,
                     db = pool, log = console } = {}) {
  const day = date || kuwaitDay();
  const t0 = Date.now();
  const result = { job: 'daily', day, status: 'FAILED', steps: {} };

  const { rows: [started] } = await db.query(
    `INSERT INTO spread.job_run (job_name, trading_day, status)
     VALUES ('daily', $1, 'RUNNING') RETURNING id;`, [day]);
  const runId = started.id;

  const finish = async (status, extra = {}) => {
    await db.query(
      `UPDATE spread.job_run
          SET status=$2, guard_status=$3, rows_written=$4, rows_missing=$5,
              duration_ms=$6, detail=$7, finished_at=now()
        WHERE id=$1;`,
      [runId, status, extra.guardStatus ?? null, extra.rowsWritten ?? null,
       extra.rowsMissing ?? null, Date.now() - t0,
       JSON.stringify(extra.detail ?? result.steps)]);
    result.status = status;
    result.durationMs = Date.now() - t0;
    return result;
  };

  try {
    // ---- guards ----------------------------------------------------------
    const g = await sessionGuard(day, db);
    result.sessionGuard = g;
    log.log(`[daily] ${day} session=${g.status} rows=${g.rowsToday} last=${g.lastCapture}`);

    if (g.status === 'NO_DATA') {
      log.error(`[daily] ${day}: ${g.detail}`);
      return finish('FAILED', { guardStatus: g.status, detail: g });
    }
    if (g.status === 'SESSION_INCOMPLETE' && !force) {
      log.warn(`[daily] ${day}: ${g.detail}`);
      return finish('PARTIAL', { guardStatus: g.status, detail: g });
    }

    const s = await sequenceGuard(day, db, { allowFirst });
    result.sequenceGuard = s;
    if (s.status === 'PREVIOUS_NOT_COMPUTED') {
      log.error(`[daily] ${day}: ${s.detail}`);
      return finish('SKIPPED', { guardStatus: s.status, detail: s });
    }
    log.log(`[daily] ${day} sequence=${s.status}${s.prev ? ` prev=${s.prev}` : ''}`);

    // ---- steps, in dependency order --------------------------------------
    // build -> prevClose -> baselines -> gates -> capture -> hours ->
    // consistency -> direction -> missing -> market -> coverage -> profile
    for (const [name, fn] of [
      ['build',       steps.build],
      ['prevClose',   steps.prevClose],
      ['baselines',   steps.baselines],
      ['gates',       steps.gates],
      ['flow',        steps.flow],
      ['capture',     steps.capture],
      ['hours',       steps.hours],
      ['consistency', steps.consistency],
      ['direction',   steps.direction],
      ['missing',     steps.missing],
      ['market',      steps.market],
      ['coverage',    steps.coverage],
      ['profile',     steps.profile],
      ['alarms',      steps.alarms],
    ]) {
      const s0 = Date.now();
      result.steps[name] = await fn(day, db);
      result.steps[name].ms = Date.now() - s0;
      log.log(`[daily]   ${name}: ${JSON.stringify(result.steps[name])}`);
    }

    return finish('OK', {
      guardStatus: g.status,
      rowsWritten: result.steps.build?.rows ?? 0,
      rowsMissing: result.steps.missing?.rows ?? 0,
    });
  } catch (e) {
    log.error(`[daily] ${day} failed:`, e.message);
    result.error = e.message;
    return finish('FAILED', { detail: { error: e.message, steps: result.steps } });
  }
}

/**
 * Backfill a range, OLDEST FIRST.
 *
 * The order is enforced rather than assumed: each day's sequence guard checks
 * that the previous session is already computed, so a range run backwards
 * stops on the second day instead of quietly producing wrong prev_close values
 * for all of them.
 */
async function backfill({ from, to, db = pool, log = console, force = false } = {}) {
  const { rows: days } = await db.query(
    `SELECT trading_day FROM spread.trading_day
      WHERE is_session AND trading_day BETWEEN $1 AND $2
      ORDER BY trading_day ASC;`, [from, to]);

  const out = [];
  for (const [i, d] of days.entries()) {
    const day = toDay(d.trading_day);
    const r = await run({ date: day, db, log, force, allowFirst: i === 0 });
    out.push({ day, status: r.status, rows: r.steps?.build?.rows ?? 0 });

    // A day that did not compute breaks the chain. Continuing would give every
    // later day the wrong previous session.
    if (r.status === 'FAILED' || r.status === 'SKIPPED') {
      log.error(`[backfill] stopped at ${day} — ${r.status}. Later days would ` +
                'resolve prev_close against the wrong session.');
      break;
    }
  }
  return out;
}

/** Has today's job already succeeded? Used by the 14:30 retry. */
async function lastRun(day, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM spread.job_run
      WHERE job_name='daily' AND trading_day=$1
      ORDER BY started_at DESC LIMIT 1;`, [day]);
  return rows[0] || null;
}

module.exports = { run, backfill, sessionGuard, sequenceGuard, lastRun, kuwaitDay,
  resolveSourceTable };

if (require.main === module) {
  /*
   * ARGUMENT PARSING, and npm is the reason it is not simpler.
   *
   * `npm run job:daily -- --from X --to Y` does NOT reliably reach here as
   * flags: npm consumes `--from` and `--to` as its own options, and the dates
   * arrive as bare positionals. The observed result was
   *
   *   node src/jobs/daily/index.js 2026-08-09 2026-08-13
   *
   * with no flags at all, so the parser saw nothing and silently ran today.
   *
   * So POSITIONAL DATES ARE THE PRIMARY FORM and flags are accepted as well.
   * One date is a single day; two are a range.
   */
  /*
   * D-01 · this entry point is INERT and says so.
   *
   * 015 dropped spread.job_run, spread.symbol and depth_watchlist; symbol_day
   * and market_day are views. Every write below fails on the first statement.
   * The npm script is gone; running the file directly gets this, not a stack
   * trace. The module stays because routes.js imports kuwaitDay() from it.
   */
  console.error('jobs/daily is INERT. The scraper computes public.symbol_day; the backend reads it\n'
    + 'through spread.symbol_day and adds its own gate statistics with `npm run stats:daily`\n'
    + '(src/jobs/stats). See README "Who computes what".');
  process.exit(2);
  // eslint-disable-next-line no-unreachable
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const dates = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

  const from = flag('--from') || dates[0] || null;
  const to = flag('--to') || dates[1] || from;
  const single = flag('--date') || (dates.length === 1 && !flag('--from') ? dates[0] : null);
  /*
   * npm CONSUMES --force AS ITS OWN OPTION.
   *
   *   npm run job:daily 2026-08-13 --force
   *   npm warn using --force  Recommended protections disabled.
   *   > node src/jobs/daily/index.js 2026-08-13        <- the flag is gone
   *
   * So the flag silently did nothing. `partial` is a word npm has no opinion
   * about, and an environment variable works regardless of what npm strips.
   */
  const force = argv.includes('--partial') || argv.includes('--force')
    || process.env.SPREAD_FORCE === '1';

  if (!from && !single) {
    console.log('Usage:');
    console.log('  npm run job:daily 2026-08-13                    one day');
    console.log('  npm run job:daily 2026-08-09 2026-08-13         a range, oldest first');
    console.log('  npm run job:daily 2026-08-13 --partial          run before 13:25');
    console.log('');
    console.log('  Note: npm eats --force and --from/--to. Positional dates and');
    console.log('  --partial survive; SPREAD_FORCE=1 works regardless.');
    console.log('');
    console.log('Today\'s session is ' + kuwaitDay() + '. Running with no date does that day.');
  }

  const task = (from && to && from !== to)
    ? backfill({ from, to, force })
    : run({ date: single || from, force });

  task
    .then((r) => {
      console.log(JSON.stringify(r, null, 1));
      const ok = Array.isArray(r) ? r.every((x) => x.status === 'OK') : r.status === 'OK';
      process.exit(ok ? 0 : 1);
    })
    .catch((e) => require('../../lib/dberror').die(e));
}
