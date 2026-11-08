// tools/run-once-judge.mjs
// WHY: status=ok alone is a self-report; a stub printing ok must FAIL.
// decide() is PURE. H1/H2 (round 43): require a REAL provider response
// (getUpdatesResponded>=1) + non-empty cursor, and bind to the ABSOLUTE
// FROZEN_BOT_SHA256 constant so a consistently swapped bot.mjs fails.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FROZEN_BOT_SHA256 = '9f4138c534582e583a5de27e3de68950ad6f6b5881947aacee82aa77aff3c268';

export function decide(line, ctx) {
  const c = ctx || {};
  const s = String(line || '').trim();
  const P = 'RUN-ONCE ';
  if (s.indexOf(P) !== 0) return { verdict: 'FAIL', reason: 'NO_RUN_ONCE_LINE' };
  let o;
  try { o = JSON.parse(s.slice(P.length)); }
  catch { return { verdict: 'FAIL', reason: 'BAD_JSON' }; }
  if (o.status !== 'ok') return { verdict: 'FAIL', reason: 'SELF_REPORT_NOT_OK' };
  if (o.runCompleted !== true) return { verdict: 'FAIL', reason: 'RUN_DID_NOT_COMPLETE' };
  if (!Number.isInteger(o.getUpdatesCalls) || o.getUpdatesCalls < 1)
    return { verdict: 'FAIL', reason: 'NO_GETUPDATES_CALL' };
  if (!Number.isInteger(o.getUpdatesResponded) || o.getUpdatesResponded < 1)
    return { verdict: 'FAIL', reason: 'NO_PROVIDER_RESPONSE' };
  if (o.healthService !== true) return { verdict: 'FAIL', reason: 'HEALTH_SERVICE_MISMATCH' };
  if (o.healthCodeHash !== FROZEN_BOT_SHA256 || c.botSha256 !== FROZEN_BOT_SHA256)
    return { verdict: 'FAIL', reason: 'FROZEN_BOT_PIN_MISMATCH' };
  if (o.healthMatchesDisk !== true) return { verdict: 'FAIL', reason: 'HASH_SELFCHECK_FALSE' };
  if (o.botStatus !== 'ok' || o.needsRelogin !== false)
    return { verdict: 'FAIL', reason: 'BOT_DEGRADED' };
  if (o.lastError !== null) return { verdict: 'FAIL', reason: 'BOT_REPORTED_ERROR' };
  if (!Number.isInteger(o.received) || !Number.isInteger(o.replied) || o.replied > o.received)
    return { verdict: 'FAIL', reason: 'COUNT_INCONSISTENT' };
  if (o.sendMessageCalls !== o.replied) return { verdict: 'FAIL', reason: 'SEND_CALL_MISMATCH' };
  if (!Number.isInteger(o.getUpdatesBufLen) || o.getUpdatesBufLen < 0)
    return { verdict: 'FAIL', reason: 'NO_STATE_PERSISTED' };
  if (o.getUpdatesBufLen === 0)
    return { verdict: 'FAIL', reason: 'SWALLOWED_TIMEOUT_EMPTY_CURSOR' };
  const st = c.state;
  if (!st || typeof st.getUpdatesBuf !== 'string' || st.getUpdatesBuf.length !== o.getUpdatesBufLen)
    return { verdict: 'FAIL', reason: 'STATE_BUF_LEN_MISMATCH' };
  if (!Array.isArray(st.seen)) return { verdict: 'FAIL', reason: 'STATE_SEEN_MISSING' };
  return { verdict: 'PASS', reason: 'ONE_POLL_CYCLE_COMPLETED' };
}

