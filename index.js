/**
 * 记忆整理状态（Host half）。
 *
 * 给模型一行中立的状态提示：有提案、上次失败、长期没跑。
 * 只读文件、无模型调用、不注册界面；任何异常都吞掉，保证不影响宿主启动。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const name = 'dsh-memory';

export const inject = ['systemPrompt'];

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const MEM = path.join(HOME, 'memory');
const TIDY = path.join(MEM, '.tidy');
const STATUS = path.join(TIDY, 'status.json');
const PROPOSED = path.join(TIDY, 'proposed');
const ENV_FILE = path.join(HOME, 'automation.env');
const MEM_LIMIT = 2000; // 记忆正文的建议长度；只是提示，不拦截
const OUTLINE_KW_MAX = 42; // 大纲里单条记忆关键词的展示上限；超了在关键词边界裁剪（要装得下「分类/」前缀）
const RECALL = path.join(TIDY, 'recall.json'); // 回忆流水：{turn, file, ts}
const CALLS = path.join(TIDY, 'calls.json'); // 记忆调用流水：{ts, sessionId, turn, op, target, keywords, chars}
const CALL_KEEP = 400; // 调用流水最多留这么多条
const TURNS = path.join(TIDY, 'turns.json'); // 全局用户轮计数 {count}
const WINDOW_TURNS = 100; // 回忆率的统计窗口 = 最近 100 个用户轮
const COMPRESS_EVERY = 100; // 每 100 轮触发一次压缩判定
const HIGH_FREQ = 11; // 窗口内 >=11 次 = 高频，不送压缩
const STALE_DAYS = 14; // 无回忆 + 超过这么多天 → 报备删除
const COMPRESS = path.join(TIDY, 'compress.json'); // {startedAt, finishedAt, stage, reason, files, detail}
const COMPRESS_STALE_MS = 15 * 60_000; // 有 startedAt 无 finishedAt 且超过这么久 → 判定上次中断
const COMPRESS_ENDPOINT = process.env.MEMORY_COMPRESS_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const COMPRESS_MODEL = process.env.MEMORY_COMPRESS_MODEL || 'deepseek-flash'; // 官方模型 ID：deepseek-flash / deepseek-v4-pro
const COMPRESS_TIMEOUT_MS = 180_000;
const KEEP_LIGHT = 0.75; // 轻调整：至少压到原文 75%（低于这个算删过头）
const LIGHT_MAX = 0.90; // 轻调整：最多留 90%（高于这个算没压到位）
const KEEP_HEAVY = 0.5; // 中删减：至少压到原文 50%
const HEAVY_MAX = 0.7; // 中删减：最多留 70%
const NOOP_RATIO = 0.97; // 缩减不到 3% 视为「几乎未动」，不提审
const COMPRESS_BATCH = 4; // 每次请求最多送几份：送太多时思考会吃光输出预算，回包直接空
const COMPRESS_MAX_TOKENS = 8192; // 官方上限；不显式给的话默认预算装不下几份改稿

/** 压缩流水线的现场记录：每次模型调用的输入规模、输出字数、token 用量。 */
function compressTrace(text) {
  try {
    fs.mkdirSync(TIDY, { recursive: true });
    fs.appendFileSync(path.join(TIDY, 'compress.log'), `[${new Date().toISOString()}] ${text}\n`, 'utf8');
  } catch {
    /* 追踪写不进去不影响主流程 */
  }
}
const CATEGORIES = ['资料', '教训', '说明书', '项目记忆', '其它'];
const MANUAL_CATEGORY = '项目记忆'; // 只由 /remember 或设置页新建产生，模型不许手写
const MEM_REAL = (() => {
  try {
    return fs.realpathSync.native(MEM);
  } catch {
    return MEM;
  }
})();
const ROUTE = '/dsh-memory/status';
const KEYWORD_ROUTE = '/dsh-memory/keyword';
const OPEN_ROUTE = '/dsh-memory/open';
const APPROVE_FILE_ROUTE = '/dsh-memory/approve-file';
const REJECT_FILE_ROUTE = '/dsh-memory/reject-file';
const TOGGLE_ROUTE = '/dsh-memory/toggle';
const PROTECT_ROUTE = '/dsh-memory/protect';
const CREATE_ROUTE = '/dsh-memory/create';
const DELETE_ROUTE = '/dsh-memory/delete';
const SEARCH_ROUTE = '/dsh-memory/search';
const CALLS_ROUTE = '/dsh-memory/calls';
const CALL_ROUTE = '/dsh-memory/call';
const COMPRESS_ROUTE = '/dsh-memory/compress';
const REMEMBER_ROUTE = '/dsh-memory/remember';
const DOCK_PING_ROUTE = '/dsh-memory/dockping';

function daysSince(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
}

/** 读一个 JSON 文件，坏了就当空。 */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(TIDY, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch {
    /* 统计写不进去不影响主流程 */
  }
}

/** 插件自己的错误落盘：注册/路由这类不该吵到用户、但排查时必须有据可查的问题。 */
function logPluginError(where, err) {
  try {
    fs.mkdirSync(TIDY, { recursive: true });
    fs.appendFileSync(
      path.join(TIDY, 'plugin-error.log'),
      `[${new Date().toISOString()}] ${where}: ${String(err?.stack || err)}\n`,
      'utf8',
    );
  } catch {
    /* 连日志都写不进去就只能放弃 */
  }
}

/** 取 agents 服务：插件 ctx 与根 ctx 都试一遍（不同宿主版本可见性不同）。 */
function resolveAgents(ctx) {
  for (const scope of [ctx, ctx && ctx.root]) {
    if (!scope || typeof scope.get !== 'function') continue;
    try {
      const agents = scope.get('agents');
      if (agents) return agents;
    } catch {
      /* 换下一个作用域 */
    }
  }
  return undefined;
}

/** 全局用户轮计数：只数用户会话的轮，子代理的轮不算。 */
let turnCount = 0;

function loadTurnCount() {
  const saved = readJson(TURNS, null);
  turnCount = Number.isFinite(saved?.count) ? saved.count : 0;
}

function bumpTurn() {
  turnCount += 1;
  writeJson(TURNS, { count: turnCount });
}

/**
 * 记一次回忆：同一轮读同一份记忆多次只算一次。
 * 轮 = 用户按一次回车（`bumpTurn` 在 user/message 事件里 +1，此刻正在这一轮）。
 * 所以这次读就记在**当前轮**，不能 +1——早先写成 turnCount+1，本轮读的要等下一次发消息才被算进窗口。
 */
function recordRecall(file) {
  const list = readJson(RECALL, []);
  const events = Array.isArray(list) ? list : [];
  const turn = turnCount || 1;
  if (events.some((e) => e && e.turn === turn && e.file === file)) return;
  events.push({ turn, file, ts: new Date().toISOString() });
  writeJson(RECALL, events.slice(-800));
}

/** 窗口内每条记忆被回忆过的轮数（不是百分比）。 */
function recallHits() {
  const out = new Map();
  const size = Math.min(WINDOW_TURNS, turnCount);
  if (!size) return out;
  const fromTurn = turnCount - size + 1;
  const seen = new Map();
  const events = readJson(RECALL, []);
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev.turn !== 'number' || ev.turn < fromTurn || ev.turn > turnCount) continue;
    if (!seen.has(ev.file)) seen.set(ev.file, new Set());
    seen.get(ev.file).add(ev.turn);
  }
  for (const [file, turns] of seen) out.set(file, turns.size);
  return out;
}

/** 回忆率：窗口内「被回忆过的轮数 / 窗口轮数」，整数百分比。 */
function recallRates() {
  const hits = recallHits();
  const size = Math.min(WINDOW_TURNS, turnCount);
  const out = new Map();
  if (!size) return out;
  for (const [file, count] of hits) out.set(file, Math.round((count / size) * 100));
  return out;
}

/** 首关键词就是分类；缺了或不在表里返回空串。 */
function categoryOf(keywords) {
  const head = String(keywords || '').split('/')[0].trim();
  return CATEGORIES.includes(head) ? head : '';
}

/**
 * 校验首关键词是分类。`allowManual` 给设置页的人工新建用：
 * 「项目记忆」只由人手动产生，模型通道仍然拒绝。
 */
function assertCategory(keywords, { allowManual = false } = {}) {
  const head = String(keywords || '').split('/')[0].trim();
  if (!head) {
    throw new Error('keywords 的第一个关键词必须是分类：资料 / 教训 / 说明书 / 其它');
  }
  if (head === MANUAL_CATEGORY && !allowManual) {
    throw new Error(`${MANUAL_CATEGORY} 只能由用户点「大脑」按钮生成，模型不要自己写；请改用 资料 / 教训 / 说明书 / 其它`);
  }
  if (!CATEGORIES.includes(head)) {
    throw new Error(`第一个关键词「${head}」不是合法分类，只能是：资料 / 教训 / 说明书 / 其它（${MANUAL_CATEGORY} 仅手动）`);
  }
}

/**
 * 一个路径在记忆仓库里是什么身份。所有「要不要拦」「要不要提醒」的判断都走这里，
 * 避免各处各写一套字符串比较。
 *
 * 判定用 realpath + path.relative：symbol link、`..`、大小写差异都会被归一到同一身份。
 * 返回 root（仓库根）| index（MEMORY.md）| internal（.tidy 下的状态与方案）| body（记忆正文）| outside。
 */
function memoryKind(raw) {
  const text = String(raw || '').trim();
  if (!text) return 'outside';
  let abs;
  try {
    abs = path.resolve(text);
  } catch {
    return 'outside';
  }
  let real = abs;
  try {
    real = fs.realpathSync.native(abs); // 存在的路径先归一（解掉符号链接）
  } catch {
    /* 还不存在（例如 memory_write 要建的新文件）就按字面路径判断 */
  }
  const rel = path.relative(MEM_REAL, real);
  if (!rel) return 'root';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return 'outside';
  const segs = rel.split(path.sep);
  if (segs[0] === '.tidy') return 'internal';
  if (segs.length === 1 && segs[0].toLowerCase() === 'memory.md') return 'index';
  return 'body';
}

