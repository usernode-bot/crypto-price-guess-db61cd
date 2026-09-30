'use strict';

// Pure helpers for the on-chain payment config that the frontend reads and the
// server enforces. Dependency-free on purpose so they're unit-testable without
// a database or a running HTTP server.

// Placeholder app wallet surfaced to the staging frontend so the guess form
// still has a destination for its mock transaction when APP_PUBKEY is unset.
const STAGING_APP_PUBKEY = 'ut1stagingappwallet000000000000000000';

// The app wallet that receives 1-token guess payments. Production MUST provide
// a real APP_PUBKEY; staging falls back to the placeholder (it skips on-chain
// verification anyway). Production with no APP_PUBKEY resolves to '' — there is
// no destination, so payments are not configured.
function resolveAppPubkey(appPubkey, isStaging) {
  if (appPubkey) return appPubkey;
  return isStaging ? STAGING_APP_PUBKEY : '';
}

// Whether on-chain guess payments can actually be made/verified. Staging is
// always "configured" (placeholder destination + verification skipped);
// production requires a real APP_PUBKEY.
function paymentsConfigured(appPubkey, isStaging) {
  return !!resolveAppPubkey(appPubkey, isStaging);
}

// Build the /api/config response body. The authenticated user's linked wallet
// address (usernode_pubkey) is included ONLY when a user is present, so the
// public/unauthenticated path never leaks an address. The frontend uses this
// value — not merely "the bridge returned some address" — as the source of
// truth for whether the wallet is linked, matching the server's /api/guess gate.
function buildConfig({ appPubkey, chainId, isStaging, explorerBase, user } = {}) {
  return {
    app_pubkey: resolveAppPubkey(appPubkey, isStaging),
    chain_id: chainId || 'usernode',
    staging: !!isStaging,
    is_staging: !!isStaging,
    explorer_base: explorerBase || null,
    payments_configured: paymentsConfigured(appPubkey, isStaging),
    usernode_pubkey: user ? (user.usernode_pubkey || null) : null,
  };
}

module.exports = {
  STAGING_APP_PUBKEY,
  resolveAppPubkey,
  paymentsConfigured,
  buildConfig,
};
