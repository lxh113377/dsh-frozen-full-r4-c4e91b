// ilink-token-probe.mjs - off-PC iLink token acceptance probe (read-only)
// WHY: the GH-Actions always-on carrier lives or dies on one unknown - can an
// ubuntu-latest runner holding the server-own real token reach iLink and get a
// VALID sync cursor (not errcode -14)? The local PC proved the token works
// (bufLen=96); runner egress IP / geo / edge auth was UNATTESTED.
// HOW: three getupdates calls - real token from env (NEVER printed), a
// no-token control, and a synthetic bad-token control (proves the VALUE is
// checked, not just header presence). judge() is a pure function of the three
// shapes; --selftest runs synthetic teeth with zero network. Never logs token.

import { pathToFileURL } from 'node:url';
import { createClient, rejectedProviderResponse } from '../../server-deploy/bot.mjs';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com/';

// Deterministic fake token, never the real one. Third arm proves iLink checks
// the token VALUE: if a bogus Bearer ALSO yields a valid cursor, the probe is
// blind and must stay NOT_PROVEN. Constant so every run is auditable.
const SYNTHETIC_BAD_TOKEN = 'dsh-synthetic-bad-token-not-a-real-credential';

// Reduce a provider response to comparable metadata; never echoes the token.
function shape(r, ok, extra) {
  const o = {
    ok: ok,
    ret: r && r.ret,
    errcode: r && r.errcode,
    msgs: Array.isArray(r && r.msgs) ? r.msgs.length : -1,
    bufLen: r && typeof r.get_updates_buf === 'string' ? r.get_updates_buf.length : -1,
  };
  if (extra) {
    if (extra.err) o.err = extra.err;
    if (extra.code) o.code = extra.code;
    if (extra.providerCode) o.providerCode = extra.providerCode;
  }
  return o;
}

// One long-poll. On client timeout getUpdates swallows into an empty buf
// (bufLen 0) - that is NOT acceptance, it is the trap this probe must reject.
const LONGPOLL_MS = Number(process.env.DSH_PROBE_LONGPOLL_MS || 60000);

// Two attempts: an authenticated getupdates is a long-poll the server may hold
// slightly beyond one client timeout. bot.mjs:231-234 swallows a client timeout
// into {ret:0,msgs:[],get_updates_buf:''} - bufLen 0 with NO rejection, which is
// inconclusive (NOT acceptance). ONLY a non-empty server cursor (bufLen>0) proves
// the token was accepted, so retry once before giving up. judge stays fail-closed.
async function call(tok, baseUrl) {
  const client = createClient({ token: tok, baseUrl: baseUrl, longPollMs: LONGPOLL_MS });
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const r = await client.getUpdates('');
      const rej = rejectedProviderResponse(r, ['errcode', 'ret']);
      const o = shape(r, true, null);
      o.rej = rej || null;
      o.ms = Date.now() - t0;
      o.attempt = attempt + 1;
      if (o.bufLen > 0 || o.rej || attempt === 1) return o;
    } catch (e) {
      const o = shape(null, false, {
        err: String(e && e.message ? e.message : e).slice(0, 160),
        code: e && e.code,
        providerCode: e && e.providerCode,
      });
      o.rej = 'THROWN';
      o.ms = Date.now() - t0;
      o.attempt = attempt + 1;
      return o;
    }
  }
}

// PURE. EDGE_TOKEN_ACCEPTED iff the real token yields a non-empty cursor
// with no provider rejection AND both controls (no-token AND synthetic bad
// token) are NOT likewise valid. Any blind shape stays NOT_PROVEN. Never a
// false green: a bogus token that also passes flips the verdict to blind.
export function judge(real, neg, bad) {
  const ok = (o) => o.ok && !o.rej && o.bufLen > 0;
  // A control only counts as invalid when the SERVER actually rejected it.
  // A thrown/timeout control means egress was unproven, NOT that the control
  // passed: treating it as a valid negative is a false green (#36). Both arms
  // must be observed server rejections for EDGE_TOKEN_ACCEPTED to be decidable.
  const serverRejected = (o) => o.ok && o.rej !== null && o.rej !== undefined && o.bufLen <= 0;
  const realValid = ok(real);
  const negValid = ok(neg);
  const badValid = ok(bad);
  const controlsInvalid = serverRejected(neg) && serverRejected(bad);
  const verdict = realValid && controlsInvalid ? 'EDGE_TOKEN_ACCEPTED' : 'NOT_PROVEN';
  const failures = [];
  if (!realValid) failures.push('REAL_TOKEN_NOT_ACCEPTED');
  if (negValid) failures.push('NEGCTL_NO_TOKEN_ALSO_VALID');
  if (badValid) failures.push('SYNTHETIC_BAD_TOKEN_ALSO_VALID');
  if (!serverRejected(neg)) failures.push('NEGCTL_NOT_A_SERVER_REJECTION');
  if (!serverRejected(bad)) failures.push('BADCTL_NOT_A_SERVER_REJECTION');
  if (realValid === negValid && realValid === badValid) failures.push('PROBE_BLIND_ALL_SAME_SHAPE');
  return { verdict: verdict, failures: failures, realValid: realValid, negValid: negValid, badValid: badValid,
    negServerRejected: serverRejected(neg), badServerRejected: serverRejected(bad) };
}

