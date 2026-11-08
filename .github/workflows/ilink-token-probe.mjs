// ilink-token-probe.mjs - off-PC iLink token acceptance probe (read-only)
// WHY: the GH-Actions always-on carrier lives or dies on one unknown - can an
// ubuntu-latest runner holding the server-own real token reach iLink and get a
// VALID sync cursor (not errcode -14)? The local PC proved the token works
// (bufLen=96); runner egress IP / geo / edge auth was UNATTESTED.
// HOW: two getupdates calls - real token from env (NEVER printed), plus a
// no-token negative control. judge() is a pure function of the two shapes;
// --selftest runs synthetic teeth with zero network. Token value never logged.

import { pathToFileURL } from 'node:url';
import { createClient, rejectedProviderResponse } from '../../server-deploy/bot.mjs';

const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com/';

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
async function call(tok, baseUrl) {
  const client = createClient({ token: tok, baseUrl: baseUrl, longPollMs: 12000 });
  try {
    const r = await client.getUpdates('');
    const rej = rejectedProviderResponse(r, ['errcode', 'ret']);
    const o = shape(r, true, null);
    o.rej = rej || null;
    return o;
  } catch (e) {
    const o = shape(null, false, {
      err: String(e && e.message ? e.message : e).slice(0, 160),
      code: e && e.code,
      providerCode: e && e.providerCode,
    });
    o.rej = 'THROWN';
    return o;
  }
}

// PURE. EDGE_TOKEN_ACCEPTED iff real token yields a non-empty cursor with no
// provider rejection AND the no-token control is NOT likewise valid. Tooth:
// if the endpoint ignores auth (both valid) or rejects both, verdict is
// NOT_PROVEN (blind) - never a false green.
export function judge(real, neg) {
  const realValid = real.ok && !real.rej && real.bufLen > 0;
  const negValid = neg.ok && !neg.rej && neg.bufLen > 0;
  const verdict = realValid && !negValid ? 'EDGE_TOKEN_ACCEPTED' : 'NOT_PROVEN';
  const failures = [];
  if (!realValid) failures.push('REAL_TOKEN_NOT_ACCEPTED');
  if (negValid) failures.push('NEGCTL_NO_TOKEN_ALSO_VALID');
  if (realValid === negValid) failures.push('PROBE_BLIND_SAME_SHAPE');
  return { verdict: verdict, failures: failures, realValid: realValid, negValid: negValid };
}

function selftest() {
  const valid = { ok: true, rej: null, bufLen: 96, ret: 0, msgs: 0 };
  const rejected = { ok: true, rej: '-14', bufLen: 0, ret: 0, msgs: 0, errcode: -14 };
  const timeoutEmpty = { ok: true, rej: null, bufLen: 0, ret: 0, msgs: 0 };
  const thrown = { ok: false, rej: 'THROWN', bufLen: -1, msgs: -1 };
  const cases = [
    ['POS_ACCEPTED', judge(valid, rejected), 'EDGE_TOKEN_ACCEPTED'],
    ['NEG_BOTH_VALID_BLIND', judge(valid, valid), 'NOT_PROVEN'],
    ['NEG_REAL_REJECTED', judge(rejected, rejected), 'NOT_PROVEN'],
    ['NEG_TIMEOUT_EMPTY_NOT_ACCEPTED', judge(timeoutEmpty, rejected), 'NOT_PROVEN'],
    ['NEG_REAL_THROWN', judge(thrown, rejected), 'NOT_PROVEN'],
    ['NEG_NEG_THROWN_STILL_OK', judge(valid, thrown), 'EDGE_TOKEN_ACCEPTED'],
  ];
  let bad = 0;
  for (const c of cases) {
    const ok = c[1].verdict === c[2];
    if (!ok) bad += 1;
    console.log('SELFTEST ' + (ok ? 'OK  ' : 'FAIL') + ' ' + c[0] + ' got=' + c[1].verdict);
  }
  console.log('ILINK-TOKEN-PROBE-SELFTEST-' + (bad === 0 ? 'OK' : 'FAIL') + ' cases=' + cases.length + ' teeth=' + (cases.length - 1) + ' bad=' + bad);
  return bad === 0;
}

async function main() {
  const token = process.env.DSH_WEIXIN_ILINK_TOKEN || '';
  const baseUrl = process.env.DSH_ILINK_BASE_URL || DEFAULT_BASE;
  const real = await call(token || undefined, baseUrl);
  const neg = await call(undefined, baseUrl);
  const j = judge(real, neg);
  const out = {
    probe: 'off-pc-ilink-token',
    hasToken: !!token, tokenLen: token.length, baseUrlLen: baseUrl.length,
    real: real, neg: neg,
    verdict: j.verdict, failures: j.failures,
    realValid: j.realValid, negValid: j.negValid,
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
