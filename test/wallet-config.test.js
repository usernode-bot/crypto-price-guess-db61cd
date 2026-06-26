'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STAGING_APP_PUBKEY,
  resolveAppPubkey,
  paymentsConfigured,
  buildConfig,
} = require('../lib/wallet-config');

test('resolveAppPubkey returns the configured app wallet when set', () => {
  assert.equal(resolveAppPubkey('ut1realappwallet', false), 'ut1realappwallet');
  assert.equal(resolveAppPubkey('ut1realappwallet', true), 'ut1realappwallet');
});

test('resolveAppPubkey falls back to the staging placeholder only in staging', () => {
  assert.equal(resolveAppPubkey('', true), STAGING_APP_PUBKEY);
  assert.equal(resolveAppPubkey('', false), '');
});

test('paymentsConfigured: production needs a real APP_PUBKEY', () => {
  // Production with no app wallet → not configured (drives /api/guess 503).
  assert.equal(paymentsConfigured('', false), false);
  // Production with an app wallet → configured.
  assert.equal(paymentsConfigured('ut1realappwallet', false), true);
  // Staging is always configured (placeholder destination + verification skip).
  assert.equal(paymentsConfigured('', true), true);
});

test('buildConfig exposes usernode_pubkey only when a user is present', () => {
  const authed = buildConfig({
    appPubkey: 'ut1realappwallet',
    chainId: 'usernode',
    isStaging: false,
    explorerBase: null,
    user: { id: 1, username: 'alice', usernode_pubkey: 'ut1alicewallet' },
  });
  assert.equal(authed.usernode_pubkey, 'ut1alicewallet');
  assert.equal(authed.payments_configured, true);
  assert.equal(authed.app_pubkey, 'ut1realappwallet');

  // Unauthenticated (public) call must never leak an address.
  const anon = buildConfig({ appPubkey: 'ut1realappwallet', isStaging: false });
  assert.equal(anon.usernode_pubkey, null);

  // Authenticated user without a linked wallet → null, not undefined.
  const noWallet = buildConfig({
    appPubkey: 'ut1realappwallet',
    isStaging: false,
    user: { id: 2, username: 'bob', usernode_pubkey: null },
  });
  assert.equal(noWallet.usernode_pubkey, null);
});

test('buildConfig reports payments_configured:false in production with no app wallet', () => {
  const cfg = buildConfig({ appPubkey: '', isStaging: false, user: { id: 1, username: 'a', usernode_pubkey: 'ut1x' } });
  assert.equal(cfg.payments_configured, false);
  assert.equal(cfg.app_pubkey, '');
});

test('buildConfig in staging is configured and uses the placeholder wallet', () => {
  const cfg = buildConfig({ appPubkey: '', isStaging: true });
  assert.equal(cfg.payments_configured, true);
  assert.equal(cfg.app_pubkey, STAGING_APP_PUBKEY);
  assert.equal(cfg.is_staging, true);
  assert.equal(cfg.staging, true);
});