/** 正文的字数：YAML 头不算，按字符数（一个汉字算一个）。 */
function bodyLength(text) {
  const t = text.replace(/^\uFEFF/, '');
  const m = t.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = (m ? t.slice(m[0].length) : t).trim();
  return { body, length: Array.from(body).length };
}

/** 按名称、关键词或描述找一条启用的记忆；找不到返回 null。 */
function resolveEntry(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const norm = q.replace(/\.md$/i, '');
  const entries = readEntries().filter((e) => e.enabled);
  const byName = entries.find((e) => e.file.replace(/\.md$/i, '') === norm);
  if (byName) return byName;
  const needle = norm.toLowerCase();
  return (
    entries.find((e) => {
      if ((e.keywords || '').toLowerCase().includes(needle)) return true;
      const desc = paramsOf(e.file).find((p) => p.label === '描述')?.value || '';
      return desc.toLowerCase().includes(needle);
    }) || null
  );
}

/** 只取正文：YAML 头是参数，不给模型看。 */
function readMemoryBody(file) {
  const text = fs.readFileSync(path.join(MEM, file), 'utf8').replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? text.slice(m[0].length) : text).trim();
}

/** 拆出 YAML 属性和正文，用于改写。 */
function splitDoc(text) {
  const t = text.replace(/^\uFEFF/, '');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { attrs: [], body: t.trim() };
  return { attrs: m[1].split(/\r?\n/).filter((l) => l.trim()), body: t.slice(m[0].length).trim() };
}

function setAttr(attrs, key, value) {
  const line = `${key}: ${value}`;
  const idx = attrs.findIndex((l) => l.split(':')[0].trim() === key);
  if (idx >= 0) attrs[idx] = line;
  else attrs.push(line);
}

function joinDoc(attrs, body) {
  return `---\n${attrs.join('\n')}\n---\n\n${body}\n`;
}

/** 记忆名只允许小写字母、数字、连字符。 */
function assertName(name) {
  const n = String(name || '').trim().replace(/\.md$/i, '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(n)) {
    throw new Error('名称只能用英文小写、数字和连字符，例如 girlfriend-profile');
  }
  return n;
}