function selftest() {
  const SHA = FROZEN_BOT_SHA256;
  // Synthetic positive (adapter is POLL-ONLY so real runs are 0/0/0/0).
  const GOOD = { status: 'ok', received: 0, replied: 0, getUpdatesBufLen: 6,
    getUpdatesCalls: 1, getUpdatesResponded: 1, sendMessageCalls: 0, blockedSends: 0,
    healthCodeHash: SHA, healthService: true, healthMatchesDisk: true,
    botStatus: 'ok', needsRelogin: false, lastError: null, runCompleted: true };
  const ctx = { botSha256: SHA, state: { getUpdatesBuf: 'cursor', seen: ['m1'] } };
  const line = (o) => 'RUN-ONCE ' + JSON.stringify(o);
  const cases = [
    { n: 'positive',     l: line(GOOD),                                          c: ctx,                                              v: 'PASS', r: 'ONE_POLL_CYCLE_COMPLETED' },
    { n: 'nc_no_poll',   l: line({ ...GOOD, getUpdatesCalls: 0 }),              c: ctx,                                              v: 'FAIL', r: 'NO_GETUPDATES_CALL' },
    { n: 'nc_no_resp',   l: line({ ...GOOD, getUpdatesResponded: 0 }),          c: ctx,                                              v: 'FAIL', r: 'NO_PROVIDER_RESPONSE' },
    { n: 'nc_swapped',   l: line({ ...GOOD, healthCodeHash: 'b'.repeat(64) }),  c: ctx,                                              v: 'FAIL', r: 'FROZEN_BOT_PIN_MISMATCH' },
    { n: 'nc_bad_json',  l: 'RUN-ONCE ok',                                       c: ctx,                                              v: 'FAIL', r: 'BAD_JSON' },
    { n: 'nc_daemon',    l: 'DSH-ILINK-BOT stopped {...}',                       c: ctx,                                              v: 'FAIL', r: 'NO_RUN_ONCE_LINE' },
    { n: 'nc_stale',     l: line({ ...GOOD, botStatus: 'needs_relogin', needsRelogin: true }), c: ctx,                          v: 'FAIL', r: 'BOT_DEGRADED' },
    { n: 'nc_neterr',    l: line({ ...GOOD, lastError: 'network error' }),      c: ctx,                                              v: 'FAIL', r: 'BOT_REPORTED_ERROR' },
    { n: 'nc_fake_reply',l: line({ ...GOOD, sendMessageCalls: 5 }),             c: ctx,                                              v: 'FAIL', r: 'SEND_CALL_MISMATCH' },
    { n: 'nc_no_state',  l: line(GOOD),                                          c: { botSha256: SHA, state: null },                    v: 'FAIL', r: 'STATE_BUF_LEN_MISMATCH' },
    { n: 'nc_hash_flag', l: line({ ...GOOD, healthMatchesDisk: false }),        c: ctx,                                              v: 'FAIL', r: 'HASH_SELFCHECK_FALSE' },
    { n: 'nc_empty_cur', l: line({ ...GOOD, getUpdatesBufLen: 0 }),             c: ctx,                                              v: 'FAIL', r: 'SWALLOWED_TIMEOUT_EMPTY_CURSOR' },
    { n: 'nc_not_ok',    l: line({ ...GOOD, status: 'fail' }),                  c: ctx,                                              v: 'FAIL', r: 'SELF_REPORT_NOT_OK' },
    { n: 'nc_not_done',  l: line({ ...GOOD, runCompleted: false }),             c: ctx,                                              v: 'FAIL', r: 'RUN_DID_NOT_COMPLETE' },
    { n: 'nc_service',   l: line({ ...GOOD, healthService: false }),            c: ctx,                                              v: 'FAIL', r: 'HEALTH_SERVICE_MISMATCH' },
    { n: 'nc_count',     l: line({ ...GOOD, received: 0, replied: 1 }),         c: ctx,                                              v: 'FAIL', r: 'COUNT_INCONSISTENT' },
    { n: 'nc_neg_len',   l: line({ ...GOOD, getUpdatesBufLen: -1 }),            c: ctx,                                              v: 'FAIL', r: 'NO_STATE_PERSISTED' },
    { n: 'nc_seen',      l: line(GOOD),                                          c: { botSha256: SHA, state: { getUpdatesBuf: 'cursor', seen: 'x' } }, v: 'FAIL', r: 'STATE_SEEN_MISSING' },
  ];
  const reasons = new Set();
  for (const k of cases) {
    const got = decide(k.l, k.c);
    if (got.verdict !== k.v || got.reason !== k.r) {
      console.error('SELFTEST-MISMATCH ' + k.n + ' got=' + JSON.stringify(got) + ' want=' + k.v + '/' + k.r);
      process.exitCode = 1; return;
    }
    reasons.add(got.reason);
  }
  // D10.2: a judge collapsing every case to one reason has no discriminating power.
  if (reasons.size !== cases.length) {
    console.error('SELFTEST-DEGENERATE distinct_reasons=' + reasons.size);
    process.exitCode = 1; return;
  }
  console.log('RUN-ONCE-JUDGE-SELFTEST OK cases=' + cases.length + ' teeth=' + (cases.length - 1) + ' distinct_reasons=' + reasons.size);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes('--selftest')) { selftest(); }
  else {
    const [logPath, statePath, botPath] = process.argv.slice(2);
    const txt = readFileSync(logPath, 'utf8');
    const lines = txt.split(String.fromCharCode(10));
    const last = lines.filter((l) => l.trim().indexOf('RUN-ONCE ') === 0).pop() || '';
    const sha = createHash('sha256').update(readFileSync(botPath)).digest('hex');
    let state = null;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { state = null; }
    const r = decide(last, { botSha256: sha, state });
    console.log('RUN-ONCE-JUDGE ' + r.verdict + ' ' + r.reason);
    if (r.verdict !== 'PASS') process.exitCode = 1;
  }
}
