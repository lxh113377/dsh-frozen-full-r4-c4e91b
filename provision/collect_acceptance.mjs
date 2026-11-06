#!/usr/bin/env node
// collect_acceptance.mjs — 真机 reboot 验收的 C1–C10 证据采集器（#47 最后一公里）
// WHY: reboot_acceptance_gate.mjs 只判定不采集；真机一到位，十类证据目前全靠手工拼
// DSH_ACCEPT_* 环境变量，缺一个自动采集器。本件补的就是这条确切缺口。
// 铁律：采集器绝不伪造证据。host/url/timestamp/断电证据全部来自外部输入（编排层/receipt
// 文件/带外证据文件）；本件只自动做两件事——实算本地冻结包 bot.mjs 的 sha256、fetch 一次
// 公网 /_health。裁决权始终在 reboot_acceptance_gate.mjs 的 judge()，本件不复写裁决。
// HOW: assemble() 把证据片段组装成 judge 输入（纯函数），collect() 调 judge 出三态；
// main() 从环境读路径、按需 fetch、打印收据与 --emit-env；--selftest 合成 GREEN + 逐条
// 消融负控，证明「缺证据 NOT_PROVEN / 证据错 FAIL / 全过 PASS」非恒真（#44 D10.2）。
// import-safe：isMain 守卫，被 import 时只暴露纯函数，不跑 CLI、不 process.exit。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { judge } from "../_goal-server/reboot_acceptance_gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BOT = path.join(HERE, "..", "server-deploy", "bot.mjs");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// assemble 是纯函数：只做「实算本地 sha」这一件自动事，其余证据一律透传，不编不猜。
// 关键防假完成：调用方即便传 sources.expectHash 伪造值，这里也一律用本地实算覆盖。
export function assemble(sources) {
  const s = sources || {};
  let localHash = null;
  try { localHash = sha256(s.botPath || DEFAULT_BOT); } catch (e) { localHash = null; }
  const receipt = s.receipt && typeof s.receipt === "object" ? s.receipt : {};
  return {
    host: String(s.host || "").trim(),
    url: String(s.url || "").trim(),
    expectHash: localHash || "",
    rebootBefore: receipt.rebootBefore,
    rebootAfter: receipt.rebootAfter,
    pcOffAttested: s.pcOffAttested ? "1" : "",
    pcOffEvidence: String(s.pcOffEvidence || "").trim(),
    fetchOk: s.fetchOk === true,
    health: s.health && typeof s.health === "object" ? s.health : null,
  };
}

// collect 把采集结果交给唯一裁决者 judge()，返回三态；本件不另立判据。
export function collect(sources) {
  const o = assemble(sources);
  const r = judge(o);
  return { verdict: r.verdict, failures: r.failures, o: o };
}

// readReceipt：真 reboot 收据由编排层在 reboot 前/后各记一次 date +%s 写入 JSON。
// 文件不存在或字段缺失就返回 {}，让 judge 自己去判 NO_REBOOT_WINDOW（fail-closed）。
function readReceipt(p) {
  if (!p) return {};
  try { const t = fs.readFileSync(p, "utf8"); const o = JSON.parse(t); return o && typeof o === "object" ? o : {}; }
  catch (e) { return {}; }
}

// readPcOff：PC 断电是带外事实，本机无法自证。只有「调用方显式声明 1」且「证据文件
// 存在且非空」两个条件同时成立，才把 pcOffAttested 置真；缺一即 NOT_PROVEN。
function readPcOff(p, attested) {
  if (String(attested || "") !== "1") return { ok: false, evidence: "" };
  if (!p) return { ok: false, evidence: "" };
  try { const st = fs.statSync(p); if (!st.isFile() || st.size === 0) return { ok: false, evidence: "" }; }
  catch (e) { return { ok: false, evidence: "" }; }
  return { ok: true, evidence: p };
}

// greenSources：合成一份与 bot.mjs:380-386 /_health 逐字同构的 GREEN 证据，
// ts 用 ISO 字符串且晚于 rebootAfter，证明判据对准真物（对齐达标闸 D10.2 修正）。
function greenSources(botPath) {
  const hash = sha256(botPath || DEFAULT_BOT);
  return {
    botPath: botPath || DEFAULT_BOT,
    host: "bot.example.com",
    url: "https://bot.example.com/_health",
    receipt: { rebootBefore: 1000, rebootAfter: 2000 },
    pcOffAttested: true,
    pcOffEvidence: "selftest-pc-off-evidence.txt",
    fetchOk: true,
    health: {
      service: "dsh-ilink-bot",
      status: "ok",
      needsRelogin: false,
      uptimeSec: 42,
      messagesReceived: 0,
      messagesReplied: 0,
      lastError: null,
      codeHash: hash,
      pid: 4242,
      ts: new Date(3000 * 1000).toISOString(),
    },
  };
}

