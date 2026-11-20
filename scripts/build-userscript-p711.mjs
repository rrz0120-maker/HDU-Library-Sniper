import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Pure Node.js zero-dependency bundler for P7.1.1 iPad Scheduled Preflight Reliability artifact.
const MODULES = [
  "src/userscript/core.js",
  "src/userscript/transport.js",
  "src/userscript/ledger.js",
  "src/userscript/p70/policy.js",
  "src/userscript/p70/store.js",
  "src/userscript/p70/engine.js",
  "src/userscript/p70/panel.js",
  "src/userscript/p71/coordinator.js",
  "src/userscript/p71/policy.js",
  "src/userscript/p71/store.js",
  "src/userscript/p71/engine.js",
  "src/userscript/p71/panel.js",
  "src/userscript/p71/entry.js",
];

const METADATA = `// ==UserScript==
// @name         杭电图书馆 P7.1.1 iPad 固定162整点预约版
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p71-ipad
// @version      7.1.1
// @description  iPad Safari + Userscripts：修复准备阶段重复查询与跨模式互斥，静态映射严格校验复用，保留P7.0普通预约、20:00固定162整点、19:55准备、临近重校时、开放双门禁、后台挂起中止与单次写入保护。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @inject-into  page
// @noframes
// @run-at       document-idle
// @updateURL    none
// @license      MIT
// ==/UserScript==
`;

function stripModuleSyntax(source, file) {
  let cleaned = source.replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  cleaned = cleaned.replace(/^\s*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, "");
  return `  // --- ${file} ---\n${cleaned.trim()}\n`;
}

await mkdir("userscripts", { recursive: true });
const parts = [];
for (const file of MODULES) {
  const raw = await readFile(file, "utf8");
  parts.push(stripModuleSyntax(raw, file));
}

const outPath = "userscripts/hdu-p711-ipad-scheduled.user.js";
const code = `${METADATA}(function () {\n  "use strict";\n${parts.join("\n")}})();\n`;

if (!code.startsWith("// ==UserScript==")) throw new Error("Missing UserScript header");
if (/@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/.test(code)) {
  throw new Error("Invalid P7.1.1 artifact: forbidden pattern detected");
}

await writeFile(outPath, code, "utf8");
execFileSync(process.execPath, ["--check", outPath], { stdio: "inherit" });

const sha256 = createHash("sha256").update(code, "utf8").digest("hex");
console.log(`${outPath} (${Buffer.byteLength(code, "utf8")} bytes)`);
console.log(`SHA256: ${sha256}`);