function oneLine(value, max = 160) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 在索引表最后一条数据行后面追加一行。 */
function addIndexRow({ file, keywords, type, hint }) {
  const p = path.join(MEM, 'MEMORY.md');
  const text = fs.readFileSync(p, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|')) continue;
    const cells = lines[i].split('|').slice(1, -1);
    const name = (cells[0] || '').replace(/`/g, '').trim();
    if (name.endsWith('.md')) last = i;
  }
  if (last < 0) throw new Error('索引表里找不到可追加的位置');
  lines.splice(last + 1, 0, `| \`${file}\` | ${keywords} | 是 | ${type} | ${hint} | ${today()} | 否 |`);
  fs.writeFileSync(p, lines.join(eol), 'utf8');
}

function removeIndexRow(file) {
  const p = path.join(MEM, 'MEMORY.md');
  const text = fs.readFileSync(p, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => {
    if (!line.trim().startsWith('|')) return true;
    const cells = line.split('|').slice(1, -1);
    const name = (cells[0] || '').replace(/`/g, '').trim();
    return name !== file;
  });
  fs.writeFileSync(p, kept.join(eol), 'utf8');
}

/** 写超了就提一句，不拦截。用词刻意放轻：说重了模型会为了缩字数丢信息。 */
function lengthNote(file, body) {
  const { length } = bodyLength(body);
  if (length <= MEM_LIMIT) return '';
  return `\n提示：正文略长，排除 YAML 头共 ${length} 字，建议 ${MEM_LIMIT} 字以内。如果正文已足够简洁，可以忽略本提醒。`;
}

/** 这次工具调用写的是哪个记忆正文；不是正文就返回空串。 */
function memoryTargetOf(exec) {
  const args = exec && exec.arguments;
  if (!args || typeof args !== 'object') return '';
  const raw = String(args.file_path || args.path || '');
  if (!raw || memoryKind(raw) !== 'body') return '';
  return path.resolve(raw);
}


/** 超长提醒：写入照常生效，只提一句，不回显正文（回显会把上下文撑大）。 */
function oversizeWarning(file, length) {
  return `提示：${file} 的正文略长，排除 YAML 头共 ${length} 字，建议 ${MEM_LIMIT} 字以内。如果正文已足够简洁，可以忽略本提醒。`;
}

/** 待审批的整理方案：每份是一个整篇新正文的文件。 */
function proposedFiles() {
  try {
    return fs.readdirSync(PROPOSED).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

/** 只取正文：YAML 头属于参数，不进入对比视图。 */
function bodyOnly(text) {
  const t = String(text).replace(/^\uFEFF/, '');
  const m = t.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? t.slice(m[0].length) : t;
}

/** 逐份读出「原文正文 / 新文正文」供页面对比，超过上限只读前 20 KB。 */
function readProposals() {
  const out = [];
  for (const file of proposedFiles()) {
    let after = '';
    let before = '';
    try {
      after = bodyOnly(fs.readFileSync(path.join(PROPOSED, file), 'utf8')).slice(0, 20000);
      before = bodyOnly(fs.readFileSync(path.join(MEM, file), 'utf8')).slice(0, 20000);
    } catch {
      continue;
    }
    const a = after.trim();
    const b = before.trim();
    out.push({
      file,
      before,
      after,
      beforeCount: Array.from(b).length,
      afterCount: Array.from(a).length,
      // 只字未动的方案没有批准的意义，页面要能看出来
      same: a === b,
    });
  }
  return out;
}

/** 本地时间到秒：2026-10-28 14:03:27 */
function stampOf(date) {
  const t = date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
  if (!t) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

const FM_LABELS = [
  ['name', '名称'],
  ['description', '描述'],
  ['type', '类型'],
  ['reviewed', '复核'],
];

/** 记忆的参数（frontmatter），参数名翻成中文供卡片展开显示。 */
function paramsOf(file) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(MEM, file), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return [];
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && v) fm[k] = v;
    }
  }
  const params = FM_LABELS.filter(([k]) => fm[k]).map(([k, label]) => ({ label, value: fm[k] }));
  // 文件系统时间戳精确到秒：创建（birthtime）/ 更新（mtime）。不支持 birthtime 的平台退回 ctime。
  try {
    const st = fs.statSync(path.join(MEM, file));
    const created = st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.ctime;
    params.push({ label: '创建', value: stampOf(created) });
    params.push({ label: '更新', value: stampOf(st.mtime) });
  } catch {
    /* 读不到时间戳就不显示 */
  }
  return params;
}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

/**
 * 批准：新文覆盖原文件正文，更新复核日期，删掉方案。锁定的记忆不许覆盖。
 * 方案里只有正文（压缩流水线就是这么写的）；正文的 YAML 头沿用原文件的，
 * 这样 description 不会被改稿冲掉。旧方案若自带 YAML 头也能兼容。
 */
function approveFile(file) {
  if (!/^[\w.-]+\.md$/.test(file) || file === 'MEMORY.md') throw new Error('文件名非法');
  const entry = readEntries().find((e) => e.file === file);
  if (entry?.protected) throw new Error('这份记忆已锁定，不能修改原文');
  const src = path.join(PROPOSED, file);
  if (!fs.existsSync(src)) throw new Error('方案不存在');
  const target = path.join(MEM, file);
  const incoming = splitDoc(fs.readFileSync(src, 'utf8'));
  const current = fs.existsSync(target) ? splitDoc(fs.readFileSync(target, 'utf8')) : { attrs: [], body: '' };
  const attrs = current.attrs.length ? [...current.attrs] : [...incoming.attrs];
  setAttr(attrs, 'reviewed', today());
  fs.writeFileSync(target, joinDoc(attrs, incoming.body), 'utf8');
  updateCell(file, 6, today());
  fs.unlinkSync(src);
  return file;
}

/** 拒绝：只删方案，不动原文件。 */
function rejectFile(file) {
  if (!/^[\w.-]+\.md$/.test(file) || file === 'MEMORY.md') throw new Error('文件名非法');
  const src = path.join(PROPOSED, file);
  if (!fs.existsSync(src)) throw new Error('方案不存在');
  fs.unlinkSync(src);
  return file;
}

/**
 * 设置页新建一条记忆：文件和索引行一起写。
 * 先写文件再补索引；索引补不上就把文件撤回，不留孤儿（旧版 memory_write 就栽在这）。
 * 这是人工通道，所以允许首关键词写「项目记忆」。
 */
function createMemory(input) {
  const name = assertName(input?.name);
  const file = `${name}.md`;
  if (fs.existsSync(path.join(MEM, file))) {
    throw new Error(`记忆 ${file} 已经存在；要改内容请用 memory_update`);
  }
  const keywords = oneLine(input?.keywords, 80);
  const description = oneLine(input?.description);
  const type = oneLine(input?.type, 24) || 'reference';
  const body = String(input?.body || '').trim();
  if (!keywords) throw new Error('关键词不能为空，否则大纲里点不到它');
  assertCategory(keywords, { allowManual: true });
  if (!description) throw new Error('描述不能为空，一句话说清什么时候读');
  if (!body) throw new Error('正文不能为空');
  const target = path.join(MEM, file);
  fs.writeFileSync(
    target,
    joinDoc([`name: ${name}`, `description: ${description}`, `type: ${type}`, `reviewed: ${today()}`], body),
    'utf8',
  );
  try {
    addIndexRow({ file, keywords, type, hint: description });
  } catch (err) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* 撤回失败也要把原始错误抛出去 */
    }
    throw new Error(`索引写入失败，已撤回文件：${err.message}`);
  }
  return file;
}

/** 设置页删除一条记忆：锁定的不许删；连它未审的方案一起清掉，免得留下改稿指向不存在的记忆。 */
function deleteMemory(file) {
  if (!/^[\w.-]+\.md$/.test(file) || file === 'MEMORY.md') throw new Error('文件名非法');
  const entry = readEntries().find((e) => e.file === file);
  if (!entry) throw new Error(`索引里没有 ${file}`);
  if (entry.protected) throw new Error(`记忆 ${file} 已锁定，先在设置页解锁再删`);
  const target = path.join(MEM, file);
  // 索引里有、磁盘上没了（文件被手动删掉 / 迁移中断）：这张卡片必须还能删得掉，
  // 否则死行会永远钉在面板上（2026-10-28 实测：报「文件不存在」，卡片再也清不掉）。
  const ghost = !fs.existsSync(target);
  const indexText = fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8');
  if (!ghost) fs.unlinkSync(target);
  try {
    removeIndexRow(file);
  } catch (err) {
    try {
      fs.writeFileSync(path.join(MEM, 'MEMORY.md'), indexText, 'utf8');
    } catch {
      /* 索引连备份都写不回去，只能把原始错误抛出去 */
    }
    // 文件已经删了，索引还原不了也没意义：把原始错误抛出去让用户知道索引没干净
    throw new Error(`索引行删除失败，已尝试还原索引：${err.message}`);
  }
  try {
    const prop = path.join(PROPOSED, file);
    if (fs.existsSync(prop)) fs.unlinkSync(prop);
  } catch {
    /* 方案清不掉不影响删除本体 */
  }
  return ghost ? { file, ghost: true } : { file, ghost: false };
}

/**
 * 设置页搜索：关键词、「何时读」、frontmatter 描述、正文都算命中。
 * 正文命中时给原文附近几行（±2 行，最多 3 处），前端直接展示。
 */
function searchMemories(rawQuery) {
  const q = String(rawQuery || '').trim();
  if (!q) return { q, matches: [] };
  const needle = q.toLowerCase();
  const matches = [];
  for (const entry of readEntries()) {
    const snippets = [];
    let hits = 0;
    const kw = entry.keywords || '';
    const when = entry.whenToRead || '';
    const desc = (entry.params || []).find((p) => p.label === '描述')?.value || '';
    if (kw.toLowerCase().includes(needle)) {
      hits += 1;
      snippets.push({ kind: 'keywords', label: '关键词', text: kw });
    }
    if (when.toLowerCase().includes(needle)) {
      hits += 1;
      snippets.push({ kind: 'when', label: '何时读', text: when });
    }
    if (desc && desc.toLowerCase().includes(needle)) {
      hits += 1;
      snippets.push({ kind: 'description', label: '描述', text: desc });
    }
    const body = readMemoryBody(entry.file);
    if (body) {
      const lines = body.split(/\r?\n/);
      const idx = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) idx.push(i);
      }
      if (idx.length) {
        hits += idx.length;
        const windows = [];
        for (const i of idx) {
          if (windows.some(([a, b]) => i >= a - 1 && i <= b + 1)) continue;
          windows.push([Math.max(0, i - 2), Math.min(lines.length - 1, i + 2)]);
          if (windows.length >= 3) break;
        }
        for (const [a, b] of windows) {
          const text = lines.slice(a, b + 1).join('\n').trim();
          if (!text) continue;
          snippets.push({
            kind: 'body',
            label: `正文第 ${a + 1} 行`,
            line: a + 1,
            text: text.length > 320 ? `${text.slice(0, 320)}…` : text,
          });
        }
      }
    }
    if (hits) matches.push({ file: entry.file, hits, snippets });
  }
  return { q, matches };
}

/** DeepSeek 的 key：环境变量优先，其次 automation.env。 */
function apiKey() {
  if (process.env.DSH_AUTOMATION_API_KEY) return process.env.DSH_AUTOMATION_API_KEY.trim();
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*DSH_AUTOMATION_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  } catch {
    /* 没配就是没配 */
  }
  return '';
}

// ── 压缩流水线 ────────────────────────────────────────────────────────────────
// 规则（用户 2026-10-27 定稿）：窗口 100 轮，按回忆次数分档；锁定与高频不送模型；
// 0 次且超 2 周只报备删除（不花 token）；其余按新旧送「轻调整 / 中删减」。
// 送模型的只有正文和必要提示词，不带 DSH 自己的工具提示。

const COMPRESS_LIGHT_SYSTEM = [
  '你是记忆的轻调整器。用户会给你若干条记忆（关键词 + 正文），是他长期积累的笔记。',
  '轻调整 = 只在原结构上润色：合并重复句子、删掉同义反复、把长句剪短，不删整段，不改语气，不补新事实。',
  '任何可执行的用法、命令、路径、版本号、坑与限制都必须原样保留——那是以后要照着做的。',
  '只改正文，不改关键词、不改 YAML 头。目标篇幅：原文的 75%–90%；少于 75% 算删过头，超过 90% 算没压到位。',
  '只输出 JSON：{"items":[{"file":"x.md","body":"改写后的完整正文"}]}，不要解释、不要代码围栏。',
].join('\n');

const COMPRESS_HEAVY_SYSTEM = [
  '你是记忆的中删减器。用户会给你若干条记忆（关键词 + 正文），是他长期积累的笔记。',
  '中删减 = 合并小节、删掉过时或重复的段落、把清单压成更短的行，但不许删掉任何可执行的用法、命令、路径、版本号、坑与限制。',
  '不补新事实，不改语气，不改关键词，不改 YAML 头。目标篇幅：原文的 50%–70%；少于 50% 算删过头，超过 70% 算没压到位。',
  '只输出 JSON：{"items":[{"file":"x.md","body":"改写后的完整正文"}]}，不要解释、不要代码围栏。',
].join('\n');

let compressRunning = false;

/**
 * `memory_write` 工具的声明。工具注册和 `/remember` 的隐藏调用共用这一份：
 * 模型「往里填空」时用的是工具参数的 JSON Schema（原生 function calling），
 * 而不是让它在自由文本里手写 JSON——后者才是「模型没有返回 JSON」的根源。
 */
const WRITE_TOOL_DESCRIPTION = [
  '记住一件以后还会用到的事。任务收尾时过一遍：有没有新的稳定事实、可复用的做法、或一次纠正？有就写一条，最多一条。',
  '首词是分类：资料 / 教训 / 说明书 / 其它（项目记忆 只由用户点「大脑」按钮生成）。后面的词决定「以后什么情况下能想起它」：',
  '· 资料 写内容类型（资料/身份/联系方式），不要只写人名；',
  '· 说明书 写工具名（说明书/btw插件）；',
  '· 教训 先想清「犯这个错之前我正在做什么任务、什么动作」，再把那个场景写进关键词（教训/插件往会话注入消息、教训/截断长文本）。',
  '  不要写 400、422、报错 这类事后症状名——那是修复时的抓手，不是预防的触发词。',
  '关键词用完整、泛化的短语；可被想起比检索精度重要。',
  '写「教训」时 body 必须三段，缺一段就没有预防作用：① 场景（什么任务、什么动作会踩到，读者一看就知道「我现在正在这个场景里」）；② 错误链条（第一步做什么、哪步开始不对、为什么没察觉）；③ 绕开与修复（下次怎么走、已部署什么防护）。',
].join(' ');

const WRITE_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '记忆名称，英文小写和连字符，如 gift-ideas。' },
    keywords: {
      type: 'string',
      description:
        '1~5 个词，用 / 分隔，首词是分类。资料写内容类型（资料/身份/联系方式），教训写犯错前的场景/任务（教训/插件往会话注入消息），说明书写工具名（说明书/btw插件）；不要写 400、422 这类事后症状名。',
    },
    description: { type: 'string', description: '一句话说清这是什么、什么时候该读。' },
    body: { type: 'string', description: '正文，Markdown，写完整句子；2000 字以内通常够用，内容确实需要可以更长。' },
    type: { type: 'string', description: '可选：reference / profile / 其他，默认 reference。' },
  },
  required: ['name', 'keywords', 'description', 'body'],
  additionalProperties: false,
};

/**
 * `/remember` 给主 agent 的工具声明：同一个 `memory_write` 工具，
 * 只把「关键词首词」和「内容取向」改成本次任务的口径。
 */
const REMEMBER_TOOL = {
  name: 'memory_write',
  description:
    '把以上这段对话提炼成一条「项目记忆」并写入记忆库。想清楚内容后立刻调用一次，不要用文字回答，也不要写 JSON 文本。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '记忆名称，英文小写和连字符，取项目名，如 dsh-memory。' },
      keywords: {
        type: 'string',
        description: '第一个词固定是「项目记忆」，第二个词是项目名，后面最多 3 个词写这个项目里最可能再次遇到的场景/任务，用 / 分隔。',
      },
      description: { type: 'string', description: '一句话说清以后什么时候该读这条记忆。' },
      body: {
        type: 'string',
        description:
          'Markdown 正文，通常 2000 字以内足够，写清楚比写短更重要。分条写：工作剖面（在哪、干什么）、项目目标、产物情况、待办清单、风险点。',
      },
      type: { type: 'string', description: '可选，一般省略，默认 reference。' },
    },
    required: ['name', 'keywords', 'description', 'body'],
    additionalProperties: false,
  },
};

/**
 * `/remember` 的隐藏指令：作为最后一条 user 消息追加到主 agent 自己的上下文后面，
 * 只存在于这一次请求里，不写会话、不显示在界面上。
 */
const REMEMBER_INSTRUCTION = [
  '［记忆插件·隐藏指令］把以上这段对话提炼成一条「项目记忆」，直接调用 memory_write 工具写入，不要用文字回答。',
  '填写要求：',
  '1. name：英文小写和连字符，取项目名；',
  '2. keywords：第一个词固定写「项目记忆」，第二个词是项目名，后面最多 3 个词写这个项目里最可能再次遇到的场景/任务；',
  '3. 关键词要写完整、泛化的词或短语（如「说明书/alarm插件/闹钟使用」），不要拆成「钟」「时针」「铃声」「定时」这种碎片字词——目的不是检索精度，而是让以后需要它的 agent 一定能想起这条记忆；',
  '4. body：Markdown 正文，2000 字以内通常够用，写清楚比写短更重要；分条写工作剖面（在哪、干什么）、项目目标、产物情况、待办清单、风险点；',
  '5. description：一句话说清以后什么时候该读它。',
].join('\n');

const REMEMBER_RETRY_INSTRUCTION = [
  REMEMBER_INSTRUCTION,
  '',
  '［纠正］上一轮你没有调用 memory_write（或参数不完整）。这次必须直接调用它，把 name、keywords、description、body 填全，不要输出任何解释文字。',
].join('\n');

/** llm 服务不可用时的兜底系统提示词：只发对话记录，不带 DSH 的工具提示。 */
const REMEMBER_SYSTEM = [
  '你是项目记忆整理器。用户会给你一段对话记录，你把它压成一条「项目记忆」，用 memory_write 工具写入。',
  '要求：name 用英文小写和连字符取项目名；keywords 第一个词固定是「项目记忆」，第二个词是项目名，后面最多 3 个完整、泛化的短语；',
  'body 用 Markdown 分条写工作剖面、项目目标、产物情况、待办清单、风险点，通常 2000 字以内足够；',
  'description 一句话说清以后什么时候该读它。只调用工具，不要输出文字。',
].join('\n');

/** 追加一条调用流水，只留最近 CALL_KEEP 条。 */
function appendCall(row) {
  try {
    const list = readJson(CALLS, []);
    const events = Array.isArray(list) ? list : [];
    const id = row.id || row.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    events.push({ ts: new Date().toISOString(), turn: turnCount, ...row, id });
    writeJson(CALLS, events.slice(-CALL_KEEP));
    return id;
  } catch {
    /* 流水写不进去不影响工具本身 */
    return '';
  }
}

/** 删除前先记住这份正文：删完文件就没了，详情里要显示真正被删掉的内容。 */
const DELETED_BODIES = new Map();

/**
 * 工具执行完记一笔：会话、轮、操作、目标、关键词、类型，以及**真正进出的完整内容**
 * （读=注入给模型的那段；写/改=写进文件的正文；删=删掉前的正文）。
 */
function recordMemoryCall(exec) {
  try {
    const args = exec?.arguments || {};
    const op = String(exec.name || '').replace(/^memory_/, '');
    const raw = String(args.file || args.name || '').trim();
    const target = raw.replace(/\.md$/i, '');
    if (!target) return;
    const file = `${target}.md`;
    const entry = readEntries().find((e) => e.file === file);
    const gone = op === 'delete' ? DELETED_BODIES.get(exec?.callId) : null;
    let content = '';
    if (op === 'read') content = `【记忆：${target}】\n\n${readMemoryBody(file) || ''}`;
    else if (op === 'write') content = String(args.body || '').trim();
    else if (op === 'update') content = readMemoryBody(file) || '';
    else if (op === 'delete') content = gone?.body || '';
    appendCall({
      id: exec?.callId || '',
      callId: exec?.callId || '',
      sessionId: exec?.agent?.session?.id || '',
      op,
      target,
      keywords: entry?.keywords || gone?.keywords || '',
      type: entry?.type || gone?.type || '',
      cat: String(entry?.keywords || gone?.keywords || '').split('/')[0].trim(),
      chars: Array.from(content).length,
      content,
      ok: true,
    });
    if (op === 'delete') DELETED_BODIES.delete(exec?.callId);
  } catch {
    /* 记录失败不影响工具本身 */
  }
}

/** 每条记忆该不该压缩、按哪一档。 */
function compressPlan() {
  const hits = recallHits();
  const plan = [];
  for (const entry of readEntries()) {
    if (!entry.enabled || entry.protected) continue;
    const count = hits.get(entry.file) || 0;
    const age = daysSince(entry.reviewed);
    const body = readMemoryBody(entry.file);
    let level;
    if (count >= HIGH_FREQ) level = 'skip-high';
    else if (count === 0 && Number.isFinite(age) && age >= STALE_DAYS) level = 'stale';
    else if (count === 0) level = 'heavy';
    else if (count === 1 && Number.isFinite(age) && age >= STALE_DAYS) level = 'heavy';
    else level = 'light';
    plan.push({ file: entry.file, keywords: entry.keywords, hits: count, age, level, body });
  }
  return plan;
}

/** 从模型输出里抠 JSON（容忍围栏与前后废话）。 */
function parseCompressItems(content) {
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

/** 一次模型调用：180 s 超时，5xx/429/超时重试，400 时逐项摘掉可选字段。 */
async function chatOnce(key, body) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPRESS_TIMEOUT_MS);
    try {
      const res = await fetch(COMPRESS_ENDPOINT, {
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
      const payload = JSON.parse(text);
      return { payload, content: payload?.choices?.[0]?.message?.content ?? '' };
    } catch (err) {
      lastErr = err;
      // 兼容旧/新部署：400 时只摘 tool_choice / response_format。
      // 不要摘 thinking——不传字段等于默认开思考，会把输出预算吃光（2026-10-28 实测）。
      if (err.status === 400 && attempt < 3) {
        if (body.tool_choice !== undefined) {
          delete body.tool_choice;
          continue;
        }
        if (body.response_format !== undefined) {
          delete body.response_format;
          continue;
        }
      }
      const retriable = !err.status || err.status >= 500 || err.status === 429 || err.name === 'AbortError';
      if (!retriable || attempt === 3) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('模型请求失败');
}

/** 回包正文里有没有一段闭合的 JSON 对象；没有就是空回包或被截断。 */
function hasJsonObject(content) {
  const text = String(content || '');
  const a = text.indexOf('{');
  if (a < 0) return false;
  return text.lastIndexOf('}') > a;
}

/**
 * 一次 JSON 请求：只认正文里的 JSON（reasoning_content 里的是思考过程，不是答复）。
 * 空回包或被截断就原样重试一次；仍失败把 finish_reason 与 token 用量写进错误，
 * 不再报那句谁也看不懂的「模型输出里没有 JSON 对象」。
 */
async function chatJson(key, body) {
  let out = await chatOnce(key, body);
  let content = String(out?.content ?? '');
  if (!hasJsonObject(content)) {
    const choice = out?.payload?.choices?.[0] || {};
    compressTrace(`回包不可用（finish=${choice.finish_reason}，${Array.from(content).length} 字${content.includes('{') ? '，JSON 未闭合' : ''}），原样重试一次`);
    out = await chatOnce(key, body);
    content = String(out?.content ?? '');
  }
  if (!hasJsonObject(content)) {
    const choice = out?.payload?.choices?.[0] || {};
    const usage = out?.payload?.usage || {};
    compressTrace(`重试后仍不可用：finish=${choice.finish_reason}，${Array.from(content).length} 字，completion=${usage.completion_tokens ?? '?'}`);
    throw new Error(
      `模型回包不可用（finish=${choice.finish_reason || '?'}，${Array.from(content).length} 字，completion=${usage.completion_tokens ?? '?'}）`,
    );
  }
  return { payload: out.payload, content };
}

/**
 * 一条压缩对话里的一轮：同一档位的所有批次共用一条 messages 链。
 * 后续请求把前面的「批次 + 助手改稿」当前缀，DeepSeek 的自动前缀缓存就能吃上，
 * 命中率随批次推进升高（2026-10-28 用户问「串行放进一个对话有没有用」——有用，就这么做）。
 */
async function compressTurn(key, chain, userContent) {
  chain.push({ role: 'user', content: userContent });
  const out = await chatJson(key, {
    model: COMPRESS_MODEL,
    thinking: { type: 'disabled' },
    max_tokens: COMPRESS_MAX_TOKENS,
    messages: chain,
    response_format: { type: 'json_object' },
  });
  const usage = out.payload?.usage || {};
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? 0;
  const rate = hit + miss ? Math.round((hit / (hit + miss)) * 100) : 0;
  compressTrace(
    `缓存命中 ${hit} / 未命中 ${miss}（${rate}%），输出 ${Array.from(out.content).length} 字，completion=${usage.completion_tokens ?? '?'}，reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 0}`,
  );
  chain.push({ role: 'assistant', content: out.content });
  return out;
}

/** 一档一批：先要一次改稿；偏长就带着比例反馈，在同一条对话里再要一次。 */
async function compressBatch(key, chains, system, items, range) {
  const chain = chains.get(system) || [{ role: 'system', content: system }];
  chains.set(system, chain);
  const payload = (extra) =>
    JSON.stringify({ memories: items.map((it) => ({ file: it.file, keywords: it.keywords, body: it.body })) }) + (extra || '');
  const ratiosOf = (got) =>
    got.map((it) => {
      const src = items.find((x) => x.file === it.file);
      return {
        file: it.file,
        ratio: src ? Array.from(String(it.body || '')).length / Math.max(1, Array.from(src.body).length) : 1,
      };
    });

  let out = await compressTurn(key, chain, payload(''));
  let got = parseCompressItems(out.content);
  let ratios = ratiosOf(got);
  const tooLong = ratios.filter((r) => r.ratio > range.max + 0.02);
  if (tooLong.length) {
    compressTrace(`${range.label} 偏长（${tooLong.map((r) => `${r.file} ${(r.ratio * 100).toFixed(0)}%`).join('、')}），要求重压`);
    out = await compressTurn(
      key,
      chain,
      payload(
        `上一轮改稿占原文 ${tooLong.map((r) => `${(r.ratio * 100).toFixed(0)}%`).join('、')}，还是太长。这一轮必须压到原文的 ${Math.round(range.min * 100)}%–${Math.round(range.max * 100)}%，可执行内容照样一字不丢。`,
      ),
    );
    got = parseCompressItems(out.content);
    ratios = ratiosOf(got);
  }
  return got.map((it) => ({ ...it, ratio: ratios.find((r) => r.file === it.file)?.ratio ?? 1 }));
}

/**
 * 跑一次压缩：按档位分组送模型，写 proposed/ 等审批。
 * 只写 proposed/ 与 compress.json，绝不改正文或 MEMORY.md。
 */
async function runCompress(reason) {
  if (compressRunning) return { skipped: true, running: true };
  compressRunning = true;
  const startedAt = new Date().toISOString();
  writeJson(COMPRESS, { startedAt, stage: 'plan', reason, files: [], detail: '' });
  try {
    const plan = compressPlan();
    const pending = new Set(proposedFiles());
    const light = [];
    const heavy = [];
    const stale = [];
    for (const item of plan) {
      if (item.level === 'skip-high') continue;
      if (item.level === 'stale') {
        stale.push(item.file);
        continue;
      }
      if (pending.has(item.file)) continue; // 已经有待审改稿，别重复提
      if (Array.from(item.body || '').length < 120) continue;
      (item.level === 'light' ? light : heavy).push(item);
    }
    if (!light.length && !heavy.length) {
      writeJson(COMPRESS, {
        startedAt,
        finishedAt: new Date().toISOString(),
        stage: 'done',
        reason,
        files: [],
        detail: stale.length ? `${stale.length} 份报备待删除，没有要送的记忆` : '没有需要压缩的记忆',
      });
      return { files: [], stale };
    }
    const key = apiKey();
    if (!key) throw new Error('缺少 DSH_AUTOMATION_API_KEY，请在 ~/.dsh/automation.env 里配置');
    writeJson(COMPRESS, { startedAt, stage: 'request', reason, files: [], detail: `轻调整 ${light.length} 份、中删减 ${heavy.length} 份` });

    const items = [];
    const failures = [];
    // 同一档位共用一条对话（串行），让前缀缓存一轮比一轮吃得多。
    const chains = new Map();
    for (const [system, group, min, max, label] of [
      [COMPRESS_LIGHT_SYSTEM, light, KEEP_LIGHT, LIGHT_MAX, '轻调整'],
      [COMPRESS_HEAVY_SYSTEM, heavy, KEEP_HEAVY, HEAVY_MAX, '中删减'],
    ]) {
      for (let i = 0; i < group.length; i += COMPRESS_BATCH) {
        const chunk = group.slice(i, i + COMPRESS_BATCH);
        try {
          const got = await compressBatch(key, chains, system, chunk, { min, max, label });
          items.push(...got.map((it) => ({ ...it, min, max, original: chunk })));
        } catch (err) {
          // 一批失败不拖垮整次压缩：其余批次照常出方案，失败原因记进 detail 和日志。
          failures.push(`${label} ${chunk.map((it) => it.file).join('/')}：${String(err?.message || err).slice(0, 120)}`);
          compressTrace(`批次失败：${failures[failures.length - 1]}`);
        }
      }
    }

    fs.mkdirSync(PROPOSED, { recursive: true });
    const written = [];
    let unchanged = 0;
    let nearNoop = 0;
    let belowTarget = 0;
    for (const item of items) {
      const file = String(item?.file || '').trim();
      const body = String(item?.body || '').trim();
      const source = (item.original || []).find((x) => x.file === file);
      if (!source || !body) continue;
      // 只字未动的改稿不提审：批了也没变化，只会在面板上留一堆空方案。
      if (body === String(source.body || '').trim()) {
        unchanged += 1;
        continue;
      }
      const ratio = Array.from(body).length / Math.max(1, Array.from(source.body).length);
      if (ratio > NOOP_RATIO) {
        nearNoop += 1;
        continue;
      }
      // 目标比例是「尽量」，不是门槛：这些记忆写得很密，模型常常只能压到 95% 左右，
      // 硬卡区间会把所有改稿都扔掉（2026-10-28 实测）。只要真缩短了就先给人看，
      // 没达标的在 detail 里标出来。
      if (ratio < item.min - 0.05) continue; // 删过头就不要了
      if (ratio > item.max + 0.03) belowTarget += 1;
      fs.writeFileSync(path.join(PROPOSED, file), body, 'utf8');
      written.push(file);
      if (written.length >= 6) break;
    }
    // 全部批次都失败才算失败；有方案就先给人审批，失败原因挂在 detail 里。
    const allFailed = !items.length && failures.length > 0;
    writeJson(COMPRESS, {
      startedAt,
      finishedAt: new Date().toISOString(),
      stage: allFailed ? 'failed' : 'done',
      reason,
      files: written,
      detail: [
        `${written.length} 份改稿待审批${belowTarget ? `（${belowTarget} 份未达目标比例）` : ''}`,
        unchanged ? `${unchanged} 份原文未动已跳过` : '',
        nearNoop ? `${nearNoop} 份几乎未缩短已跳过` : '',
        stale.length ? `${stale.length} 份报备待删除` : '',
        failures.length ? `${failures.length} 批请求失败：${failures[0]}` : '',
      ]
        .filter(Boolean)
        .join('，'),
    });
    return { files: written, stale, failures };
  } catch (err) {
    writeJson(COMPRESS, {
      startedAt,
      finishedAt: new Date().toISOString(),
      stage: 'failed',
      reason,
      files: [],
      detail: String(err?.message || err).slice(0, 300),
    });
    throw err;
  } finally {
    compressRunning = false;
  }
}

/** 触发一次压缩（不阻塞调用方）。 */
function kickCompress(reason) {
  if (compressRunning) return;
  runCompress(reason).catch(() => {
    /* 失败原因已经写进 compress.json，这里不再抛 */
  });
}

/** 从会话事件里拼出最近的对话记录：只取人类消息与助手文本，子代理的不算。 */
function transcriptOf(session, maxChars = 12000) {
  const parts = [];
  let events = [];
  try {
    events = typeof session?.ownEvents === 'function' ? session.ownEvents() : [];
  } catch {
    events = [];
  }
  const textOf = (content) => {
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();
  };
  for (const event of events) {
    if (event?.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue;
      const text = textOf(event.data?.message?.content ?? event.data?.content);
      if (text) parts.push(`用户：${text}`);
    } else if (event?.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content);
      if (text) parts.push(`助手：${text}`);
    }
  }
  const joined = parts.join('\n\n');
  if (!joined) return '';
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/** 取一个可用的记忆名：模型给的名字撞了就加序号。 */
function freeName(raw) {
  const base = String(raw || 'project-memory')
    .trim()
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project-memory';
  if (!fs.existsSync(path.join(MEM, `${base}.md`))) return base;
  for (let i = 2; i < 50; i += 1) {
    const next = `${base}-${i}`;
    if (!fs.existsSync(path.join(MEM, `${next}.md`))) return next;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 让主 agent 用自身上下文做一次工具调用：同一条 deriveMessages() 前缀 + 一条隐藏指令，
 * 带 tools 走原生 function calling，返回它填好的工具参数（而不是自由文本里的 JSON）。
 */
async function askMainAgent(llm, session, prompt, tools) {
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
  const messages = [
    ...session.deriveMessages(),
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];
  const options = {
    ...(header && header.config ? header.config : {}),
    messages,
    reasoningEffort: 'low',
    tools,
    sessionId: session.id,
  };
  const calls = new Map(); // id → {name, args}，参数按 argumentsDelta 逐段拼回
  for await (const chunk of llm.stream(options)) {
    if (!chunk || chunk.type !== 'tool-call-delta') continue;
    const id = String(chunk.id || `call-${chunk.index ?? 0}`);
    const slot = calls.get(id) || { name: '', args: '' };
    if (typeof chunk.name === 'string' && chunk.name) slot.name = chunk.name;
    if (typeof chunk.argumentsDelta === 'string') slot.args += chunk.argumentsDelta;
    calls.set(id, slot);
  }
  return [...calls.values()];
}

/** 从工具调用里取 memory_write 的参数；没有可解析的调用就返回 null。 */
function writeCallOf(calls) {
  for (const call of calls) {
    if (call.name !== 'memory_write') continue;
    try {
      const parsed = JSON.parse(call.args);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 参数被截断或不是 JSON，试下一个调用 */
    }
  }
  return null;
}

/**
 * `/remember`：让**主 agent 用自己那份上下文**写一条「项目记忆」。
 *
 * 做法：借 DSH 的 llm 服务，把当前会话 deriveMessages() 出来的消息原样作为前缀，
 * 末尾追加一句隐藏指令，并把 `memory_write` 的工具声明一起递过去——模型填工具参数
 * 是协议层的结构化输出，天然是合法 JSON，不会出现「模型没有返回 JSON」。
 * 请求不经过会话、不往历史里写任何东西，因此与主 agent 共享同一份前缀缓存。
 * llm 服务不可用时，退回「插件自己发 HTTP + 只带转录 + 同一条工具声明」。
 */
async function rememberConversation(agent, hostCtx) {
  const session = agent?.session;
  const llm = typeof hostCtx?.get === 'function' ? hostCtx.get('llm') : undefined;
  let args = null;
  let llmError = null;
  const trace = (text) => {
    try {
      fs.mkdirSync(TIDY, { recursive: true });
      fs.appendFileSync(path.join(TIDY, 'remember.log'), `[${new Date().toISOString()}] ${text}\n`, 'utf8');
    } catch {
      /* 追踪写不进去不影响主流程 */
    }
  };

  if (llm && typeof llm.stream === 'function' && session && typeof session.deriveMessages === 'function') {
    for (const prompt of [REMEMBER_INSTRUCTION, REMEMBER_RETRY_INSTRUCTION]) {
      try {
        const calls = await askMainAgent(llm, session, prompt, [REMEMBER_TOOL]);
        const names = calls.map((c) => `${c.name || '?'}(${Array.from(c.args || '').length} 字)`).join('、') || '没有调用工具';
        trace(`主 agent 工具调用：${names}`);
        args = writeCallOf(calls);
        if (args) break;
      } catch (err) {
        llmError = err;
        logPluginError('/remember llm.stream', err);
        trace(`llm.stream 失败：${String(err?.message || err)}`);
        args = null;
        break;
      }
    }
  }

  if (!args) {
    const transcript = transcriptOf(session);
    if (!transcript.trim()) {
      throw new Error(llmError ? `主 agent 撰写失败（${String(llmError.message || llmError)}），且这段对话没有可记的内容` : '这段对话还没有可记的内容');
    }
    const key = apiKey();
    if (!key) throw new Error('缺少 DSH_AUTOMATION_API_KEY，请在 ~/.dsh/automation.env 里配置');
    // 兜底也走工具调用：tool_choice 直接点名，拿回 structured arguments。
    const fallback = await chatOnce(key, {
      model: COMPRESS_MODEL,
      thinking: { type: 'enabled', reasoning_effort: 'low' },
      tools: [
        {
          type: 'function',
          function: { name: REMEMBER_TOOL.name, description: REMEMBER_TOOL.description, parameters: REMEMBER_TOOL.parameters },
        },
      ],
      tool_choice: { type: 'function', function: { name: REMEMBER_TOOL.name } },
      messages: [
        { role: 'system', content: REMEMBER_SYSTEM },
        { role: 'user', content: transcript },
      ],
    });
    const call = fallback?.payload?.choices?.[0]?.message?.tool_calls?.[0];
    const rawArgs = String(call?.function?.arguments ?? '');
    trace(`兜底请求返回：${call ? `${call.function?.name}(${Array.from(rawArgs).length} 字)` : `没有工具调用，正文 ${Array.from(String(fallback?.content ?? '')).length} 字`}`);
    if (call) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = null;
      }
    }
  }

  if (!args) throw new Error('主 agent 没有调用 memory_write 工具（也没有可用的兜底结果）');
  const body = String(args?.body || '').trim();
  if (!body) throw new Error('工具参数里的 body 为空');
  const name = freeName(args?.name);
  const parts = String(args?.keywords || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts[0] !== MANUAL_CATEGORY) parts.unshift(MANUAL_CATEGORY);
  if (parts.length < 2) parts.push(name);
  const keywords = parts.slice(0, 6).join('/');
  const description = oneLine(args?.description) || `${name} 的项目记忆`;
  const file = createMemory({ name, keywords, description, body, type: 'reference' });
  // 「对话归纳」也进流水：它没有工具调用，所以没有 callId（详情里不提供轨迹定位）。
  appendCall({
    sessionId: agent?.session?.id || '',
    op: 'remember',
    target: name,
    keywords,
    type: 'reference',
    cat: MANUAL_CATEGORY,
    chars: Array.from(body).length,
    content: body,
    ok: true,
  });
  return { file, chars: Array.from(body).length };
}

/**
 * 解析 MEMORY.md 的索引表。列：文件 | 关键词 | 启用 | 类型 | 何时读 | 复核 | 受保护。
 * 关键词缺失时退回空串；表格之外的文本一律忽略。
 */
function readEntries() {
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
    const name = cells[0].replace(/`/g, '').trim();
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
    rows.push({
      file: name,
      keywords: (cells[1] || '').replace(/`/g, '').trim(),
      enabled: !/^否$/.test((cells[2] || '').trim()),
      type: (cells[3] || '').trim(),
      whenToRead: (cells[4] || '').trim(),
      reviewed: (cells[5] || '').trim(),
      protected: /^是$/.test((cells[6] || '').trim()),
      // 索引行还在、文件没了：面板要能认出来，删除要能清掉这条死行。
      missing: !fs.existsSync(path.join(MEM, name)),
      params: paramsOf(name),
    });
  }
  return rows;
}

/** 大纲里关键词的展示裁剪：只在 `/` 边界上剪，宁可少露一个关键词，也不切半截。 */
function clipKeywords(keywords, max = OUTLINE_KW_MAX) {
  const text = String(keywords || '').trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const kept = [];
  for (const part of text.split('/')) {
    if (kept.length && Array.from([...kept, part].join('/')).length > max) break;
    kept.push(part);
  }
  const line = kept.join('/');
  return line ? `${line}…` : `${chars.slice(0, max).join('')}…`;
}

/**
 * 真实注入给模型的大纲：按分类分组，每条「名称=关键词」，停用的记忆不出现。
 * 整行不做全局截断——预算压力由 `clipKeywords` 按条平摊，
 * 否则最后几条记忆会从大纲里整条消失（2026-10-27 实测 huashu-motion-install 就是这样丢的）。
 *
 * 2026-10-29 用户反馈「只是罗列、没有逻辑」：补一行用法说明，并按分类分组，
 * 关键词里省去重复的分类前缀（组名已经说明），教训永远排第一组。
 */
const OUTLINE_GROUPS = [
  ['教训', '犯错前的场景，动手前必看'],
  ['资料', '内容类型'],
  ['说明书', '工具/插件'],
  ['项目记忆', '项目与在手任务'],
  ['其它', ''],
  ['未分类', ''],
];

function outlineText(entries = readEntries()) {
  const live = entries.filter((e) => e.enabled && e.keywords);
  if (!live.length) return '';
  const headOf = (kw) => {
    const head = String(kw).split('/')[0].trim();
    return CATEGORIES.includes(head) ? head : '未分类';
  };
  const lines = [
    '记忆索引（每条「名称=关键词」；关键词写的是「以后什么场景该想起它」，要正文就 memory_read，传名称或关键词都行）',
  ];
  for (const [cat] of OUTLINE_GROUPS) {
    const rows = live
      .filter((e) => headOf(e.keywords) === cat)
      .map((e) => {
        const raw = String(e.keywords);
        const head = raw.split('/')[0].trim();
        const body = CATEGORIES.includes(head) ? raw.replace(/^[^/]+\//, '') : raw;
        // 组名已经写明了分类，关键词里省掉前缀；裁剪预算按「去前缀后的可用长度」算。
        const budget = Math.max(12, OUTLINE_KW_MAX - (CATEGORIES.includes(head) ? head.length + 1 : 0));
        return `${e.file.replace(/\.md$/, '')}=${clipKeywords(body, budget)}`;
      });
    if (rows.length) lines.push(`【${cat}】${rows.join(' · ')}`);
  }
  // 有教训就有前置检查：教训的关键词写的是「犯错前的场景」，读者必须在动手前对一遍。
  if (live.some((e) => /^教训\//.test(e.keywords))) {
    lines.push('动手前先过一遍【教训】：这次任务命中哪个场景，就先 memory_read 读完再开始，不要等报了错才回来找。');
  }
  return lines.join('\n');
}

/** 一处计算，两个消费者共用，避免两边判断不一致。 */
function snapshot() {
  const entries = readEntries();
  let st = null;
  try {
    // 别的工具（PowerShell 等）写这个文件常带 BOM，JSON.parse 会直接抛错，
    // 剥掉 BOM 和其他读取处保持一致的宽容度。
    st = JSON.parse(fs.readFileSync(STATUS, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    st = null;
  }
  const prop = readProposals();
  const age = st && st.lastRun ? daysSince(st.lastRun) : null;
  const count = prop.length;
  const pending = count > 0;
  // 待审批份数只认磁盘上的 proposed/*.md；status.json 里不再存 state/count，
  // 否则批准/忽略之后它必然和实际不一致（2026-10-27 实测就是这个坑）。
  const failed = (st?.result || st?.state) === 'failed';
  const state = pending ? 'pending' : failed ? 'failed' : 'ok';

  let files = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(MEM)) {
      if (!f.endsWith('.md')) continue;
      files += 1;
      bytes += fs.statSync(path.join(MEM, f)).size;
    }
  } catch {
    /* 仓库不可读时保持 0 */
  }

  let key = Boolean(process.env.DSH_AUTOMATION_API_KEY);
  if (!key) {
    try {
      key = /^\s*DSH_AUTOMATION_API_KEY\s*=\s*\S/m.test(fs.readFileSync(ENV_FILE, 'utf8'));
    } catch {
      key = false;
    }
  }

  // 回忆率与「待删除」都是可推导的统计量，不进索引表：索引只存人写的事实。
  const rates = recallRates();
  const windowSize = Math.min(WINDOW_TURNS, turnCount);
  for (const e of entries) {
    const hits = rates.get(e.file);
    e.recallRate = windowSize ? hits || 0 : null;
    const reviewedAge = daysSince(e.reviewed);
    // 待删除 = 窗口内一次没被回忆 + 复核日已过 STALE_DAYS；锁定的、被停用的不参与。
    e.pendingDelete = Boolean(windowSize && !hits && Number.isFinite(reviewedAge) && reviewedAge >= STALE_DAYS && e.enabled && !e.protected);
  }

  // 压缩流水线状态：compressed.json 只有 startedAt 没有 finishedAt 就是没跑完。
  const cst = readJson(COMPRESS, null);
  const cstart = cst?.startedAt ? Date.parse(cst.startedAt) : NaN;
  const unfinished = Boolean(cst?.startedAt) && !cst?.finishedAt;
  const running = unfinished && Number.isFinite(cstart) && Date.now() - cstart < COMPRESS_STALE_MS;

  return {
    state,
    count,
    detail: st?.detail || '',
    lastRun: st?.lastRun || '',
    ageDays: age,
    digest: prop.map((p) => p.file).slice(0, 5),
    proposal: { files: prop },
    files,
    bytes,
    keyConfigured: key,
    turns: turnCount,
    windowTurns: windowSize,
    compress: {
      running,
      interrupted: unfinished && !running,
      failed: cst?.stage === 'failed',
      startedAt: cst?.startedAt || '',
      finishedAt: cst?.finishedAt || '',
      stage: cst?.stage || '',
      reason: cst?.reason || '',
      files: Array.isArray(cst?.files) ? cst.files : [],
      detail: cst?.detail || '',
      every: COMPRESS_EVERY,
    },
    outline: outlineText(entries),
    entries,
  };
}

function statusLine() {
  try {
    const s = snapshot();
    // 失败提示只留一天：重跑成功后 compress.json 会被覆盖，否则别一直念旧账。
    const failedAt = Date.parse(s.compress?.finishedAt || '');
    if (s.compress?.failed && Number.isFinite(failedAt) && Date.now() - failedAt < 86_400_000) {
      return `记忆压缩 ▸ 上次失败（${String(s.compress.finishedAt || '').slice(5, 16).replace('T', ' ')}）：${String(s.compress.detail || '未知原因').slice(0, 80)}。`;
    }
    if (s.state === 'ok') return '';
    if (s.state === 'pending') return `记忆整理 ▸ ${s.count} 份方案待审批（设置 → 记忆管理）。`;
    if (s.state === 'failed') return `记忆整理 ▸ 上次失败：${s.detail || '未知原因'}（${String(s.lastRun).slice(0, 16).replace('T', ' ')}）。`;
    return '';
  } catch {
    return '';
  }
}

function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 只改索引表里那一行的关键词单元格，保留其余文本与换行风格。 */
function setKeywords(file, keywords) {
  const entry = readEntries().find((e) => e.file === file);
  if (entry?.protected) throw new Error('这份记忆已锁定，不能修改关键词');
  return updateCell(file, 2, `${String(keywords)
    .replace(/[|\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)}`);
}

/** 改「启用」单元格：开=是，关=否。只控制是否披露，不算改原文或关键词。 */
function setEnabled(file, enabled) {
  return updateCell(file, 3, enabled ? '是' : '否');
}

/** 改「锁定」单元格：是=用户锁定，既不审查也不改原文和关键词。 */
function setProtected(file, protectedNow) {
  return updateCell(file, 7, protectedNow ? '是' : '否');
}

function updateCell(file, cellIndex, value) {
  if (!/^[\w.-]+\.md$/.test(file) || file === 'MEMORY.md') throw new Error('文件名非法');
  const p = path.join(MEM, 'MEMORY.md');
  const text = fs.readFileSync(p, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((line) => {
    if (!line.trim().startsWith('|')) return false;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    return (cells[0] || '').replace(/`/g, '').trim() === file;
  });
  if (idx < 0) throw new Error('索引表里没有这个文件');
  const cells = lines[idx].split('|');
  cells[cellIndex] = ` ${value} `;
  lines[idx] = cells.join('|');
  if (!lines[idx].endsWith('|')) lines[idx] += '|';
  fs.writeFileSync(p, lines.join(eol), 'utf8');
  return value;
}

/** 在资源管理器里选中该记忆文件。 */
function revealFile(file) {
  if (!/^[\w.-]+\.md$/.test(file) || file === 'MEMORY.md') throw new Error('文件名非法');
  const abs = path.join(MEM, file);
  if (!abs.startsWith(`${MEM}${path.sep}`)) throw new Error('越界路径');
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  spawn('explorer.exe', [`/select,${abs}`], { detached: true, stdio: 'ignore' }).unref();
  return abs;
}

export function apply(ctx) {
  // 轮计数：人类每发一条消息算一轮（用户口径：按一次回车算一轮）。
  // 用 session/event 的 user/message，而不是 agent/turn-stopping：
  // 后者带 agent 载体、按 agent 作用域派发，插件上下文收不到（2026-10-28 实测：turns.json 一直是空的）。
  // source.kind === 'user' 只认人类输入，子代理的提示与 goal 自动续轮都不计。
  loadTurnCount();
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          if (!event || event.type !== 'user/message') return;
          const source = event.data?.source;
          if (source?.kind !== 'user') return;
          bumpTurn();
          // 每 100 轮跑一次压缩判定（不阻塞对话）。
          if (turnCount % COMPRESS_EVERY === 0) kickCompress('auto');
        } catch {
          /* 计数失败不影响对话 */
        }
      }),
    'memory turn counter',
  );

  // 真实注入的大纲：文件名 + 关键词，取自 MEMORY.md，改文件即改上下文。
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'memory:outline', order: 9890, text: () => outlineText() }),
    'memory outline',
  );
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'memory:tidy-status', order: 9900, text: statusLine }),
    'memory tidy status',
  );

  // 记忆只通过插件工具交付：先看大纲关键词，再用 memory_read 取原文。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'memory_read',
          description: [
            '读取一份记忆的正文。上下文里有一行「记忆 ▸ 名称=关键词」，先在那一行里挑和当前任务对得上的名称或关键词，再用本工具取原文。',
            '「教训/」开头的条目是**动手前**必查的：只要它的场景落进你这次要做的事，先读它、再动手；不要等报了错才回来找。',
            '不要用 read / grep / glob / 命令行去翻记忆仓库：插件会拒绝，而且那样更慢。',
            'file 传大纲里的名称（如 user-profile），也可以传一个关键词（如 身份）。',
          ].join(' '),
          parameters: {
            type: 'object',
            properties: {
              file: {
                type: 'string',
                description: '大纲里的记忆名称（可带或不带 .md），或一个关键词。',
              },
            },
            required: ['file'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            render(_args, value) {
              return [{ type: 'text', text: String(value?.text ?? '') }];
            },
          },
          execute(args) {
            const query = String(args?.file || '').trim();
            if (!query) throw new Error('需要 file：取大纲里的记忆名称或关键词');
            const entry = resolveEntry(query);
            if (!entry) {
              const names = readEntries()
                .filter((e) => e.enabled)
                .map((e) => e.file.replace(/\.md$/i, ''))
                .join('、');
              throw new Error(`没有找到记忆「${query}」。可用的有：${names || '（无）'}`);
            }
            const body = readMemoryBody(entry.file);
            const name = entry.file.replace(/\.md$/i, '');
            recordRecall(entry.file); // 回忆率就靠这一行统计，读完才记
            return { text: `【记忆：${name}】\n\n${body}` };
          },
        }),
      'memory read tool',
    );

    // 一次调用写一条记忆：插件负责建文件、补索引、查重、报字数。
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'memory_write',
          description: WRITE_TOOL_DESCRIPTION,
          parameters: WRITE_TOOL_PARAMETERS,
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            render(_args, value) {
              return [{ type: 'text', text: String(value?.text ?? '') }];
            },
          },
          execute(args) {
            const name = assertName(args?.name);
            const file = `${name}.md`;
            if (fs.existsSync(path.join(MEM, file))) {
              throw new Error(`记忆 ${file} 已经存在；要改内容请用 memory_update`);
            }
            const keywords = oneLine(args?.keywords, 80);
            const description = oneLine(args?.description);
            const type = oneLine(args?.type, 24) || 'reference';
            const body = String(args?.body || '').trim();
            if (!keywords) throw new Error('keywords 不能为空，否则大纲里点不到它');
            // 「项目记忆」只由 /remember 或设置页新建产生，模型通道一律拒绝。
            assertCategory(keywords);
            if (!description) throw new Error('description 不能为空，一句话说清什么时候读');
            if (!body) throw new Error('body 不能为空');
            const attrs = [`name: ${name}`, `description: ${description}`, `type: ${type}`, `reviewed: ${today()}`];
            const target = path.join(MEM, file);
            fs.writeFileSync(target, joinDoc(attrs, body), 'utf8');
            try {
              addIndexRow({ file, keywords, type, hint: description });
            } catch (err) {
              // 索引补不上就把文件撤回：否则留下孤儿文件，下次同名写入会被挡住
              try {
                fs.unlinkSync(target);
              } catch {
                /* 撤回失败也把原始错误抛出去 */
              }
              throw new Error(`索引写入失败，已撤回文件：${err.message}`);
            }
            return {
              text: `已记下：${file}\n关键词：${keywords}${lengthNote(file, body)}`,
            };
          },
        }),
      'memory write tool',
    );

    // 订正一条已有记忆；锁定的不许改。
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'memory_update',
          description: [
            '发现某条记忆过时、有误或不全时，顺手订正它。只传要改的字段，其余保持原样。',
            '换关键词时第一个关键词仍是分类：资料 / 教训 / 说明书 / 其它（项目记忆 只能由用户点「大脑」生成）。',
            '关键词口径和新建一致：资料写内容类型、教训写犯错前的场景/任务、说明书写工具名；不要写 400 / 422 这类事后症状名。',
            '锁定的记忆会被拒绝，需要用户先在设置页解锁。',
          ].join(' '),
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要改的记忆名称（大纲里的名称，可带或不带 .md）。' },
              keywords: { type: 'string', description: '可选：新的关键词，用 / 分隔，第一个必须是分类。' },
              description: { type: 'string', description: '可选：新的一句话描述。' },
              body: { type: 'string', description: '可选：新的正文，整段替换。' },
              type: { type: 'string', description: '可选：新的类型。' },
            },
            required: ['name'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            render(_args, value) {
              return [{ type: 'text', text: String(value?.text ?? '') }];
            },
          },
          execute(args) {
            const name = assertName(args?.name);
            const file = `${name}.md`;
            const entry = readEntries().find((e) => e.file === file);
            if (!entry) throw new Error(`没有记忆 ${file}`);
            if (entry.protected) throw new Error(`记忆 ${file} 已锁定，不能改；需要用户先在设置页解锁`);
            const doc = splitDoc(fs.readFileSync(path.join(MEM, file), 'utf8'));
            const attrs = doc.attrs;
            if (args?.description) setAttr(attrs, 'description', oneLine(args.description));
            if (args?.type) setAttr(attrs, 'type', oneLine(args.type, 24));
            setAttr(attrs, 'reviewed', today());
            const body = args?.body ? String(args.body).trim() : doc.body;
            if (!body) throw new Error('body 不能为空');
            fs.writeFileSync(path.join(MEM, file), joinDoc(attrs, body), 'utf8');
            if (args?.keywords) {
              const nextKeywords = oneLine(args.keywords, 80);
              assertCategory(nextKeywords); // 换关键词也要守住分类
              updateCell(file, 2, nextKeywords);
            }
            if (args?.type) updateCell(file, 4, oneLine(args.type, 24));
            if (args?.description) updateCell(file, 5, oneLine(args.description));
            updateCell(file, 6, today());
            return {
              text: `已订正：${file}${lengthNote(file, body)}`,
            };
          },
        }),
      'memory update tool',
    );

    // 删除一条记忆；锁定的不许删。
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'memory_delete',
          description: [
            '删除一条确实没用了的记忆，同时删掉索引行。删除前确认没有别的记忆在引用它。',
            '锁定的记忆会被拒绝，需要用户先在设置页解锁。',
          ].join(' '),
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要删的记忆名称（大纲里的名称，可带或不带 .md）。' },
            },
            required: ['name'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            render(_args, value) {
              return [{ type: 'text', text: String(value?.text ?? '') }];
            },
          },
          execute(args) {
            const name = assertName(args?.name);
            const file = `${name}.md`;
            const entry = readEntries().find((e) => e.file === file);
            if (!entry) throw new Error(`没有记忆 ${file}`);
            if (entry.protected) throw new Error(`记忆 ${file} 已锁定，不能删；需要用户先在设置页解锁`);
            const target = path.join(MEM, file);
            const ghost = !fs.existsSync(target);
            const indexText = fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8');
            if (!ghost) fs.unlinkSync(target);
            try {
              removeIndexRow(file);
            } catch (err) {
              try {
                fs.writeFileSync(path.join(MEM, 'MEMORY.md'), indexText, 'utf8');
              } catch {
                /* 还原失败也把原始错误抛出去 */
              }
              throw new Error(`索引行删除失败，已尝试还原索引：${err.message}`);
            }
            return {
              text: `${ghost ? '已清掉索引死行（文件本来就不在了）：' : '已删除：'}${file}`,
            };
          },
        }),
      'memory delete tool',
    );

    // 记忆正文一律走 memory_read；直接在仓库里翻正文会被拒绝。
    // 索引 MEMORY.md 和 .tidy 下的状态/方案不是正文，放行——否则调 status.json 都得绕开工具。
    toolCtx.on('tools/pre-execute', async (exec, next) => {
      try {
        const args = exec?.arguments || {};
        const raw = args.file_path || args.path;
        const kind = raw ? memoryKind(raw) : 'outside';
        if (exec.name === 'read' && kind === 'body') {
          return {
            kind: 'deny',
            reason: '记忆正文要用 memory_read 工具读：先在大纲里挑名称或关键词，再调用它，不要直接翻仓库文件。',
          };
        }
        // grep / glob 搜仓库根或正文，等于批量跳过 memory_read。
        if ((exec.name === 'grep' || exec.name === 'glob') && (kind === 'root' || kind === 'body')) {
          return {
            kind: 'deny',
            reason: '不要搜索记忆仓库目录；改用 memory_read，按大纲里的名称或关键词取正文。',
          };
        }
        // 删除前留一份正文与元数据：删完文件就没了，详情里要显示真正被删掉的内容。
        if (exec.name === 'memory_delete' && exec.callId) {
          const name = String(args.name || '').trim().replace(/\.md$/i, '');
          const entry = readEntries().find((e) => e.file === `${name}.md`);
          if (entry) {
            DELETED_BODIES.set(exec.callId, {
              body: readMemoryBody(entry.file) || '',
              keywords: entry.keywords,
              type: entry.type,
            });
          }
        }
      } catch {
        /* 判定失败就放行 */
      }
      return next();
    });

    toolCtx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        // 记忆调用流水：供「记忆」视图展示模型读过/写过哪些记忆（不改会话、不影响模型）。
        if (/^memory_(read|write|update|delete)$/.test(exec?.name || '') && decision && decision.kind === 'accept') {
          recordMemoryCall(exec);
        }
        if (exec.name !== 'write' && exec.name !== 'edit') return decision;
        if (!decision || decision.kind !== 'accept' || decision.value !== undefined) return decision;
        const abs = memoryTargetOf(exec);
        if (!abs) return decision;
        const { body, length } = bodyLength(fs.readFileSync(abs, 'utf8'));
        if (length <= MEM_LIMIT) return decision;
        const block = { type: 'text', text: oversizeWarning(path.basename(abs), length) };
        return { ...decision, content: [...(decision.content || result.content || []), block] };
      } catch {
        return decision;
      }
    });
  });

  // 设置页用的接口。webServer 晚于本插件就绪，用 inject 等待。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = [
        webCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: (req, res) => {
            // 客户端心跳：设置页模块 apply 时带 client=1 请求一次，落一个时间戳。
            if (String(req.url || '').includes('client=1')) {
              try {
                fs.writeFileSync(path.join(TIDY, 'client-alive.txt'), new Date().toISOString(), 'utf8');
              } catch {
                /* 心跳失败不影响状态返回 */
              }
            }
            sendJson(res, 200, snapshot());
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: KEYWORD_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              const saved = setKeywords(String(body.file || ''), String(body.keywords || ''));
              sendJson(res, 200, { ...snapshot(), saved });
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: OPEN_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              const abs = revealFile(String(body.file || ''));
              // 和其它写操作一样回快照：客户端会把回包直接当成新状态，
              // 只回 {opened} 会让它把 entries 丢掉、整页卡片消失（2026-10-28 实测）。
              sendJson(res, 200, { ...snapshot(), opened: abs });
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: APPROVE_FILE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              approveFile(String(body.file || ''));
              sendJson(res, 200, snapshot());
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: REJECT_FILE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              rejectFile(String(body.file || ''));
              sendJson(res, 200, snapshot());
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: TOGGLE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              setEnabled(String(body.file || ''), Boolean(body.enabled));
              sendJson(res, 200, snapshot());
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: PROTECT_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              setProtected(String(body.file || ''), Boolean(body.protected));
              sendJson(res, 200, snapshot());
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: CREATE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              const created = createMemory(body);
              sendJson(res, 200, { ...snapshot(), created });
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: DELETE_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              const deleted = deleteMemory(String(body.file || ''));
              sendJson(res, 200, { ...snapshot(), deleted });
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: SEARCH_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              sendJson(res, 200, searchMemories(String(body.q || '')));
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        // 「记忆」视图：按会话列出最近读/写/改/删了哪些记忆（只读流水，不进上下文）。
        // 列表只回轻量字段，正文单独走 /dsh-memory/call?id= 取，免得每 3 秒把几万字拖一遍。
        webCtx.webServer.register({
          kind: 'exact',
          path: CALLS_ROUTE,
          handler: (req, res) => {
            try {
              const url = new URL(String(req.url || ''), 'http://localhost');
              const sessionId = url.searchParams.get('sessionId') || '';
              const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
              const all = readJson(CALLS, []);
              const rows = (Array.isArray(all) ? all : []).filter((e) => e && (!sessionId || e.sessionId === sessionId));
              // 时间正序：老的在上面、新的在下面，符合从上往下读的习惯。
              const calls = rows.slice(-limit).map(({ content, ...rest }) => rest);
              sendJson(res, 200, { calls, sessionId, total: rows.length });
            } catch (err) {
              sendJson(res, 400, { error: String(err?.message || err) });
            }
          },
        }),
        // 单条详情：正文（真正注入/写入/删除的内容）单独取。
        webCtx.webServer.register({
          kind: 'exact',
          path: CALL_ROUTE,
          handler: (req, res) => {
            try {
              const url = new URL(String(req.url || ''), 'http://localhost');
              const id = url.searchParams.get('id') || '';
              const all = readJson(CALLS, []);
              const found = (Array.isArray(all) ? all : []).find(
                (e) => e && (e.id === id || e.callId === id || e.ts === id),
              );
              if (!found) return sendJson(res, 404, { error: '没有这条记录' });
              sendJson(res, 200, { call: found });
            } catch (err) {
              sendJson(res, 400, { error: String(err?.message || err) });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: COMPRESS_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            if (compressRunning) return sendJson(res, 409, { error: '上一次压缩还在跑' });
            try {
              kickCompress('manual');
              sendJson(res, 200, { started: true, ...snapshot() });
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        // /remember 的后台实现：客户端 action 只负责发这一条请求，状态也只在输入框下方显示。
        // 不产生 command 事件、不写会话历史，模型调用由插件自己写请求头完成。
        webCtx.webServer.register({
          kind: 'exact',
          path: REMEMBER_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            const startedAt = Date.now();
            const trace = (text) => {
              try {
                fs.mkdirSync(TIDY, { recursive: true });
                fs.appendFileSync(path.join(TIDY, 'remember.log'), `[${new Date().toISOString()}] ${text}\n`, 'utf8');
              } catch {
                /* 追踪写不进去不影响主流程 */
              }
            };
            try {
              const body = JSON.parse(await readBody(req));
              const sessionId = String(body.sessionId || '');
              trace(`收到请求 sessionId=${sessionId || '(空)'}`);
              if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' });
              // 解析会话：先按 id 查，再按 session.id 比对，最后落到唯一的根 agent。
              // （只按 id 查过一次，实测会 404，因为客户端给的 id 与注册表的键不一定同一个形态。）
              const agents = resolveAgents(ctx);
              let agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
              if (!agent && typeof agents?.list === 'function') {
                const live = agents.list();
                agent = live.find((a) => a?.session?.id === sessionId);
                if (!agent && live.length === 1) agent = live[0];
              }
              if (!agent && typeof agents?.roots === 'function') {
                const roots = agents.roots();
                if (roots.length === 1) agent = roots[0];
              }
              if (!agent) {
                const live = typeof agents?.list === 'function' ? agents.list().length : -1;
                trace(`找不到会话（liveAgents=${live}，agents 服务${agents ? '在' : '不在'}）`);
                return sendJson(res, 404, {
                  error: `找不到这个会话的 Agent（会话可能已关闭）`,
                  sessionId,
                  liveAgents: live,
                });
              }
              trace(`命中会话 ${agent?.session?.id || '(无 id)'}，开始撰写`);
              const { file, chars } = await rememberConversation(agent, ctx);
              trace(`完成 ${file} ${chars} 字，用时 ${Date.now() - startedAt}ms`);
              sendJson(res, 200, { ok: true, file, chars, turns: turnCount, sessionId: agent?.session?.id || '' });
            } catch (err) {
              trace(`失败：${String(err?.message || err)}`);
              logPluginError('/remember', err);
              sendJson(res, 400, { error: String(err?.message || err) });
            }
          },
        }),
        // 客户端状态条挂载探针：哪个槽位真的渲染了，就看这个日志（排查用，开销极低）。
        webCtx.webServer.register({
          kind: 'exact',
          path: DOCK_PING_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              fs.mkdirSync(TIDY, { recursive: true });
              fs.appendFileSync(
                path.join(TIDY, 'dock.log'),
                `[${new Date().toISOString()}] mount ${String(body.slot || '?')} session=${String(body.sessionId || '?')}\n`,
                'utf8',
              );
              sendJson(res, 200, { ok: true });
            } catch (err) {
              sendJson(res, 400, { error: String(err?.message || err) });
            }
          },
        }),
      ];
      return () => disposers.forEach((d) => d());
    }, 'memory routes');
  });
}
