'use strict';
/**
 * ============================================================================
 *  dberror.js — turn a driver error into something actionable
 * ============================================================================
 * `getaddrinfo ENOTFOUND trading-db.…rds.amazonaws.com` is accurate and useless.
 * It does not say whether the instance is stopped, the host is wrong, or the
 * network is down — and those need three different responses.
 *
 * Every entry point wraps its failure here, so a connection problem never looks
 * like a code problem. That distinction has already cost time once: the app ran
 * fine, then the same command failed with a raw driver string and nothing said
 * it was infrastructure.
 * ============================================================================
 */

function explain(err, { url = process.env.DATABASE_URL } = {}) {
  const host = (() => {
    try { return new URL(url).hostname; } catch { return null; }
  })();

  const c = err?.code;

  if (c === 'ENOTFOUND') {
    return {
      kind: 'dns',
      title: `cannot resolve ${host || 'the database host'}`,
      why: 'DNS has no record for that name. On RDS this usually means the instance ' +
           'is STOPPED — a stopped instance loses its DNS entry — or the hostname in ' +
           'DATABASE_URL is wrong.',
      check: [
        `nslookup ${host || '<host>'}`,
        'AWS console → RDS → Databases → is the status "Available"?',
        'RDS stops an instance automatically 7 days after a temporary stop',
        'check DATABASE_URL in .env for a typo or a stale endpoint',
      ],
    };
  }
  if (c === 'ETIMEDOUT' || c === 'ECONNREFUSED') {
    return {
      kind: 'network',
      title: `${host || 'the database'} resolves but will not accept a connection`,
      why: 'The name resolves, so the instance exists. Something between here and it ' +
           'is refusing — usually a security group, a VPN that is not connected, or ' +
           'the wrong port.',
      check: [
        'RDS → Connectivity & security → is your IP in the inbound rules?',
        'is the VPN connected?',
        'is the port right? RDS Postgres defaults to 5432',
      ],
    };
  }
  if (c === '28P01' || c === '28000') {
    return { kind: 'auth', title: 'the database rejected the credentials',
      why: 'The host is reachable and the user or password is wrong.',
      check: ['check the user and password in DATABASE_URL',
              'a password with @ : / or ? must be percent-encoded'] };
  }
  if (c === '3D000') {
    return { kind: 'database', title: 'that database does not exist',
      why: 'The server is reachable and the database name in DATABASE_URL is not there.',
      check: ['psql "$DATABASE_URL" -c "\\\\l" — with the database name removed',
              'the schema is `spread` INSIDE a database; it is not a database itself'] };
  }
  if (c === '42P01') {
    return { kind: 'schema', title: 'a table or view is missing',
      why: err.message,
      check: ['npm run migrate', 'npm run doctor'] };
  }
  return { kind: 'unknown', title: err?.message || String(err), why: null, check: [] };
}

/** Print it and exit. Used by every CLI entry point. */
function die(err, { url } = {}) {
  const e = explain(err, { url });
  console.error('');
  console.error(`  ${e.title}`);
  if (e.why) console.error(`  ${e.why}`);
  if (e.check.length) {
    console.error('');
    console.error('  Check:');
    for (const c of e.check) console.error(`    · ${c}`);
  }
  if (e.kind !== 'schema') {
    console.error('');
    console.error('  This is not a code problem — nothing in the app has changed.');
  }
  console.error('');
  process.exit(1);
}

module.exports = { explain, die };
