// server-deploy/run-once.mjs
// WHY: GitHub Actions gives a clean ephemeral runner on each cron tick. The
// frozen bot.mjs (BYTE-FROZEN sha256 9f4138c534582e58... / 22221B / 487 lines)
// is a RESIDENT service: runService() long-polls until SIGTERM or deps.maxCycles.
// It must not be edited. This file is the thinnest adapter: bound one cycle,
// then emit ONE machine-readable RUN-ONCE line a judge can independently verify.
//
// HOW (line-level, all seams live in the frozen file, zero edits to it):
//  1. isMain guard mirrors bot.mjs:478-479, so importing this from a judge or
//     selftest never starts polling.
//  2. statePath: loadConfig() at bot.mjs:279 resolves overrides > file.statePath
//     > state.json. config.example.json:4 pins /var/lib/dsh-ilink-bot/state.json
//     (unwritable on a runner). We pin it to <module dir>/state.json so it
//     equals the actions/cache path. No config.json exists in CI (gitignored),
//     so this is also the only thing making the path CWD-independent.
//  3. healthPort:0 -> bot.mjs:417 binds an OS-assigned port; overlapping runs
//     cannot collide on 8787. bot.mjs:418 passes the real port to deps.onListen.
//  4. fetchImpl: bot.mjs:355 -> createClient():211 -> requestJson():194 calls it
//     for BOTH getupdates and sendmessage. Counting URLs is the only way to
//     prove a real poll happened without touching the frozen bytes.
//  5. onListen: bot.mjs:420. We GET /_health and record codeHash (bot.mjs:384
//     returns codeHash() = sha256 of the running bot.mjs bytes, :318-319).
//  6. fastFail:1ms (bot.mjs:469), maxIdleTicks:1 + reloginIdleMs:1000
//     (bot.mjs:374-375/:407) bound the degraded branches too.
//  7. TOKEN: read ONLY by bot.mjs:277 from env DSH_WEIXIN_ILINK_TOKEN. This
//     file never reads, logs, hashes-for-display or echoes it. RUN-ONCE JSON
//     has no token field. All bot.mjs throw sites use fixed literals, so
//     lastError cannot carry it either.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runService } from './bot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_PATH = join(HERE, 'bot.mjs');

// Evidence lives OUTSIDE runService: if it rejects we still report what we
// saw, never a fabricated success.
const ev = { getUpdatesCalls: 0, sendMessageCalls: 0,
  healthCodeHash: null, healthService: null, healthProbeError: null };

// Recomputed at runtime (not hardcoded) so a swapped bot loses the comparison
// against /_health self-reported codeHash.
const diskBotHash = createHash('sha256').update(readFileSync(BOT_PATH)).digest('hex');

// Only real provider round-trips are counted. The health probe below uses the
// GLOBAL fetch deliberately, so it can never inflate getUpdatesCalls.
// requestJson():188/:194 passes a URL OBJECT: it has .href, not .url.
function countingFetch(input, init) {
  const raw = input && (input.url || input.href) ? (input.url || input.href) : input;
  const u = String(raw || '');
  if (u.indexOf('/ilink/bot/getupdates') !== -1) ev.getUpdatesCalls += 1;
  else if (u.indexOf('/ilink/bot/sendmessage') !== -1) ev.sendMessageCalls += 1;
  return fetch(input, init);
}

function emit(obj) {
  // console.log appends the newline. Single line, no token, no raw provider
  // body, no env dump. This is the ONLY structured line we guarantee.
  console.log('RUN-ONCE ' + JSON.stringify(obj));
}

async function main() {
  const statePath = process.env.DSH_ILINK_STATE_PATH || join(HERE, 'state.json');

  // Hard ceiling below the job timeout-minutes:6. Referenced so it can fire.
  const watchdog = setTimeout(() => {
    emit({ status: 'watchdog_timeout', received: 0, replied: 0,
      getUpdatesBufLen: null, getUpdatesCalls: ev.getUpdatesCalls,
      sendMessageCalls: ev.sendMessageCalls, healthCodeHash: ev.healthCodeHash,
      healthService: ev.healthService, healthMatchesDisk: false,
      botStatus: null, needsRelogin: null, lastError: 'watchdog 120000ms',
      runCompleted: false });
    process.exit(1);
  }, 120000);

  const deps = {
    maxCycles: 1,        // bot.mjs:472 -> exit after ONE poll cycle
    maxIdleTicks: 1,     // bot.mjs:375/:407 -> degraded idle also terminates
    reloginIdleMs: 1000, // bot.mjs:374 -> 1s per idle tick
    fastFail: true,      // bot.mjs:469 -> 1ms instead of 2s backoff on error
    logger: console,     // bot.mjs:356 (warn -> stderr, token-free)
    fetchImpl: countingFetch,
    onListen: async (port) => {
      // bot.mjs:420. Global fetch on purpose (see countingFetch comment).
      try {
        const resp = await fetch('http://127.0.0.1:' + port + '/_health');
        const h = await resp.json();
        ev.healthCodeHash = typeof h.codeHash === 'string' ? h.codeHash : null;
        ev.healthService = h.service === 'dsh-ilink-bot';
      } catch (e) {
        ev.healthProbeError = String(e && e.message || e);
      }
    },
  };

  let stats = null;
  let fatal = null;
  try {
    // overrides deliberately do NOT carry token: bot.mjs:277 reads it from env.
    stats = await runService({ statePath, healthPort: 0 }, deps);
  } catch (e) {
    fatal = String(e && e.code ? e.code + ': ' + (e.message || '') : (e && e.message) || e);
  }
  clearTimeout(watchdog);

  // Read the cursor back FROM DISK, not from the in-memory object, so the
  // judge can cross-check the exact bytes actions/cache will persist.
  let bufLen = null;
  try {
    const disk = JSON.parse(readFileSync(statePath, 'utf8'));
    bufLen = typeof disk.getUpdatesBuf === 'string' ? disk.getUpdatesBuf.length : null;
  } catch { bufLen = null; }

  const healthMatches = ev.healthCodeHash !== null && ev.healthCodeHash === diskBotHash;
  const ok = fatal === null
    && ev.getUpdatesCalls >= 1                     // a real long-poll was issued
    && ev.healthService === true                  // /_health answered
    && healthMatches                             // running bytes == disk bytes
    && stats !== null
    && stats.status === 'ok'                     // not corrupt_state / needs_relogin
    && stats.needsRelogin === false
    && stats.lastError === null                  // bot.mjs:441 clears ONLY on success
    && bufLen !== null;                          // state.json persisted

  emit({
    status: ok ? 'ok' : 'fail',
    received: stats ? stats.messagesReceived : 0,
    replied: stats ? stats.messagesReplied : 0,
    getUpdatesBufLen: bufLen,
    getUpdatesCalls: ev.getUpdatesCalls,
    sendMessageCalls: ev.sendMessageCalls,
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
      getUpdatesCalls: ev.getUpdatesCalls, sendMessageCalls: ev.sendMessageCalls,
      healthCodeHash: ev.healthCodeHash, healthService: ev.healthService,
      healthMatchesDisk: false, botStatus: null, needsRelogin: null,
      lastError: String(e && e.message || e), runCompleted: false });
    process.exitCode = 1;
  });
}