function selftest() {
  const cases = [];
  const bad = [];
  const add = (name, ok) => { cases.push(name); if (!ok) bad.push(name); };
  const green = collect(greenSources());
  add("GREEN_PASS", green.verdict === "PASS");

  // 契约负控：调用方伪造 expectHash 不得被采信，输出必须仍是本地实算值。
  const forged = assemble(Object.assign({}, greenSources(), { expectHash: "deadbeef" }));
  const realHash = sha256(DEFAULT_BOT);
  add("FORGED_HASH_IGNORED", forged.expectHash === realHash && forged.expectHash !== "deadbeef");

  // 逐条消融：每条都断言 verdict 绝不可能是 PASS，且必须点名对应失败码。
  const mut = (name, fn, code) => {
    const src = greenSources(); fn(src);
    const r = collect(src);
    add(name, r.verdict !== "PASS" && r.failures.includes(code));
  };
  mut("NO_RECEIPT_NOT_PROVEN", (s) => { s.receipt = {}; }, "NO_REBOOT_WINDOW");
  mut("NO_PCOFF_NOT_PROVEN", (s) => { s.pcOffAttested = false; s.pcOffEvidence = ""; }, "NO_PC_OFF_ATTESTATION");
  mut("LOOPBACK_HOST", (s) => { s.host = "127.0.0.1"; }, "HOST_IS_LOOPBACK");
  mut("LOOPBACK_URL", (s) => { s.url = "http://127.0.0.1:8787/_health"; }, "HEALTH_URL_LOOPBACK");
  mut("CODEHASH_MISMATCH", (s) => { s.health.codeHash = "0".repeat(64); }, "CODEHASH_MISMATCH");
  mut("STALE_TS", (s) => { s.health.ts = new Date(1500 * 1000).toISOString(); }, "HEALTH_NOT_FRESH_AFTER_REBOOT");
  mut("WRONG_SERVICE", (s) => { s.health.service = "other"; }, "WRONG_SERVICE");
  mut("STATUS_NOT_OK", (s) => { s.health.status = "corrupt_state"; }, "STATUS_NOT_OK");
  mut("NEEDS_RELOGIN", (s) => { s.health.needsRelogin = true; }, "NEEDS_RELOGIN");
  mut("LAST_ERROR_PRESENT", (s) => { s.health.lastError = "boom"; }, "LAST_ERROR_PRESENT");
  mut("FETCH_FAILED", (s) => { s.fetchOk = false; }, "HEALTH_FETCH_FAILED");
  mut("NO_DECL", (s) => { s.host = ""; s.url = ""; }, "NO_TARGET_HOST");

  for (const c of cases) console.log("SELFTEST " + (bad.includes(c) ? "FAIL" : "OK  ") + " " + c);
  const teeth = cases.length - 1;
  console.log("ACCEPTANCE-COLLECT-SELFTEST-" + (bad.length === 0 ? "OK" : "FAIL") + " cases=" + cases.length + " teeth=" + teeth);
  return bad.length === 0;
}

function emitEnv(o) {
  const env = {
    DSH_ACCEPT_HOST: o.host,
    DSH_ACCEPT_URL: o.url,
    DSH_ACCEPT_EXPECT_CODEHASH: o.expectHash,
    DSH_ACCEPT_REBOOT_BEFORE: o.rebootBefore == null ? "" : String(o.rebootBefore),
    DSH_ACCEPT_REBOOT_AFTER: o.rebootAfter == null ? "" : String(o.rebootAfter),
    DSH_ACCEPT_PC_OFF_ATTESTED: o.pcOffAttested,
    DSH_ACCEPT_PC_OFF_EVIDENCE: o.pcOffEvidence,
  };
  console.log("ACCEPTANCE-ENV " + JSON.stringify(env));
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest() ? 0 : 1;
  const botPath = process.env.DSH_COLLECT_BOT || DEFAULT_BOT;
  const host = process.env.DSH_COLLECT_HOST || "";
  const url = process.env.DSH_COLLECT_URL || "";
  const receipt = readReceipt(process.env.DSH_COLLECT_RECEIPT);
  const pcOff = readPcOff(process.env.DSH_COLLECT_PCOFF, process.env.DSH_COLLECT_PCOFF_ATTESTED);
  let fetchOk = false;
  let health = null;
  // 只有 host+url 都声明才发一次只读请求；缺证据时根本不联网，直接 NOT_PROVEN。
  if (host && url) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); health = await r.json(); fetchOk = r.ok; }
    catch (e) { fetchOk = false; }
  }
  const src = { botPath: botPath, host: host, url: url, receipt: receipt,
    pcOffAttested: pcOff.ok, pcOffEvidence: pcOff.evidence, fetchOk: fetchOk, health: health };
  const r = collect(src);
  if (args.includes("--emit-env")) return emitEnv(r.o);
  console.log("COLLECT host=" + (r.o.host || "(unset)") + " url=" + (r.o.url || "(unset)") + " expectHash=" + r.o.expectHash.slice(0, 12) + " fetchOk=" + r.o.fetchOk);
  console.log("COLLECT reboot=" + String(r.o.rebootBefore) + ".." + String(r.o.rebootAfter) + " pcOffAttested=" + r.o.pcOffAttested + " pcOffEvidence=" + (r.o.pcOffEvidence || "(unset)"));
  console.log("ACCEPTANCE=" + r.verdict + " host=" + (r.o.host || "(unset)") + " expectHash=" + r.o.expectHash.slice(0, 12));
  console.log("FAILURES=" + (r.failures.length ? r.failures.join(",") : "(none)"));
  console.log("NOTE: 采集器不伪造证据；缺真 reboot 收据/带外断电证据/公网 /_health 一律 NOT_PROVEN。");
  return r.verdict === "PASS" ? 0 : (r.verdict === "FAIL" ? 1 : 2);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isMain = invoked && import.meta.url === invoked;
if (isMain) { const rc = await main(); process.exitCode = typeof rc === "boolean" ? (rc ? 0 : 1) : rc; }
export { sha256, greenSources, readReceipt, readPcOff };
