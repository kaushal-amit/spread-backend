'use strict';
/**
 * ============================================================================
 *  scraperClient.js — the backend's one caller of the scraper's ingest API (G-1)
 * ============================================================================
 * The scraper owns public.depth_watchlist; the backend decides which slot to
 * displace on a halt but may not write it, so it asks the scraper to apply the
 * swap — POST /ingest/slots/:n. This is the ONLY place the backend calls the
 * scraper, so the base URL and token live here, from the environment.
 *
 * Every call is bounded at 5 s. A network error or a timeout is returned as a
 * shaped result ({ ok:false, networkError:true }), never thrown into the poll —
 * the halt must still alert even when the scraper is unreachable (G-1).
 * ============================================================================
 */
const log = require('../lib/log');

const BASE = process.env.SCRAPER_INGEST_URL || null; // e.g. http://127.0.0.1:8080/ingest
const TOKEN = process.env.SCRAPER_INGEST_TOKEN || process.env.INGEST_TOKEN || null;
const TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 5000);

/** POST /ingest/slots/:n. Returns { ok, status, row, body } or { ok:false,
 *  networkError:true, reason }. Never throws. */
async function applySlot(n, { symbol, reason = 'HALT', replacedSymbol = null } = {}) {
  if (!BASE) return { ok: false, networkError: true, reason: 'SCRAPER_URL_UNSET' };
  const url = `${BASE.replace(/\/$/, '')}/slots/${n}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-ingest-token': TOKEN } : {}) },
      body: JSON.stringify({ symbol, reason, replaced_symbol: replacedSymbol }),
      signal: ctrl.signal,
    });
    let body = null; try { body = await res.json(); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, row: body && body.row ? body.row : null, body };
  } catch (e) {
    log.warn('[scraper] slot apply failed', { n, symbol, err: e.message });
    return { ok: false, networkError: true, reason: 'SCRAPER_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /ingest/depth-symbols — used for the slot count (G-5). Best-effort. */
async function depthSymbols() {
  if (!BASE) return null;
  const url = `${BASE.replace(/\/$/, '')}/depth-symbols`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: TOKEN ? { 'x-ingest-token': TOKEN } : {} });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

module.exports = { applySlot, depthSymbols, BASE };
