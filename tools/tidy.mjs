#!/usr/bin/env node
/**
 * 记忆整理 worker（v1.1.0 起住在包内，原来散在 ~/.dsh/tools/memory-tidy）。
 *
 * 契约（和宿主半边 index.js 的分工，别改）：
 *   - 只读：MEMORY.md + 各记忆正文。**绝不直接改正文、绝不改 MEMORY.md**。
 *   - 只写：`.tidy/proposed/<file>.md`（整篇新正文）与 `.tidy/status.json`（lastRun/result/detail）。
 *   - 落盘由人在设置页点「批准」触发 index.js 的 approveFile()，不是这里。
 *   - 锁定的、停用的记忆不送模型。
 *
 * 用法：
 *   node tools/tidy.mjs              # 正常跑一次（计划任务每天 09:00 用）
 *   node tools/tidy.mjs --if-due     # 只在「上次成功」超过 20 小时才跑（登录补跑用）
 *   node tools/tidy.mjs --dry-run    # 只打印将要发出去的请求，不联网、不写盘
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const MEM = path.join(HOME, 'memory');
const TIDY = path.join(MEM, '.tidy');
const PROPOSED = path.join(TIDY, 'proposed');
const STATUS = path.join(TIDY, 'status.json');
const ENV_FILE = path.join(HOME, 'automation.env');
const LOG = path.join(HERE, 'tidy.log');

const ENDPOINT = process.env.MEMORY_TIDY_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.MEMORY_TIDY_MODEL || 'deepseek-flash';
const TIMEOUT_MS = 180_000; // 单次请求超时；超时重试一次
const MAX_PROPOSALS = 3; // 一次最多提几份改稿，多了人审不过来
const DUE_HOURS = 20; // --if-due 的判定窗：上次成功不足 20 小时就跳过
const MIN_BODY = 120; // 太短的正文没什么可整理
const KEEP_RATIO = 0.35; // 改稿至少保留原文这么多字，防止模型把记忆删成空壳

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const IF_DUE = argv.has('--if-due');

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.error(text);
  try {
    fs.appendFileSync(LOG, `${text}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeStatus(result, detail) {
  try {
    fs.mkdirSync(TIDY, { recursive: true });
    fs.writeFileSync(STATUS, JSON.stringify({ lastRun: new Date().toISOString(), result, detail }), 'utf8');
  } catch (err) {
    log(`写 status.json 失败：${err.message}`);
  }
}

/** 手动解析 automation.env，不引入 dotenv。 */
function apiKey() {
  if (process.env.DSH_AUTOMATION_API_KEY) return process.env.DSH_AUTOMATION_API_KEY.trim();
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DSH_AUTOMATION_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* 文件不存在就是没配 */
  }
  return '';
}

/** 索引表：文件 | 关键词 | 启用 | 类型 | 何时读 | 复核 | 受保护 */
function readIndex() {
  let text = '';
  try {
    text = fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const file = cells[0].replace(/`/g, '').trim();
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
    rows.push({
      file,
      keywords: (cells[1] || '').replace(/`/g, '').trim(),
      enabled: !/^否$/.test(cells[2] || ''),
      reviewed: (cells[5] || '').trim(),
      protected: /^是$/.test(cells[6] || ''),
    });
  }
  return rows;
}

/** 正文：去掉 YAML 头。 */
function readBody(file) {
  try {
    const text = fs.readFileSync(path.join(MEM, file), 'utf8').replace(/^\uFEFF/, '');
    const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return (m ? text.slice(m[0].length) : text).trim();
  } catch {
    return '';
  }
}

function count(text) {
  return Array.from(text || '').length;
}

const SYSTEM_PROMPT = [
  '你是记忆整理器。用户会给你若干条记忆（关键词 + 正文），正文是他长期积累的笔记。',
  '你的任务：挑出最值得整理的至多 3 条，各给一份改写后的正文。',
  '规则：',
  '1. 只做减法：删掉重复、过时、前后矛盾的句子；不新增用户没写过的事实，不改语气，不改人称。',
  '2. 任何可执行的用法、命令、路径、版本号、坑与限制都必须原样保留——那是以后要照着做的。',
  '3. 不要改关键词，不要改 YAML 头，只返回正文。',
  '4. 改完至少保留原文 35% 的字数；没什么可整理的就不返回它。',
  '5. 只输出 JSON：{"items":[{"file":"x.md","body":"改写后的完整正文"}]}，不要解释、不要代码围栏。',
].join('\n');

function buildRequest(targets) {
  const payload = targets.map((t) => ({ file: t.file, keywords: t.keywords, body: t.body }));
  return {
    model: MODEL,
    thinking: { type: 'enabled', reasoning_effort: 'low' },
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ memories: payload }) },
    ],
  };
}

