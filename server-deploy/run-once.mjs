// server-deploy/run-once.mjs
// WHY: GitHub Actions gives a clean ephemeral runner per cron tick. Frozen
// bot.mjs is a RESIDENT service; this is the thinnest adapter: bound ONE cycle
// and emit ONE machine-readable RUN-ONCE line a judge verifies independently.
//
// H1 FIX (round 43 second opinion): bot.mjs:232-234 swallows a getupdates
// client timeout into {ret:0,msgs:[],get_updates_buf:''} with NO rejection, so
// a timed-out poll looked like a completed green cycle. countingFetch now
// records getUpdatesResponded ONLY when the fetch RESOLVES (an AbortController
// timeout never resolves -> 0). Adapter AND judge require responded>=1 AND a
// non-empty persisted cursor (bufLen>0). Two independent teeth.
//
// H2 FIX: FROZEN_BOT_SHA256 is a hardcoded ABSOLUTE pin, not a self-consistent
// hash of whatever file is loaded. /_health codeHash, disk hash and judge ctx
// hash must ALL equal this constant. A consistently swapped bot.mjs now FAILS.
//
// COMPLIANCE (read-B): iLink is 1:1 DIRECT, NO group surface. This adapter is
// POLL-ONLY: countingFetch blocks EVERY sendmessage (synthetic provider
// rejection -> fail-closed RED, never a fake success), so ZERO messages are
// sent to anyone. read-B permits owner private chat as the ONLY test target;
// groups/real contacts must not be sent. Auto-reply enablement is deferred
// pending owner-allowlist wiring + a verified PC-off round-trip. ACCEPTANCE
// stays NOT_PROVEN. bot.mjs (frozen) retains reply capability; adapter gates
// it. Token is read ONLY by bot.mjs:277 from env DSH_WEIXIN_ILINK_TOKEN.
//
// HOW (all seams in frozen bot.mjs, zero edits to it):
//  healthPort:0 -> bot.mjs:417 OS-assigned port, :420 onListen(realPort).
//  fetchImpl: bot.mjs:355 -> createClient:211 -> requestJson:194 (URL object,
//    .href NOT .url). onListen probes /_health codeHash (:384/:318-319).
//  maxCycles:1 (:472), maxIdleTicks:1 (:375/:407), fastFail:true (:469).
//  statePath = runtime-state.json (NOT the tracked frozen selfcheck seed).

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runService } from './bot.mjs';

// Absolute pin. The recomputed disk hash is compared to THIS, never to itself.
const FROZEN_BOT_SHA256 = '9f4138c534582e583a5de27e3de68950ad6f6b5881947aacee82aa77aff3c268';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_PATH = join(HERE, 'bot.mjs');
const diskBotHash = createHash('sha256').update(readFileSync(BOT_PATH)).digest('hex');

// Evidence outside runService: if it rejects we still report what we saw.
const ev = { getUpdatesCalls: 0, getUpdatesResponded: 0,
  sendMessageCalls: 0, blockedSends: 0,
  healthCodeHash: null, healthService: null, healthProbeError: null };

// requestJson():188/:194 passes a URL OBJECT (.href, not .url). The health
// probe below uses the GLOBAL fetch so it cannot inflate getUpdatesResponded.
function countingFetch(input, init) {
  const raw = input && (input.url || input.href) ? (input.url || input.href) : input;
  const u = String(raw || '');
  if (u.indexOf('/ilink/bot/getupdates') !== -1) {
    ev.getUpdatesCalls += 1;
    // Only a RESOLVED response counts. A timed-out/aborted fetch rejects ->
    // .then never runs -> getUpdatesResponded stays 0 (H1 fail-closed).
    return fetch(input, init).then((r) => { ev.getUpdatesResponded += 1; return r; });
  }
  if (u.indexOf('/ilink/bot/sendmessage') !== -1) {
    // POLL-ONLY read-B gate: never send any message to anyone. A synthetic
    // provider rejection makes bot.mjs sendText throw -> runService sets
    // lastError -> run is RED. No fake success, no silent seen-add.
    ev.blockedSends += 1;
    return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ errcode: -1, ret: -1 }) });
  }
  return fetch(input, init);
}

