// tools/run-once-judge.mjs
// WHY: status=ok alone is a self-report; a stub that just prints ok must FAIL.
// decide() is PURE: line = one RUN-ONCE text line, ctx = { botSha256, state }.
// No network, no token, no spawned service. CLI wrapper reads the three files.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function decide(line, ctx) {
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
  if (o.healthService !== true) return { verdict: 'FAIL', reason: 'HEALTH_SERVICE_MISMATCH' };
  if (o.healthCodeHash !== ctx.botSha256) return { verdict: 'FAIL', reason: 'CODEHASH_MISMATCH' };
  if (o.healthMatchesDisk !== true) return { verdict: 'FAIL', reason: 'HASH_SELFCHECK_FALSE' };
  if (o.botStatus !== 'ok' || o.needsRelogin !== false)
    return { verdict: 'FAIL', reason: 'BOT_DEGRADED' };
  if (o.lastError !== null) return { verdict: 'FAIL', reason: 'BOT_REPORTED_ERROR' };
  if (!Number.isInteger(o.received) || !Number.isInteger(o.replied) || o.replied > o.received)
    return { verdict: 'FAIL', reason: 'COUNT_INCONSISTENT' };
  if (o.sendMessageCalls !== o.replied) return { verdict: 'FAIL', reason: 'SEND_CALL_MISMATCH' };
  if (!Number.isInteger(o.getUpdatesBufLen) || o.getUpdatesBufLen < 0)
    return { verdict: 'FAIL', reason: 'NO_STATE_PERSISTED' };
  const st = ctx.state;
  if (!st || typeof st.getUpdatesBuf !== 'string' || st.getUpdatesBuf.length !== o.getUpdatesBufLen)
    return { verdict: 'FAIL', reason: 'STATE_BUF_LEN_MISMATCH' };
  if (!Array.isArray(st.seen)) return { verdict: 'FAIL', reason: 'STATE_SEEN_MISSING' };
  return { verdict: 'PASS', reason: 'ONE_POLL_CYCLE_COMPLETED' };
}

function selftest() {
  const SHA = 'a'.repeat(64);
  const GOOD = { status: 'ok', received: 1, replied: 1, getUpdatesBufLen: 6,
    getUpdatesCalls: 1, sendMessageCalls: 1, healthCodeHash: SHA,
    healthService: true, healthMatchesDisk: true, botStatus: 'ok',
    needsRelogin: false, lastError: null, runCompleted: true };
  const ctx = { botSha256: SHA, state: { getUpdatesBuf: 'cursor', seen: ['m1'] } };
  const line = (o) => 'RUN-ONCE ' + JSON.stringify(o);
  const cases = [
    { n: 'positive',          l: line(GOOD),                                   c: ctx, v: 'PASS', r: 'ONE_POLL_CYCLE_COMPLETED' },
    { n: 'nc1_no_poll',       l: line({ ...GOOD, getUpdatesCalls: 0 }),       c: ctx, v: 'FAIL', r: 'NO_GETUPDATES_CALL' },
    { n: 'nc2_swapped_bot',   l: line({ ...GOOD, healthCodeHash: 'b'.repeat(64) }), c: ctx, v: 'FAIL', r: 'CODEHASH_MISMATCH' },
    { n: 'nc3_bad_json',      l: 'RUN-ONCE ok',                                c: ctx, v: 'FAIL', r: 'BAD_JSON' },
    { n: 'nc4_daemon_output', l: 'DSH-ILINK-BOT stopped {...}',                c: ctx, v: 'FAIL', r: 'NO_RUN_ONCE_LINE' },
    { n: 'nc5_stale_token',   l: line({ ...GOOD, botStatus: 'needs_relogin', needsRelogin: true }), c: ctx, v: 'FAIL', r: 'BOT_DEGRADED' },
    { n: 'nc6_network_error', l: line({ ...GOOD, lastError: 'network error' }), c: ctx, v: 'FAIL', r: 'BOT_REPORTED_ERROR' },
    { n: 'nc7_fake_reply',    l: line({ ...GOOD, sendMessageCalls: 0 }),       c: ctx, v: 'FAIL', r: 'SEND_CALL_MISMATCH' },
    { n: 'nc8_no_state',      l: line(GOOD),                                   c: { botSha256: SHA, state: null }, v: 'FAIL', r: 'STATE_BUF_LEN_MISMATCH' },
    { n: 'nc9_hash_flag',     l: line({ ...GOOD, healthMatchesDisk: false }),  c: ctx, v: 'FAIL', r: 'HASH_SELFCHECK_FALSE' },
  ];
  const reasons = new Set();
  for (const k of cases) {
    const got = decide(k.l, k.c);
    if (got.verdict !== k.v || got.reason !== k.r) {
      console.error('SELFTEST-MISMATCH ' + k.n + ' got=' + JSON.stringify(got) + ' want=' + k.v + '/' + k.r);
      process.exitCode = 1;
      return;
    }
    reasons.add(got.reason);
  }
  // D10.2 self-check: a judge that collapses every case to one reason has no
  // discriminating power. 10 cases must yield 10 distinct reasons.
  if (reasons.size !== cases.length) {
    console.error('SELFTEST-DEGENERATE distinct_reasons=' + reasons.size);
    process.exitCode = 1;
    return;
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
    // Take the LAST structured line; bot.mjs warn() output may trail it.
    const last = lines.filter((l) => l.trim().indexOf('RUN-ONCE ') === 0).pop() || '';
    const sha = createHash('sha256').update(readFileSync(botPath)).digest('hex');
    let state = null;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { state = null; }
    const r = decide(last, { botSha256: sha, state });
    console.log('RUN-ONCE-JUDGE ' + r.verdict + ' ' + r.reason);
    if (r.verdict !== 'PASS') process.exitCode = 1;
  }
}
