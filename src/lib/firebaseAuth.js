'use strict';
/**
 * ============================================================================
 *  lib/firebaseAuth.js — verify a Firebase ID token (D3)
 * ============================================================================
 * The SPA signs in with Firebase Auth (Google) and sends the ID token; this
 * verifies it with the Admin SDK. Verification is a LOCAL signature check
 * against Google's public keys (fetched once and cached by the SDK) — no
 * network round-trip per request, and no service-account credential is
 * needed for verifyIdToken (only the project id). GOOGLE_APPLICATION_CREDENTIALS
 * is honoured when set, for anything else the SDK is asked later.
 *
 * Nothing here decides WHO may use the terminal: auth.js holds the allowlist.
 * This module answers one question — is this a valid, unexpired ID token for
 * FIREBASE_PROJECT_ID, and whose is it.
 *
 * Configured only when FIREBASE_PROJECT_ID is set; otherwise `verify` throws
 * NOT_CONFIGURED, which auth.js turns into a 401 naming the variable — a
 * browser token against an unconfigured server is a refusal, not a pass.
 * ============================================================================
 */
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || null;

let app = null;
function admin() {
  if (app) return app;
  const fb = require('firebase-admin');
  app = fb.apps.length ? fb.app() : fb.initializeApp({ projectId: PROJECT_ID });
  return app;
}

/**
 * → { uid, email, exp (unix seconds), iat }
 * throws { code: 'NOT_CONFIGURED' | 'TOKEN_EXPIRED' | 'BAD_TOKEN', message }
 */
async function verify(idToken) {
  if (!PROJECT_ID) { const e = new Error('FIREBASE_PROJECT_ID is not set — the server cannot verify a sign-in'); e.code = 'NOT_CONFIGURED'; throw e; }
  try {
    const d = await admin().auth().verifyIdToken(String(idToken), false);
    return { uid: d.uid, email: d.email || null, exp: d.exp, iat: d.iat };
  } catch (err) {
    // The SDK's codes: auth/id-token-expired, auth/argument-error, auth/id-token-revoked …
    const expired = /expired/i.test(err?.code || '') || /expired/i.test(err?.message || '');
    const e = new Error(expired ? 'the sign-in token has expired — refresh it' : 'the sign-in token is not valid for this server');
    e.code = expired ? 'TOKEN_EXPIRED' : 'BAD_TOKEN';
    e.cause = err;
    throw e;
  }
}

module.exports = { verify, configured: () => !!PROJECT_ID, PROJECT_ID };