/** 一次调用；超时或 5xx/429 重试一次，4xx 直接失败。 */
async function callModel(key, body) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      const retriable = !err.status || err.status >= 500 || err.status === 429 || err.name === 'AbortError';
      log(`第 ${attempt} 次调用失败：${err.name === 'AbortError' ? '超时' : err.message}`);
      if (!retriable || attempt === 2) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('调用失败');
}

/** 从模型输出里抠出 JSON（容忍代码围栏与前后废话）。 */
function parseItems(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(items)) throw new Error('模型输出里没有 items 数组');
  return items;
}

async function main() {
  if (IF_DUE) {
    const st = readJson(STATUS, null);
    if (st?.result === 'ok' && st.lastRun) {
      const age = Date.now() - Date.parse(st.lastRun);
      if (Number.isFinite(age) && age < DUE_HOURS * 3600_000) {
        log(`--if-due：上次成功在 ${st.lastRun}（${Math.round(age / 3600_000)} 小时前），跳过`);
        return 0;
      }
    }
    log('--if-due：上次成功已过期或上次失败，补跑');
  }

  const rows = readIndex();
  if (!rows.length) {
    log('索引为空或不可读，退出');
    writeStatus('failed', '读不到 MEMORY.md 索引');
    return 1;
  }
  const targets = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.protected) continue;
    const body = readBody(row.file);
    if (count(body) < MIN_BODY) continue;
    targets.push({ file: row.file, keywords: row.keywords, body });
  }
  log(`索引 ${rows.length} 条，送模型 ${targets.length} 条（锁定/停用/过短已排除）`);
  if (!targets.length) {
    writeStatus('ok', '没有需要整理的记忆');
    return 0;
  }

  const request = buildRequest(targets);
  if (DRY) {
    console.log(JSON.stringify(request, null, 2));
    log('--dry-run：只打印请求，不联网不写盘');
    return 0;
  }

  const key = apiKey();
  if (!key) {
    log('没有 DSH_AUTOMATION_API_KEY（~/.dsh/automation.env）');
    writeStatus('failed', '缺少 DSH_AUTOMATION_API_KEY，请在 ~/.dsh/automation.env 里配置');
    return 1;
  }

  let payload;
  try {
    payload = await callModel(key, request);
  } catch (err) {
    log(`模型调用失败：${err.message}`);
    writeStatus('failed', err.message.slice(0, 300));
    return 1;
  }

  const usage = payload?.usage || {};
  log(
    `模型返回：prompt ${usage.prompt_tokens ?? '?'} + completion ${usage.completion_tokens ?? '?'} tokens，缓存命中 ${usage.prompt_cache_hit_tokens ?? 0}`,
  );

  const byFile = new Map(targets.map((t) => [t.file, t]));
  let items;
  try {
    items = parseItems(payload?.choices?.[0]?.message?.content);
  } catch (err) {
    log(`解析失败：${err.message}`);
    writeStatus('failed', `模型输出无法解析：${err.message}`);
    return 1;
  }

  fs.mkdirSync(PROPOSED, { recursive: true });
  let written = 0;
  const skipped = [];
  for (const item of items.slice(0, MAX_PROPOSALS * 3)) {
    if (written >= MAX_PROPOSALS) break;
    const file = String(item?.file || '').trim();
    const body = String(item?.body || '').trim();
    const src = byFile.get(file);
    if (!src) {
      skipped.push(`${file || '?'}：不在送审名单`);
      continue;
    }
    if (!body) {
      skipped.push(`${file}：空正文`);
      continue;
    }
    if (body.trim() === String(src.body || '').trim()) {
      skipped.push(`${file}：原文未动，不提审`);
      continue;
    }
    const ratio = count(body) / Math.max(1, count(src.body));
    if (ratio < KEEP_RATIO || ratio > 1.3) {
      skipped.push(`${file}：长度 ${Math.round(ratio * 100)}%，超出 ${KEEP_RATIO * 100}~130% 容忍带`);
      continue;
    }
    // 方案只写正文：YAML 头由 approveFile() 沿用原文件的，description 不会被冲掉。
    fs.writeFileSync(path.join(PROPOSED, file), `${body}\n`, 'utf8');
    written += 1;
    log(`提案：${file}  ${count(src.body)} → ${count(body)} 字`);
  }

  for (const s of skipped) log(`跳过：${s}`);
  if (!written) {
    writeStatus('ok', `模型没有给出可用改稿（跳过 ${skipped.length} 条）`);
    return 0;
  }
  writeStatus('ok', `提出 ${written} 份改稿${skipped.length ? `，跳过 ${skipped.length} 条` : ''}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    log(`未捕获异常：${err.message}`);
    writeStatus('failed', err.message);
    process.exitCode = 1;
  },
);
