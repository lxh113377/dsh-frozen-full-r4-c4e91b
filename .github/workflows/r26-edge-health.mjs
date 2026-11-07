// r26 off-PC edge health probe (runs on GitHub ubuntu-latest, outside this PC).
// HONEST: no token on the edge => judgeLiveness returns needs_relogin => verdict NOT_PROVEN => HTTP 503.
// We assert 503 + NOT_PROVEN + needs_relogin, NOT 200. A 200 would be a fake-green and fail this gate.
// tickCount must not decrease across a 65s window; negative control .invalid must fail to resolve.
const POS = "https://dsh-ilink-edge-bot.3753318894.workers.dev/_health";
const NEG = "https://dsh-nonexistent-9f3a7c.invalid/_health";

async function getRaw(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  return { code: r.status, text };
}

function parseJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function check(cond, name, fails) { if (!cond) fails.push(name); }

async function main() {
  const fails = [];
  let a = { code: 0, text: "" }, b = { code: 0, text: "" };
  let negFailed = false, negCode = 0;
  try { a = await getRaw(POS); }
  catch (e) { fails.push("POSITIVE_FETCH_THREW:" + String(e && e.message || e)); }
  const jA = parseJson(a.text);
  check(a.code === 503, "A_HTTP_NOT_503", fails);
  check(a.code !== 200, "A_HTTP_200_FAKE_GREEN", fails);
  check(jA !== null, "A_BODY_NOT_JSON", fails);
  if (jA) {
    check(jA.status === "needs_relogin", "A_STATUS_NOT_NEEDS_RELOGIN", fails);
    check(jA.verdict === "NOT_PROVEN", "A_VERDICT_NOT_NOT_PROVEN", fails);
    check(jA.acceptance === "NOT_PROVEN", "A_ACCEPTANCE_NOT_NOT_PROVEN", fails);
    check(jA.needsRelogin === true, "A_NEEDS_RELOGIN_NOT_TRUE", fails);
  }
  await new Promise(function (res) { setTimeout(res, 65000); });
  try { b = await getRaw(POS); }
  catch (e) { fails.push("SECOND_FETCH_THREW:" + String(e && e.message || e)); }
  const jB = parseJson(b.text);
  check(b.code === 503, "B_HTTP_NOT_503", fails);
  check(jB !== null, "B_BODY_NOT_JSON", fails);
  let tA = 0, tB = 0;
  if (jA && jA.cron) tA = Number(jA.cron.tickCount);
  if (jB && jB.cron) tB = Number(jB.cron.tickCount);
  check(tB >= tA, "TICKCOUNT_DECREASED", fails);
  try { const n = await getRaw(NEG); negCode = n.code; check(false, "NEGCTL_UNEXPECTEDLY_REACHABLE", fails); }
  catch (e) { negFailed = true; }
  check(negFailed, "NEGCTL_DID_NOT_FAIL", fails);
  const delta = tB - tA;
  const ok = fails.length === 0;
  console.log("R26-OFFPC-GET " + (ok ? "OK" : "FAIL") +
    " httpA=" + a.code + " httpB=" + b.code +
    " tickA=" + tA + " tickB=" + tB + " delta=" + delta +
    " negctl=" + (negFailed ? "OK_EXPECTED_FAILURE" : "FABRICATED") +
    " negCode=" + negCode +
    " statusA=" + (jA ? jA.status : "null") +
    " verdict=" + (jA ? jA.verdict : "null") +
    " acceptance=" + (jA ? jA.acceptance : "null") +
    " needsRelogin=" + (jA ? String(jA.needsRelogin) : "null") +
    " verdict_final=" + (ok ? "PASS" : "FAIL") +
    " failures=" + JSON.stringify(fails));
  if (!ok) process.exit(1);
}
main().catch(function (e) { console.log("R26-OFFPC-GET FAIL harness_threw=" + String(e && e.message || e)); process.exit(1); });
