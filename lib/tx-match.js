// lib/tx-match.js — verify that an on-chain transaction matches an expected
// guess payment. Vendored shared helper (canonical source lives in
// usernode-dapp-starter at examples/lib/tx-match.js); per platform convention
// fixes propagate by re-vendoring, not by editing this copy in place.
//
// It looks a transaction up by hash against the Usernode node
// (process.env.NODE_RPC_URL — platform-managed, points at usernode-node in
// prod) and asserts its to / from / amount / memo and confirmation status
// against the values the caller expects. Field access is intentionally
// defensive: the node/explorer JSON shape is normalized through a set of
// common aliases so a minor upstream rename doesn't silently pass a bad match.
//
// Fails CLOSED: any lookup error, missing config, unconfirmed tx, or field
// mismatch resolves to { ok: false } so a guess is never recorded against an
// unverifiable payment. Staging skips this module entirely (no real chain).

const NODE_RPC_URL = process.env.NODE_RPC_URL || '';

function firstDefined(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// Pull a transaction object out of whatever envelope the node returns
// (bare object, { transaction }, { tx }, { result }, or a [tx] array).
function unwrapTx(json) {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json)) return json[0] || null;
  const inner = firstDefined(json, ['transaction', 'tx', 'result', 'data']);
  if (inner && typeof inner === 'object') return Array.isArray(inner) ? inner[0] : inner;
  return json;
}

function normalizeTx(raw) {
  const tx = unwrapTx(raw);
  if (!tx) return null;
  const confirmedFlag = firstDefined(tx, ['confirmed', 'included', 'finalized', 'success']);
  const status = firstDefined(tx, ['status', 'state']);
  const blockHeight = firstDefined(tx, ['blockHeight', 'block_height', 'height', 'blockNumber', 'block']);
  const confirmed =
    confirmedFlag === true ||
    (typeof status === 'string' && /^(confirmed|included|finalized|success|ok)$/i.test(status)) ||
    (blockHeight != null && Number(blockHeight) > 0);
  return {
    to: firstDefined(tx, ['to', 'recipient', 'destination', 'dest', 'destination_pubkey', 'toAddress']) || null,
    from: firstDefined(tx, ['from', 'sender', 'source', 'src', 'sender_pubkey', 'fromAddress']) || null,
    amount: firstDefined(tx, ['amount', 'value', 'tokens', 'qty']),
    memo: firstDefined(tx, ['memo', 'note', 'data', 'message']) || '',
    confirmed,
    raw: tx,
  };
}

// Candidate lookup URLs — the node exposes a tx-by-hash endpoint; try the
// common shapes so a path tweak upstream doesn't break verification.
function lookupUrls(base, chainId, txHash) {
  const b = base.replace(/\/+$/, '');
  const h = encodeURIComponent(txHash);
  const c = encodeURIComponent(chainId);
  return [
    `${b}/${c}/transactions/${h}`,
    `${b}/transactions/${h}`,
    `${b}/${c}/tx/${h}`,
    `${b}/tx/${h}`,
  ];
}

async function fetchTx(chainId, txHash) {
  if (!NODE_RPC_URL) return null;
  for (const url of lookupUrls(NODE_RPC_URL, chainId, txHash)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const json = await res.json();
      const tx = normalizeTx(json);
      if (tx && (tx.to || tx.from || tx.amount != null)) return tx;
    } catch {
      // try the next candidate URL
    }
  }
  return null;
}

function amountMatches(actual, expected) {
  if (actual == null) return false;
  const a = Number(actual);
  if (!Number.isFinite(a)) return false;
  return a === Number(expected);
}

/**
 * Verify a guess payment transaction.
 *
 * @param {object} opts
 * @param {string} opts.txHash         on-chain transaction hash/id to look up
 * @param {string} opts.chainId        chain identifier for the lookup path
 * @param {string} opts.expectedTo     app wallet that must have received the payment
 * @param {string} opts.expectedFrom   player's linked wallet that must have sent it
 * @param {number} opts.expectedAmount token amount that must have been transferred (1)
 * @param {string} opts.expectedMemo   exact memo binding the tx to this guess
 * @returns {Promise<{ok: boolean, reason?: string, tx?: object}>}
 */
async function verifyGuessTransaction(opts) {
  const { txHash, chainId, expectedTo, expectedFrom, expectedAmount, expectedMemo } = opts || {};
  if (!txHash) return { ok: false, reason: 'missing tx hash' };
  if (!expectedTo) return { ok: false, reason: 'app wallet not configured' };
  if (!expectedFrom) return { ok: false, reason: 'sender wallet not linked' };

  // A brief retry/backoff absorbs explorer propagation lag — the bridge
  // already awaits inclusion before sendTransaction resolves, so this is
  // usually a single round-trip.
  let tx = null;
  for (let attempt = 0; attempt < 3 && !tx; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
    tx = await fetchTx(chainId, txHash);
  }
  if (!tx) return { ok: false, reason: 'transaction not found' };
  if (!tx.confirmed) return { ok: false, reason: 'transaction not confirmed' };
  if (tx.to !== expectedTo) return { ok: false, reason: 'recipient mismatch', tx };
  if (tx.from !== expectedFrom) return { ok: false, reason: 'sender mismatch', tx };
  if (!amountMatches(tx.amount, expectedAmount)) return { ok: false, reason: 'amount mismatch', tx };
  if ((tx.memo || '') !== expectedMemo) return { ok: false, reason: 'memo mismatch', tx };

  return { ok: true, tx };
}

module.exports = { verifyGuessTransaction, normalizeTx };