function selftest() {
  const valid = { ok: true, rej: null, bufLen: 96, ret: 0, msgs: 0 };
  const rejected = { ok: true, rej: '-14', bufLen: -1, ret: 0, msgs: -1, errcode: -14 };
  const timeoutEmpty = { ok: true, rej: null, bufLen: 0, ret: 0, msgs: 0 };
  const thrown = { ok: false, rej: 'THROWN', bufLen: -1, msgs: -1 };
  const cases = [
    ['POS_ACCEPTED', judge(valid, rejected, rejected), 'EDGE_TOKEN_ACCEPTED'],
    ['NEG_BOTH_VALID_BLIND', judge(valid, valid, valid), 'NOT_PROVEN'],
    ['NEG_REAL_REJECTED', judge(rejected, rejected, rejected), 'NOT_PROVEN'],
    ['NEG_TIMEOUT_EMPTY_NOT_ACCEPTED', judge(timeoutEmpty, rejected, rejected), 'NOT_PROVEN'],
    ['NEG_REAL_THROWN', judge(thrown, rejected, rejected), 'NOT_PROVEN'],
    ['NEG_NEG_THROWN_STILL_OK', judge(valid, thrown, rejected), 'NOT_PROVEN'],
    ['NEG_BAD_TOKEN_ALSO_VALID', judge(valid, rejected, valid), 'NOT_PROVEN'],
    ['NEG_BAD_THROWN_STILL_OK', judge(valid, rejected, thrown), 'NOT_PROVEN'],
    ['NEG_NEGCTL_TIMEOUT_EGRESS_UNPROVEN', judge(valid, timeoutEmpty, rejected), 'NOT_PROVEN'],
    ['NEG_BADCTL_TIMEOUT_EGRESS_UNPROVEN', judge(valid, rejected, timeoutEmpty), 'NOT_PROVEN'],
  ];
  let bad = 0;
  const teeth = cases.filter((c) => c[2] === 'NOT_PROVEN').length;
  for (const c of cases) {
    const ok = c[1].verdict === c[2];
    if (!ok) bad += 1;
    console.log('SELFTEST ' + (ok ? 'OK  ' : 'FAIL') + ' ' + c[0] + ' got=' + c[1].verdict);
  }
  console.log('ILINK-TOKEN-PROBE-SELFTEST-' + (bad === 0 ? 'OK' : 'FAIL') + ' cases=' + cases.length + ' teeth=' + teeth + ' bad=' + bad);
  return bad === 0;
}

async function main() {
  const token = process.env.DSH_WEIXIN_ILINK_TOKEN || '';
  const baseUrl = process.env.DSH_ILINK_BASE_URL || DEFAULT_BASE;
  const real = await call(token || undefined, baseUrl);
  const neg = await call(undefined, baseUrl);
  const bad = await call(SYNTHETIC_BAD_TOKEN, baseUrl);
  const j = judge(real, neg, bad);
  const out = {
    probe: 'off-pc-ilink-token',
    hasToken: !!token, tokenLen: token.length, baseUrlLen: baseUrl.length,
    real: real, neg: neg, bad: bad,
    verdict: j.verdict, failures: j.failures,
    realValid: j.realValid, negValid: j.negValid, badValid: j.badValid,
    acceptance: 'NOT_PROVEN',
    note: 'read-only getupdates; NO message sent; judge is systemd-independent',
  };
  console.log('ILINK-TOKEN-PROBE ' + JSON.stringify(out));
  return j.verdict === 'EDGE_TOKEN_ACCEPTED' ? 0 : 2;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
const isMain = invoked && import.meta.url === invoked;
if (isMain) {
  if (process.argv.slice(2).includes('--selftest')) {
    process.exitCode = selftest() ? 0 : 1;
  } else {
    process.exitCode = await main();
  }
}