function emit(obj) { console.log('RUN-ONCE ' + JSON.stringify(obj)); }

async function main() {
  const statePath = process.env.DSH_ILINK_STATE_PATH || join(HERE, 'runtime-state.json');
  const watchdog = setTimeout(() => {
    emit({ status: 'watchdog_timeout', received: 0, replied: 0,
      getUpdatesBufLen: null, getUpdatesCalls: ev.getUpdatesCalls,
      getUpdatesResponded: ev.getUpdatesResponded,
      sendMessageCalls: ev.sendMessageCalls, blockedSends: ev.blockedSends,
      healthCodeHash: ev.healthCodeHash, healthService: ev.healthService,
      healthMatchesDisk: false, botStatus: null, needsRelogin: null,
      lastError: 'watchdog 120000ms', runCompleted: false });
    process.exit(1);
  }, 120000);

  const deps = {
    maxCycles: 1, maxIdleTicks: 1, reloginIdleMs: 1000, fastFail: true,
    logger: console, fetchImpl: countingFetch,
    onListen: async (port) => {
      try {
        const resp = await fetch('http://127.0.0.1:' + port + '/_health');
        const h = await resp.json();
        ev.healthCodeHash = typeof h.codeHash === 'string' ? h.codeHash : null;
        ev.healthService = h.service === 'dsh-ilink-bot';
      } catch (e) { ev.healthProbeError = String(e && e.message || e); }
    },
  };

  let stats = null, fatal = null;
  try { stats = await runService({ statePath, healthPort: 0 }, deps); }
  catch (e) { fatal = String(e && e.code ? e.code + ': ' + (e.message || '') : (e && e.message) || e); }
  clearTimeout(watchdog);

  let bufLen = null;
  try {
    const disk = JSON.parse(readFileSync(statePath, 'utf8'));
    bufLen = typeof disk.getUpdatesBuf === 'string' ? disk.getUpdatesBuf.length : null;
  } catch { bufLen = null; }

  // H2: all three must equal the ABSOLUTE frozen constant.
  const healthMatches = ev.healthCodeHash === FROZEN_BOT_SHA256
    && diskBotHash === FROZEN_BOT_SHA256;
  const ok = fatal === null
    && ev.getUpdatesCalls >= 1
    && ev.getUpdatesResponded >= 1        // H1: a real HTTP response came back
    && ev.healthService === true
    && healthMatches
    && stats !== null
    && stats.status === 'ok'
    && stats.needsRelogin === false
    && stats.lastError === null
    && Number.isInteger(bufLen) && bufLen > 0;   // H1: non-empty cursor persisted

  emit({
    status: ok ? 'ok' : 'fail',
    received: stats ? stats.messagesReceived : 0,
    replied: stats ? stats.messagesReplied : 0,
    getUpdatesBufLen: bufLen,
    getUpdatesCalls: ev.getUpdatesCalls,
    getUpdatesResponded: ev.getUpdatesResponded,
    sendMessageCalls: ev.sendMessageCalls,
    blockedSends: ev.blockedSends,
    healthCodeHash: ev.healthCodeHash,
    healthService: ev.healthService,
    healthMatchesDisk: healthMatches,
    botStatus: stats ? stats.status : null,
    needsRelogin: stats ? stats.needsRelogin : null,
    lastError: stats ? stats.lastError : fatal,
    runCompleted: fatal === null,
  });
  if (!ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
const isMain = invokedPath && import.meta.url === invokedPath;
if (isMain) {
  main().catch((e) => {
    emit({ status: 'fatal', received: 0, replied: 0, getUpdatesBufLen: null,
      getUpdatesCalls: ev.getUpdatesCalls, getUpdatesResponded: ev.getUpdatesResponded,
      sendMessageCalls: ev.sendMessageCalls, blockedSends: ev.blockedSends,
      healthCodeHash: ev.healthCodeHash, healthService: ev.healthService,
      healthMatchesDisk: false, botStatus: null, needsRelogin: null,
      lastError: String(e && e.message || e), runCompleted: false });
    process.exitCode = 1;
  });
}
