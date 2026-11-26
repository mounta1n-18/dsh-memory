/**
 * 记忆整理状态（Host half）。
 *
 * 给模型一行中立的状态提示：有提案、上次失败、长期没跑。
 * 只读文件、无模型调用、不注册界面；任何异常都吞掉，保证不影响宿主启动。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { buildIndex, embedTexts, readIndex, resolveEmbedConfig, writeIndex } from './indexer.js';
import { MEMORY_BODY_MAX } from './store.js';

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
const LINKS = path.join(TIDY, 'links.json'); // 记忆之间的关系边：{ "a.md": { "b.md": { w, ts, why } } }
const LINK_LIMIT = 4; // 读一条记忆时最多顺带提示几条相关记忆
const TURNS = path.join(TIDY, 'turns.json'); // 全局用户轮计数 {count}
const WINDOW_TURNS = 100; // 回忆率的统计窗口 = 最近 100 个用户轮
// 删除判决的观察期：一条记忆要先被看见这么多轮，才有资格被判「零回忆垃圾」。
// 默认等于统计窗口；自检里用环境变量调小（否则要真跑 100 轮才测得到）。
const JUDGE_TURNS = Math.max(1, Number(process.env.MEMORY_JUDGE_TURNS) || WINDOW_TURNS);
const COMPRESS_EVERY = 100; // 每 100 轮触发一次压缩判定
const HIGH_FREQ = 11; // 窗口内 >=11 次 = 高频，不送压缩
// 记忆越多，删得越狠（2026-11-15 用户口径）：总量按对数增长，条目越多、淘汰线越紧。
const PRUNE_DAYS_MAX = 45; // 条目很少时给足观察期
const PRUNE_DAYS_MIN = 10; // 条目很多时收紧到 10 天
const PRUNE_BASE = 8; // 8 条以内：被读过 1 次就算活
// 项目记忆的来源会话：头部只记 session 号，整场对话另存到 .sources（不进索引、不进大纲、默认不进上下文）。
const SOURCES = path.join(MEM, '.sources');
const SESSIONS_ROOT = path.join(HOME, 'sessions');

/**
 * 记忆总量管控（2026-11-18 用户口径）：被控量 = 记忆条目总数，目标 50 条。
 * PID 输出 u ∈ [-1,1]（正 = 太少、该放开来记；负 = 太多、该收），映射成六套口径之一。
 * 对模型是黑箱：它只看到措辞不同的一句话，看不到计数、档位、PID。
 */
const MEM_TARGET = 50; // 理想总量：10 条以下寥寥无几，100 条以上太多
const PID_KP = 0.8; // 小一点：别让一次波动就把口径甩到另一档
const PID_KI = 0.05; // 慢速累积，纠长期偏差
const PID_KD = 1.5; // 大一点：条目数骤变（合并/批量删）时立刻反应
const PID_INTEGRAL_MAX = 0.6; // 抗积分饱和
const PID_FILE = path.join(TIDY, 'pid.json'); // {turn, integral, prevErr, u, tier, total}
const CONTROL_FILE = path.join(TIDY, 'control.json'); // {mode:'auto'|'manual', tier:1..6}
const SEEN_FILE = path.join(TIDY, 'seen.json'); // {名称: 首次见到的轮次}——判「待删除」要先看够 100 轮

function clampNum(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** u → 1..6：u=+1 最宽松（第 1 套），u=0 偏中（第 4 套），u=-1 最严格（第 6 套）。 */
function tierOf(u) {
  return clampNum(Math.round(3.5 - 2.5 * (Number(u) || 0)), 1, 6);
}

/** 六套口径：模型只看到其中一句，看不到这是档位。1 = 最鼓励新建，6 = 最鼓励合并/删除。 */
const TIER_LINES = [
  '记的时候大方点：碰到新主题直接开一条，别硬塞进旧条目里。',
  '新主题优先开一条；跟旧条目只是沾边，就别合并。',
  '先看看现成的：能靠改一条旧记忆说清楚，就别开新条目。',
  '优先改写：读到的旧条目已经在讲这件事，就改它，别开新的。',
  '少一条胜过多一条：同一件事只留一条，沾边的并进去。',
  '记忆已经很挤：除非旧条目完全不沾边，一律改写或并入，能删就删。',
];
const TIER_PRUNE_SCALE = [1.5, 1.25, 1, 0.85, 0.7, 0.6]; // 淘汰窗口（天）倍数：越严格越短
const TIER_HITS_ADD = [0, 0, 0, 1, 1, 2]; // 淘汰所需回忆次数加码

/**
 * 读 PID 状态；同一轮内重复调用直接返回上次的 u（面板每 3 秒轮询一次 snapshot，
 * 不能让一次读取就推进积分项）。只有跨轮才更新、才落盘。
 */
function pidState(total) {
  const n = Math.max(0, Number(total) || 0);
  const err = (MEM_TARGET - n) / MEM_TARGET; // 正 = 太少
  const st = readJson(PID_FILE, null);
  const integralPrev = Number.isFinite(st?.integral) ? st.integral : 0;
  const prevErr = Number.isFinite(st?.prevErr) ? st.prevErr : err;
  const uPrev = Number.isFinite(st?.u) ? st.u : clampNum(PID_KP * err, -1, 1);
  const lastTurn = Number.isFinite(st?.turn) ? st.turn : null;
  if (lastTurn !== null && turnCount <= lastTurn) {
    return { u: uPrev, tier: tierOf(uPrev), err, integral: integralPrev };
  }
  const dt = lastTurn === null ? 1 : Math.max(1, turnCount - lastTurn);
  const integral = clampNum(integralPrev + PID_KI * err * dt, -PID_INTEGRAL_MAX, PID_INTEGRAL_MAX);
  const derivative = (err - prevErr) / dt;
  const u = clampNum(PID_KP * err + integral + PID_KD * derivative, -1, 1);
  const tier = tierOf(u);
  writeJson(PID_FILE, { turn: turnCount, integral, prevErr: err, u, tier, total: n });
  return { u, tier, err, integral };
}

/** 控制模式：auto = PID 推档；manual = 用户手选档位。缺省 auto。 */
function readControl() {
  const raw = readJson(CONTROL_FILE, null);
  const mode = raw?.mode === 'manual' ? 'manual' : 'auto';
  const tier = clampNum(Math.round(Number(raw?.tier) || 3), 1, 6);
  return { mode, tier };
}

function writeControl(patch) {
  const cur = readControl();
  const asked = patch?.mode;
  if (asked !== undefined && asked !== 'auto' && asked !== 'manual') {
    throw new Error('mode 只能是 auto（PID 自动推挡）或 manual（手动锁档）');
  }
  const mode = asked === 'manual' ? 'manual' : asked === 'auto' ? 'auto' : cur.mode;
  const rawTier = Number(patch?.tier);
  const tier = Number.isFinite(rawTier) ? clampNum(Math.round(rawTier), 1, 6) : cur.tier;
  const next = { mode, tier };
  writeJson(CONTROL_FILE, next);
  return next;
}

/** 只有 PID 算出来的档（手动模式下照样要算，切回自动才能接着用）。 */
function autoTier(total = readEntries().length) {
  return pidState(total).tier;
}

/**
 * 当前该用第几套口径：手动模式用用户选的档，自动模式用 PID。
 * 手动模式也调一次 pidState——积分与导数照常按轮推进、照常落盘，
 * 面板只是不显示 PID 卡片；切回自动时是「一直没停」，不是从头再来。
 */
function currentTier(total = readEntries().length) {
  const ctl = readControl();
  const auto = pidState(total);
  return ctl.mode === 'manual' ? ctl.tier : auto.tier;
}

/** N 条时的淘汰窗口（天）：45 → 10，随条目数按 log2 递减，再按当前口径缩放。 */
function pruneDays(total, tier = currentTier(total)) {
  const n = Math.max(1, Number(total) || 1);
  const days = PRUNE_DAYS_MAX / (1 + Math.log2(Math.max(1, n / PRUNE_BASE)));
  const scale = TIER_PRUNE_SCALE[clampNum(tier, 1, 6) - 1];
  return Math.max(7, Math.min(60, Math.round(days * scale)));
}

/** N 条时「不算白记」的最低回忆次数：8 条以内 1 次，之后每翻一倍加 1，再按口径加码。 */
function pruneMinHits(total, tier = currentTier(total)) {
  const n = Math.max(1, Number(total) || 1);
  const base = 1 + Math.round(Math.log2(Math.max(1, n / PRUNE_BASE)));
  return Math.max(1, base + TIER_HITS_ADD[clampNum(tier, 1, 6) - 1]);
}
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
const COMPRESS_MAX_TOKENS = 8192; // 下限；不给足预算，几份改稿会写到一半被截断
const COMPRESS_MAX_TOKENS_CAP = 65536; // 官方 max output 384K，这里留足余量
const COMPRESS_TOKENS_PER_CHAR = 1.6; // 中文 1 字约 0.6 token，反向按 1.6 保守估，宁多不少

/**
 * 按本批正文总量算输出预算：改稿比原文短，1.6 倍 + 1024 足够。
 * 2026-11-18 实测：一次 4 份的批次输出 7378 字，紧贴旧的 8192 上限，
 * 截断后 JSON 只剩半截，报成「模型输出里没有 JSON 对象」——加满预算比加校验有用。
 */
function compressMaxTokens(chars) {
  const budget = Math.round((Number(chars) || 0) * COMPRESS_TOKENS_PER_CHAR) + 1024;
  return Math.min(COMPRESS_MAX_TOKENS_CAP, Math.max(COMPRESS_MAX_TOKENS, budget));
}

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
const KEEP_ROUTE = '/dsh-memory/keep';
const CONTROL_ROUTE = '/dsh-memory/control'; // 手动 / 自动切换（手动 = 自选档位）
const PROMPTS_ROUTE = '/dsh-memory/prompts'; // 只读：把模型能看到的提示词原文全部交出来
const CREATE_ROUTE = '/dsh-memory/create';
const DELETE_ROUTE = '/dsh-memory/delete';
const SEARCH_ROUTE = '/dsh-memory/search';
const REINDEX_ROUTE = '/dsh-memory/reindex'; // 2.0：重建章节级向量索引（增量）
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
/** 「动手前提醒」上次出现在哪一轮：同一轮只提醒一次。 */
let lastRemindTurn = -1;

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

/**
 * 整体召回率：单条百分比永远很低（一条记忆在一次任务里读完就够了），
 * 看单个数字会误判成「机制坏了」。这里给三个更有意义的量：
 * - anyRate：窗口内有任何回忆的轮次占比（这一轮到底有没有想起记忆）
 * - lessonRate：同一口径，只算读了【教训】的轮次（预防性回忆有没有发生）
 * - covered：窗口内被读过的记忆条数 / 启用总数（覆盖面）
 */
function recallOverview() {
  const size = Math.min(WINDOW_TURNS, turnCount);
  if (!size) return null;
  const fromTurn = turnCount - size + 1;
  const entries = readEntries();
  const lessonFiles = new Set(entries.filter((e) => /^教训\//.test(e.keywords || '')).map((e) => e.file));
  const live = entries.filter((e) => e.enabled);
  const anyTurns = new Set();
  const lessonTurns = new Set();
  const files = new Set();
  const events = readJson(RECALL, []);
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev.turn !== 'number' || ev.turn < fromTurn || ev.turn > turnCount) continue;
    anyTurns.add(ev.turn);
    files.add(ev.file);
    if (lessonFiles.has(ev.file)) lessonTurns.add(ev.turn);
  }
  return {
    window: size,
    anyTurns: anyTurns.size,
    anyRate: Math.round((anyTurns.size / size) * 100),
    lessonTurns: lessonTurns.size,
    lessonRate: lessonFiles.size ? Math.round((lessonTurns.size / size) * 100) : null,
    covered: files.size,
    total: live.length,
  };
}

/**
 * 「动手前提醒」：把【教训】钩子压成一行，在模型真要写文件 / 跑命令 / 装删的那一刻递到眼前。
 * 索引常驻归常驻，模型动手时经常不回头看；这条提醒是「场景触发」而不是「等待自觉」。
 * 每轮最多一次，且该轮已经读过教训就不再打扰。
 */
const REMIND_TOOLS = new Set(['write', 'edit', 'pwsh', 'computer_use', 'memory_delete', 'memory_update']);

// 拦截话术集中在这里：既给 pre-execute 用，也给 /dsh-memory/prompts 抄录，改一处就够。
const MEMORY_DIR_DENY_TEXT = '记忆正文要用 memory_read 工具读：先在大纲里挑名称或关键词，再调用它，不要直接翻仓库文件。';
const MEMORY_DIR_GREP_DENY_TEXT = '不要搜索记忆仓库目录；改用 memory_read，按大纲里的名称或关键词取正文。';

function lessonEntries() {
  try {
    return readEntries().filter((e) => e.enabled && /^教训\//.test(e.keywords || ''));
  } catch {
    return [];
  }
}

/**
 * 动手前提醒里那串「名称=关键词」。
 *
 * 2026-11-25 的现场：`plugin-release-versioning`（教训/更新作品/推仓库/版本管理）当天新建，
 * 是老顺序里的第 21 条，`max = 8` 直接把它截掉，于是推 GitHub 时提醒里根本没有它。
 * 「只给前 8 条」等于把最新、最贴近当下任务的那些教训藏起来——所以改成：
 * ① 先按「跟这次动作的字面重合」排序（命令里出现 `push` 就浮出「推仓库」这类钩子）；
 * ② 再补上其余条目，整体上限 24 条、每段最多保留 2 个关键词段，避免提醒本身变成噪音。
 */
/**
 * 动作 ↔ 关键词的对齐表：中文钩子对不上英文命令（`推仓库` 遇上 `git push` 永远匹配不上），
 * 所以命令里出现哪些英文动词，就把对应语义的钩子加权。规则很少，改这里就够。
 */
const HINT_ALIASES = [
  { when: /\b(push|release|tag|publish)\b/, segs: /推仓库|发版|版本|release|发版/i },
  { when: /\b(remove-item|rmdir|del|rm|clean|uninstall)\b/, segs: /删|清理|破坏性|卸载/i },
  { when: /\b(install|pnpm\s+add|plugin)\b/, segs: /装|安装|插件|bundle/i },
  { when: /\b(write|edit|patch|create)\b/, segs: /改|写|补丁|记录/i },
  { when: /\b(restart|boot|profile|cordis)\b/, segs: /重启|profile|配置|dist/i },
];

function lessonHooksLine(max = 24, hint = '') {
  const list = lessonEntries();
  if (!list.length) return '';
  const signal = String(hint || '').toLowerCase();
  const alias = HINT_ALIASES.filter((r) => r.when.test(signal)).map((r) => r.segs);
  const scoreOf = (e) => {
    if (!signal) return 0;
    const body = String(e.keywords || '').split('/').slice(1);
    const literal = body.reduce(
      (n, seg) => (seg && signal.includes(String(seg).toLowerCase().replace(/\s+/g, '')) ? n + 1 : n),
      0,
    );
    // 语义命中只算一次加权，避免一条记忆因为多个别名段被重复抬高。
    const semantic = alias.some((re) => re.test(String(e.keywords || ''))) ? 2 : 0;
    return literal + semantic;
  };
  const scored = list.map((e, i) => ({ e, i, score: scoreOf(e) }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored
    .slice(0, max)
    .map(({ e }) => {
      const segs = String(e.keywords || '').split('/').slice(1).filter(Boolean).slice(0, 2);
      return `${e.file.replace(/\.md$/i, '')}=${segs.join('/') || '（无关键词）'}`;
    })
    .join(' · ');
}

function lessonReadThisTurn() {
  const turn = turnCount || 1;
  const files = new Set(lessonEntries().map((e) => e.file));
  if (!files.size) return false;
  const events = readJson(RECALL, []);
  return (Array.isArray(events) ? events : []).some((ev) => ev && ev.turn === turn && files.has(ev.file));
}

function lessonReminder(hint = '') {
  const line = lessonHooksLine(24, hint);
  if (!line) return '';
  return `【教训提醒】动手前扫一眼，命中就先 memory_read（可一次传多条）再动手：${line}`;
}

/** 从 fromTurn 之后有回忆的轮数：面板那个环的深蓝段（单位=轮）。 */
function recallTurnsSince(fromTurn) {
  const events = readJson(RECALL, []);
  const turns = new Set();
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev && typeof ev.turn === 'number' && ev.turn > fromTurn && ev.turn <= turnCount) turns.add(ev.turn);
  }
  return turns.size;
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
 * 关键词是「钩子」，不是「关键句」（2026-11-13 用户口径）：
 * 太长就从提醒变成负担，每段 ≤10 字、最多 4 段，写成词组，不能写成「……前看」这类句子。
 */
const KEYWORD_SEG_MAX = 10;
const KEYWORD_SEG_COUNT = 4;

function keywordTooLong(keywords) {
  const parts = String(keywords || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  const longSeg = parts.filter((p) => Array.from(p).length > KEYWORD_SEG_MAX);
  if (longSeg.length) {
    return `关键词写成句子了（每段最多 ${KEYWORD_SEG_MAX} 字），超长的有：${longSeg.map((p) => `「${p}」${Array.from(p).length} 字`).join('、')}。砍成名词/动词词组重试，例如：删家目录 / 装完即验收 / MCP·懒加载。`;
  }
  if (parts.length > KEYWORD_SEG_COUNT) {
    return `关键词最多 ${KEYWORD_SEG_COUNT} 段（含分类），现在是 ${parts.length} 段：${parts.join('/')}。留最能勾人的那几段。`;
  }
  return null;
}

/**
 * 空泛词：写进关键词等于没写（2026-11-13 用户口径「插件、记忆、回忆这种空泛词等于没写」）。
 * 只有整条都是这类词才拦——单独出现一个，模型可能确实没法更具体。
 */
const VAGUE_SEGMENTS = new Set([
  '插件',
  '记忆',
  '工具',
  '说明',
  '说明书',
  '回忆',
  '操作',
  '方法',
  '使用',
  '经验',
  '重要',
  '内容',
  '杂项',
  '其他',
  '一般',
  '技巧',
  '注意事项',
]);

function keywordTooVague(keywords) {
  const parts = String(keywords || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  const body = parts.slice(1); // 第一段是分类，不参与
  if (!body.length) return null;
  if (body.every((p) => VAGUE_SEGMENTS.has(p))) {
    return `关键词全是空泛词（${body.join('/')}），等于没写：写「什么场景下必须点开这条」，像「删家目录 / 装完即验收 / 会话注入」这种具体到动作的。`;
  }
  return null;
}

/** 这一轮读过哪些记忆（查重结论里提到的条目要能对上真读过的，不许凭空报名字）。 */
function readThisTurn(files) {
  const turn = turnCount || 1;
  const want = new Set(files.map((f) => (String(f).endsWith('.md') ? String(f) : `${f}.md`)));
  const events = readJson(RECALL, []);
  const hit = new Set();
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev && ev.turn === turn && want.has(String(ev.file))) hit.add(String(ev.file));
  }
  return hit;
}

/**
 * 记忆之间的关系边（2026-11-25：补上「结构化知识库」这一层）。
 *
 * 以前回忆只能靠大纲里的关键词做字面匹配，条目之间彼此孤立——这是召回率上不去的结构性原因。
 * 现在写新记忆时，dup_check 里点名的相近条目会被记成一条双向边（权重累加），
 * memory_read 读完一条就顺带提示它的邻居，于是「按图索骥」这条路才通。
 * 边只是路由，不是内容：不进大纲、不进提示词，只有真的读到某条时才露出来。
 */
function readLinks() {
  const raw = readJson(LINKS, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function stemOf(file) {
  return String(file || '')
    .trim()
    .replace(/\.md$/i, '');
}

function fileOfStem(stem) {
  const text = stemOf(stem);
  return text ? `${text}.md` : '';
}

/** 记一条双向边；同一条边被反复认出来时权重累加（越常被联想到，排序越靠前）。 */
function addLink(from, to, why = '') {
  // 键统一用不带 .md 的名称：索引、大纲、memory_read 里的叫法都是这个名字。
  const a = stemOf(from);
  const b = stemOf(to);
  if (!a || !b || a === b) return;
  try {
    const map = readLinks();
    const put = (x, y) => {
      const row = map[x] || {};
      const cur = row[y] || { w: 0, ts: '' };
      row[y] = { w: (cur.w || 0) + 1, ts: new Date().toISOString(), why: why || cur.why || '' };
      map[x] = row;
    };
    put(a, b);
    put(b, a);
    writeJson(LINKS, map);
  } catch {
    /* 边写不进去不影响写入本身 */
  }
}

/** 删记忆时把它的边一并清掉，否则会留下指向空文件的路由。 */
function dropLinks(file) {
  const key = stemOf(file);
  try {
    const map = readLinks();
    delete map[key];
    for (const from of Object.keys(map)) delete map[from][key];
    writeJson(LINKS, map);
  } catch {
    /* 同上 */
  }
}

/** 一条记忆的邻居：按权重降序，只留还存在且启用的条目。 */
function relatedOf(file, limit = LINK_LIMIT) {
  try {
    const row = readLinks()[stemOf(file)] || {};
    const byFile = new Map(readEntries().map((e) => [stemOf(e.file), e]));
    return Object.entries(row)
      .sort((x, y) => (y[1]?.w || 0) - (x[1]?.w || 0))
      .map(([f, v]) => ({ file: fileOfStem(f), entry: byFile.get(f), w: v?.w || 0 }))
      .filter((it) => it.entry && it.entry.enabled)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** memory_read 的尾巴：邻条目名 + 去前缀的关键词，够用来判断要不要顺手读。 */
function relatedNote(file) {
  const rel = relatedOf(file);
  if (!rel.length) return '';
  const parts = rel.map((r) => `${stemOf(r.file)}（${String(r.entry.keywords || '').replace(/^[^/]+\//, '')}）`);
  return `\n\n相关记忆：${parts.join(' · ')}——需要就 memory_read（可一条命令多传几个）`;
}

/**
 * 新建之前的查重闸门（2026-11-15 用户口径改版）：
 * 相似度由**模型自己判断**——先看关键词筛一遍，觉得可能像就 memory_read 打开全文再判断。
 * 代码不替它算相似度，只负责两件机械的事：逼它把结论写下来（dup_check），
 * 以及核对「你说看过的，这一轮真读过」。
 */
const DUP_VERDICTS = ['新建', '并入', '相似', '相关', '相同', '无关', '单开'];

function assertDupeReviewed(args) {
  const raw = String(args?.dup_check || '').trim();
  if (!raw) {
    throw new Error(
      '写之前先查重：扫一眼索引，按关键词判断有没有相似/相同/相关的记忆——相似 → memory_update 稍作修改；相关 → memory_update + append:true 并进去；' +
        '相同 → 别建。确实要单开，就把结论写进 dup_check，例如「跟 dsh-session-422 的关键词都涉及会话注入，读了全文发现对象不同（一个是消息事件、一个是拼接 role），确定为新建」；' +
        '只有关键词像、没看全文的也照实写「只比了关键词」。',
    );
  }
  const short = `查重结论太短了（${Array.from(raw).length} 字）：「${raw}」。写清你比了哪些条目、判成相似/相同/相关/无关、所以新建还是并入，至少 10 个字。`;
  if (Array.from(oneLine(raw, 400)).length < 10) throw new Error(short);
  const line = oneLine(raw, 400);
  if (!DUP_VERDICTS.some((w) => line.includes(w))) {
    throw new Error(`查重结论里要有判定词（新建 / 并入 / 相似 / 相关 / 相同 / 无关）：你现在写的是「${line}」。`);
  }
  const stems = readEntries().map((e) => e.file.replace(/\.md$/i, ''));
  const named = stems.filter((s) => s && line.includes(s));
  const unread = named.filter((n) => !readThisTurn([n]).size);
  if (unread.length) {
    throw new Error(
      `你在查重结论里提了 ${unread.join('、')}，但这一轮没读过它（memory_read 才算），别凭空报名字：先读，再回来写。`,
    );
  }
  // 刚落笔前读过的记忆必须表态：读到了就绕开它另开一条，是最容易被忽略的浪费。
  const readNow = [...readThisTurn(stems)].map((f) => f.replace(/\.md$/i, ''));
  const ignored = readNow.filter((n) => !named.includes(n));
  if (ignored.length) {
    throw new Error(
      `你这一轮读过 ${ignored.join('、')}，dup_check 里却没提它：先说清跟它是什么关系再落盘——` +
        '相似就 memory_update 改它、相关就 append:true 并进去、无关就写明「无关」的理由。别读到了还另开一条。',
    );
  }
  return { line, named, read: named.length > 0 };
}

/**
 * 教训关键词的「预防性」校验（2026-11-09 用户口径）：
 * 关键词的作用是让未来的模型看见它、意识到自己下一步可能闯祸，从而先展开回忆。
 * 所以它必须写「犯错之前的任务与动作」，写成事后症状/错误码/根因就等于没写——
 * 那些词只在修完 bug 时才出现在脑子里，挡不住下一次。
 */
const LESSON_SYMPTOM_WORDS =
  /\b[1-5]\d{2}\b|\b[45]xx\b|报错|错误码|错误|失败|崩溃|白屏|黑屏|卡死|挂掉|不生效|不工作|失效|异常|\bbug\b|根因|修复|修好|超时|冲突|缺字段|missing|error|exception/i;

function lessonKeywordProblem(keywords) {
  const parts = String(keywords || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts[0] !== '教训') return null;
  const bad = parts.slice(1).filter((p) => LESSON_SYMPTOM_WORDS.test(p));
  if (!bad.length) return null;
  return [
    `教训的关键词要写「犯这个错之前你正在做的动作」，不能写事后症状/错误码/根因：你现在写的是「${bad.join('、')}」。`,
    '这类词在你真要犯错的那一刻不会出现在脑子里；那一刻只有「我正在删除这个目录」「我正在往会话里注入消息」这种动作。',
    '换成动作短语重试，例如：教训/批量删除家目录、教训/往会话注入消息、教训/改运行中profile、教训/装完插件直接验收、教训/截断工具返回的长文本。',
  ].join('');
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

/**
 * 2.0 的正文长度闸门：一条记忆只占一个向量，太长会把语义平均掉，写入直接拒。
 * 这不是模型塞不下（embedding 单条 8,192 token），而是检索质量的选择。
 */
function assertBodyLength(body) {
  const chars = Array.from(String(body || '')).length;
  if (chars > MEMORY_BODY_MAX) {
    throw new Error(
      `这条正文 ${chars} 字，超过 ${MEMORY_BODY_MAX} 字上限（2.0 起一条记忆只占一个向量，太长检索会被稀释）：` +
        '拆成两条（按主题分），或把细节挪进独立的附录条目，正文里用 memory_read 指路。',
    );
  }
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

/**
 * 保留：用户否决「待删除」判定。只把复核日刷到今天（索引第 6 列 + 正文 reviewed），
 * 否则会话间隔一过就会立刻又变回待删除，所以两边必须同时改。
 */
function keepEntry(file) {
  if (!/^[\w.-]+\.md$/.test(file) || file === 'MEMORY.md') throw new Error('文件名非法');
  const entry = readEntries().find((e) => e.file === file);
  if (!entry) throw new Error('索引里没有这条记忆');
  const target = path.join(MEM, file);
  if (fs.existsSync(target)) {
    const doc = splitDoc(fs.readFileSync(target, 'utf8'));
    if (doc.attrs.length) {
      const attrs = [...doc.attrs];
      setAttr(attrs, 'reviewed', today());
      fs.writeFileSync(target, joinDoc(attrs, doc.body), 'utf8');
    }
  }
  updateCell(file, 6, today());
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

/* ───────────────────────── 项目记忆的来源会话 ─────────────────────────
 * 用户 2026-11-25 口径：项目记忆头部自动注明来源 session 号；那场会话的全部原始
 * 上下文另存一份备份；除非模型主动来查，否则一个字都不进上下文。
 * 备份落在 ~/.dsh/memory/.sources/：不是 .md 记忆、不进 MEMORY.md、不进大纲，
 * 所以既不会被当成一条记忆，也不会被别的流程顺走。
 */

const SOURCE_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 会话日志是多帧 zstd（一次 append 一帧），`zstdDecompressSync(整文件)` 只出第一帧，
 * 流式解码到帧尾报 Unknown frame descriptor——所以按 magic 切帧逐段解。
 * magic 落在压缩体内部时把边界往后延一格重试。
 */
function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  const offsets = [];
  for (let i = 0; i <= buf.length - SOURCE_MAGIC.length; i += 1) {
    if (buf.compare(SOURCE_MAGIC, 0, SOURCE_MAGIC.length, i, i + SOURCE_MAGIC.length) === 0) offsets.push(i);
  }
  const parts = [];
  let index = 0;
  while (index < offsets.length) {
    let end = index + 1 < offsets.length ? offsets[index + 1] : buf.length;
    let decoded;
    let cursor = index;
    for (;;) {
      try {
        decoded = zlib.zstdDecompressSync(buf.subarray(offsets[cursor], end));
        break;
      } catch (err) {
        cursor += 1;
        if (cursor >= offsets.length) throw err;
        end = cursor + 1 < offsets.length ? offsets[cursor + 1] : buf.length;
      }
    }
    parts.push(decoded);
    index = cursor + 1;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 在 ~/.dsh/sessions/<工程目录>/<会话>/session.v4.jsonl.zstd 里找这场会话的日志。 */
function sessionLogPath(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!/^(session-)?[0-9a-f][0-9a-f-]{7,}$/i.test(raw)) return '';
  const names = raw.startsWith('session-') ? [raw] : [raw, `session-${raw}`];
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return '';
  }
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(SESSIONS_ROOT, dir.name, name, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) return file;
    }
  }
  return '';
}

function clipText(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max)}…[截断 ${s.length - max} 字]`;
}

/**
 * 把会话事件渲染成能读的「原始上下文」：用户原话、助手正文、工具调用与结果。
 * 推理块（reasoning）是过程噪音，丢掉；工具结果单条截到 800 字，原始日志另存一份兜底。
 */
function renderSessionTranscript(text) {
  const out = [];
  const stats = { turns: 0, user: 0, assistant: 0, tool: 0 };
  let turn = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = row?.event ?? row;
    if (!ev || typeof ev.type !== 'string') continue;
    const data = ev.data || {};
    if (ev.type === 'turn/start') {
      stats.turns += 1;
      turn = Number(data.turn) || stats.turns;
      continue;
    }
    if (ev.type === 'user/message') {
      if (data?.source?.kind !== 'user') continue;
      const said = (data.content || [])
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text || ''))
        .join('\n')
        .trim();
      if (!said) continue;
      stats.user += 1;
      out.push(`\n## 用户${turn ? `（第 ${turn} 轮）` : ''}\n\n${said}`);
      continue;
    }
    if (ev.type === 'assistant/message') {
      const blocks = data?.message?.content || [];
      const texts = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text || '').trim())
        .filter(Boolean);
      if (texts.length) {
        stats.assistant += 1;
        out.push(`\n## 助手\n\n${texts.join('\n\n')}`);
      }
      for (const call of blocks.filter((b) => b?.type === 'tool-call')) {
        stats.tool += 1;
        out.push(`\n► ${call.name || '?'} ${clipText(call.arguments || '', 400)}`);
      }
      continue;
    }
    if (ev.type === 'tool/result') {
      const got = (data?.message?.content || [])
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text || ''))
        .join('\n')
        .trim();
      if (got) out.push(`◄ ${clipText(got, 800)}`);
    }
  }
  return { md: out.join('\n').trim(), stats };
}

/**
 * 备份一条会话的原始上下文（幂等：日志大小没变、备份还在，就直接复用）。
 * 产出三个文件：<id>.md（可读转录）、<id>.jsonl.zst（原始日志副本）、<id>.json（元信息）。
 */
function ensureSessionSource(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('缺少会话号');
  const log = sessionLogPath(id);
  if (!log) throw new Error(`找不到会话 ${id} 的日志（可能已被清理）`);
  fs.mkdirSync(SOURCES, { recursive: true });
  const base = path.join(SOURCES, id);
  const mdFile = `${base}.md`;
  const zstFile = `${base}.jsonl.zst`;
  const metaFile = `${base}.json`;
  const logSize = fs.statSync(log).size;
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {
    meta = null;
  }
  if (meta && meta.logSize === logSize && fs.existsSync(mdFile) && fs.existsSync(zstFile)) {
    return { ...meta, file: mdFile, cached: true };
  }
  const { md, stats } = renderSessionTranscript(decodeSessionLog(log));
  const head = [
    `# ${id} 原始上下文`,
    '',
    `- 会话日志：${log}`,
    `- 轮次 ${stats.turns} · 用户 ${stats.user} · 助手 ${stats.assistant} · 工具调用 ${stats.tool}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
  ].join('\n');
  const full = `${head.trimEnd()}\n${md}\n`;
  fs.writeFileSync(mdFile, full, 'utf8');
  fs.writeFileSync(zstFile, fs.readFileSync(log));
  meta = {
    session: id,
    log,
    file: mdFile,
    zst: zstFile,
    chars: Array.from(full).length,
    logSize,
    stats,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  return { ...meta, cached: false };
}

/** 记忆正文头部的来源行；没有会话号就不写。 */
function sourceLine(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  return `> 来源会话：${id}（原始上下文已另存本机；要看原文用 memory_source，默认不载入）`;
}

/** 从正文头部的来源行里取回会话号。 */
function sourceSessionOf(body) {
  const hit = String(body || '').match(/来源会话[：:]\s*(session-[0-9a-f-]{8,})/i);
  return hit ? hit[1] : '';
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
  assertBodyLength(body);
  // 项目记忆（人工通道）在正文最前面记来源会话，并把那场会话的原始上下文备份到 .sources。
  const session = oneLine(input?.session, 80);
  const head = sourceLine(session);
  const fullBody = head ? `${head}\n\n${body}` : body;
  if (session) {
    try {
      ensureSessionSource(session);
    } catch (err) {
      // 备份失败不该挡住记忆本身：头部照样记下会话号，回头还能重试。
      logPluginError('/memory source backup', err);
    }
  }
  const target = path.join(MEM, file);
  fs.writeFileSync(
    target,
    joinDoc([`name: ${name}`, `description: ${description}`, `type: ${type}`, `reviewed: ${today()}`], fullBody),
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
  dropLinks(file);
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
/**
 * 2.0 阶段二：重建「章节级」向量索引。
 * - 正文仍是唯一真源，索引落在 `memory/.index/`，整目录删掉也能重建；
 * - 增量：段 id 带内容哈希，没变的段直接复用旧向量，不重复花钱；
 * - names 只表示「这几个文件强制重算」，full 表示「连清单里的模型维度都重来」。
 */
async function reindexMemories(opts = {}) {
  const cfg = resolveEmbedConfig();
  if (!cfg.apiKey) {
    throw new Error('还没有配置 embedding 的 Key：设 DSH_MEMORY_EMBED_KEY，或让 ~/.bailian/config.json 里有 api_key');
  }
  const files = [];
  for (const entry of readEntries()) {
    const body = readMemoryBody(entry.file);
    if (!body.trim()) continue;
    const name = entry.file.replace(/\.md$/, '');
    const head = String(entry.keywords || '').split('/')[0].trim();
    files.push({
      name,
      file: entry.file,
      body,
      // 阶段二先沿用关键词当摘要；阶段七换成一句话 summary
      summary: entry.keywords || '',
      keywords: entry.keywords || '',
      category: CATEGORIES.includes(head) ? head : '其它',
    });
  }
  if (!files.length) throw new Error('没有可索引的记忆');
  const built = await buildIndex(files, readIndex(MEM), {
    full: Boolean(opts.full),
    force: Array.isArray(opts.names) ? opts.names : [],
    model: cfg.model,
    dim: cfg.dim,
    embed: (texts) => embedTexts(texts, cfg),
  });
  writeIndex(MEM, built);
  return { ...built.stats, key: cfg.masked, baseUrl: cfg.baseUrl };
}

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
  '改完调用 submit_rewrites 提交，每一份都要给，file 只能是给你的文件名。没有工具可用时，输出 JSON：{"items":[{"file":"x.md","body":"改写后的完整正文"}]}，不要解释、不要代码围栏。',
].join('\n');

const COMPRESS_HEAVY_SYSTEM = [
  '你是记忆的中删减器。用户会给你若干条记忆（关键词 + 正文），是他长期积累的笔记。',
  '中删减 = 合并小节、删掉过时或重复的段落、把清单压成更短的行，但不许删掉任何可执行的用法、命令、路径、版本号、坑与限制。',
  '不补新事实，不改语气，不改关键词，不改 YAML 头。目标篇幅：原文的 50%–70%；少于 50% 算删过头，超过 70% 算没压到位。',
  '改完调用 submit_rewrites 提交，每一份都要给，file 只能是给你的文件名。没有工具可用时，输出 JSON：{"items":[{"file":"x.md","body":"改写后的完整正文"}]}，不要解释、不要代码围栏。',
].join('\n');

let compressRunning = false;

/**
 * `memory_write` 工具的声明。工具注册和 `/remember` 的隐藏调用共用这一份：
 * 模型「往里填空」时用的是工具参数的 JSON Schema（原生 function calling），
 * 而不是让它在自由文本里手写 JSON——后者才是「模型没有返回 JSON」的根源。
 */
const WRITE_TOOL_DESCRIPTION = [
  '记住一件以后还会用到的事：新的稳定事实、可复用的做法、或一次纠正，最多一条。首词是分类：资料 / 教训 / 说明书 / 其它（项目记忆 只由用户点「大脑」按钮生成）。',
  '写之前先查重（必填 dup_check）：按索引里的名称和关键词自己判断，拿不准就 memory_read 读全文——相似就改它、相关就 append:true 并进去、相同就别新建。结论写进 dup_check，提到名字就必须真读过。',
  'keywords 是钩子不是句子：写「什么场景下必须点开这条」，每段 ≤10 字、1~4 段用 / 分隔。要像标题党一样勾人，写成一看就知道「我正处在这个场面」的词（`删家目录`、`会话注入`、`MCP 连不上`），别写「……前看」尾巴、一次性任务名或只有你懂的缩写；空泛词（插件、记忆、工具、说明、回忆）等于没写。',
  '· 教训：`教训/删家目录/重装DSH`；资料：`资料/中文乱码/代码页`；说明书：`说明书/MCP/懒加载`。',
  '教训里别写错误码和根因（422、报错、根因是缺 role）——你正要犯错时想不到它们。',
  '写「教训」时 body 必须三段，缺一段就没有预防作用：① 场景（什么任务、什么动作会踩到，读者一看就知道「我现在正在这个场景里」）；② 错误链条（第一步做什么、哪步开始不对、为什么没察觉）；③ 绕开与修复（下次怎么走、已部署什么防护）。',
  '写「说明书」用使用者口吻：什么时候该用、怎么用、哪儿会翻车；不写调试过程、升级史和内部原理（实现细节保持灰箱）。',
].join(' ');

const WRITE_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '记忆名称，英文小写和连字符，如 gift-ideas。' },
    keywords: {
      type: 'string',
      description:
        '钩子不是句子：每段 ≤10 字，1~4 段用 / 分隔，首段是分类。教训写场景（`教训/删家目录`、`教训/装完即验收`），资料写认得出来的对象（`资料/称呼/基本信息`），说明书写工具名（`说明书/MCP/懒加载`）。别写「……前看」尾巴，别写空泛词（插件/记忆/工具）。',
    },
    description: { type: 'string', description: '一句话说清这是什么、什么时候该读。' },
    body: { type: 'string', description: '正文，Markdown，写完整句子；2000 字以内通常够用，内容确实需要可以更长。' },
    type: { type: 'string', description: '可选：reference / profile / 其他，默认 reference。' },
    dup_check: {
      type: 'string',
      description:
        '必填：查重结论。先按索引里的名称和关键词自己判断一遍有没有相似/相同/相关的记忆；拿不准就用 memory_read 打开那几条读全文再看。' +
        '然后写清「比了哪些、判成相似/相同/相关/无关、所以新建还是并入」，例如：跟 noahs-ark 都涉及删目录，读了全文发现它的对象是家目录、这条是 mklink 目录，确定为新建。' +
        '提到名字就必须真读过（memory_read 才算），插件会核对。相似 → 改原文；相关 → memory_update + append:true；相同 → 别建。',
    },
  },
  required: ['name', 'keywords', 'description', 'body'],
  additionalProperties: false,
};

/**
 * `/remember` 给主 agent 的工具声明：同一个 `memory_write` 工具，
 * 只把「关键词首词」和「内容取向」改成本次任务的口径。
 */

/** 另外三个工具的说明也提到模块级：`/dsh-memory/prompts` 与注册共用同一份原文，改一处即可。 */
const READ_TOOL_DESCRIPTION = [
  '读取记忆正文。上下文里有一行「记忆 ▸ 名称=关键词」，先按关键词挑出和当前任务对得上的，再用本工具取原文。',
  '可以一次读多条：file 用「、」或逗号分隔（如 "noahs-ark、审计日志"），比一条条读省调用、也更适合「动手前先把相关教训都扫一遍」。',
  '「教训/」开头的条目是**动手前**必查的：只要它的动作场景落进你这次要做的事，先读它、再动手；不要等报了错才回来找。',
  '项目记忆正文头部有「> 来源会话：session-…」：正文不够用时用 memory_source 去查那场会话的原始上下文。',
  '不要用 read / grep / glob / 命令行去翻记忆仓库：插件会拒绝，而且那样更慢。',
  'file 传大纲里的名称（如 user-profile），也可以传一个关键词（如 身份）。',
].join(' ');

const UPDATE_TOOL_DESCRIPTION = [
  '发现某条记忆过时、有误或不全时，顺手订正它。只传要改的字段，其余保持原样。',
  '新内容跟已有记忆相关（不是过时，而是同一件事又有了新经验）时，用 append:true 把这段并进正文尾部，而不是另开一条。',
  '换关键词时第一段仍是分类：资料 / 教训 / 说明书 / 其它（项目记忆 只能由用户点「大脑」生成）。',
  '关键词按「什么场景下必须点开这条」写，越短越勾人越好；空泛词（插件、记忆、工具）等于没写，也别写 422 / 报错 这类事后症状。',
  '锁定的记忆会被拒绝，需要用户先在设置页解锁。',
].join(' ');

const DELETE_TOOL_DESCRIPTION = [
  '删除一条确实没用了的记忆，同时删掉索引行。删除前确认没有别的记忆在引用它。',
  '这是不可回滚的删除：正文文件直接删掉，只在记忆调用流水里留一份留底。',
  '锁定的记忆会被拒绝，需要用户先在设置页解锁。',
].join(' ');

const SOURCE_TOOL_DESCRIPTION = [
  '查一条「项目记忆」的原始上下文：它头部写着来源会话，那场会话的完整对话备份在本机，平时一个字都不进上下文。',
  'mode=meta（默认）只回元信息（会话号、备份文件、字数、统计），先看这个再决定要不要真读。',
  'mode=read 按字符区间读：offset/limit（默认 0/4000）；mode=find 用 pattern 找片段，回最多 8 处并带字符偏移，便于接着 read。',
  '只有当项目记忆正文不够用、必须回看当时原话与命令时才调它——读进来就是真金白银的 token。',
].join(' ');

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
  '5. description：一句话说清以后什么时候该读它；',
  '6. 项目记忆是一条会话总结，跟已有条目撞车时没有合并通道，所以 keywords 和 description 要能跟相近的条目区分开：先扫一眼索引，若已有近似条目，把项目名和场景写得更具体，别写出两条让人分不清的项目记忆。',
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

/**
 * 模型在整个记忆流程里能看到的提示词原文（记忆正文除外）。
 * 用户 2026-11-18 要求逐条过目，所以这里不裁剪、不摘要，连校验报错也照着触发一遍抄下来。
 * 工具定义不是手抄的：注册时由 toolSink 顺手记下来，免得文档和实际漂移。
 */
const REGISTERED_PROMPTS = [];

function recordToolDef(def) {
  try {
    const params = Object.entries(def?.parameters?.properties || {})
      .map(([k, v]) => `  ${k}${Array.isArray(def?.parameters?.required) && def.parameters.required.includes(k) ? '（必填）' : ''}：${v?.description || ''}`)
      .join('\n');
    REGISTERED_PROMPTS.push({
      id: `工具·${def?.name || '?'}`,
      where: '工具定义（每次请求都随工具一起发出）',
      text: `${def?.description || ''}${params ? `\n参数：\n${params}` : ''}`,
    });
  } catch {
    /* 记录失败不影响注册 */
  }
}

function promptInventory() {
  const entries = readEntries();
  const tier = currentTier(entries.length);
  const tree = outlineText(entries).split('\n');
  const items = [
    { id: '系统提示词·大纲抬头', where: '系统提示词·记忆索引（每轮都在）', text: tree.slice(0, 3).join('\n') },
    { id: '系统提示词·大纲分组', where: '系统提示词·记忆索引（每轮都在）', text: tree.slice(3).join('\n') },
  ];
  for (const it of REGISTERED_PROMPTS) items.push({ id: it.id, where: it.where, text: it.text });
  items.push({ id: '工具·动手前提醒', where: '每轮第一次写/改/跑命令时追加', text: lessonReminder() });
  items.push({ id: '拦截·翻记忆目录', where: 'read/grep/glob 指向记忆仓库时', text: MEMORY_DIR_DENY_TEXT });
  items.push({ id: '校验·按需触发', where: '写入/改写被拒时的报错原文', text: validationTexts().join('\n\n') });
  items.push({ id: '/remember·隐藏指令', where: '用户执行 /remember 时追加', text: `${REMEMBER_INSTRUCTION}\n\n---重试时---\n${REMEMBER_RETRY_INSTRUCTION}` });
  items.push({ id: '/remember·兜底系统提示', where: 'llm 服务不可用时', text: REMEMBER_SYSTEM });
  return {
    tier,
    total: entries.length,
    target: MEM_TARGET,
    items: items.map((it) => ({ ...it, chars: Array.from(String(it.text || '')).length })),
    totalChars: items.reduce((n, it) => n + Array.from(String(it.text || '')).length, 0),
  };
}

/** 把各校验器的报错原文触发一遍，供 promptInventory 抄录（只在 /dsh-memory/prompts 里跑）。 */
function validationTexts() {
  const out = [];
  const run = (label, fn) => {
    try {
      const r = fn();
      if (typeof r === 'string') out.push(`［${label}］${r}`);
    } catch (err) {
      out.push(`［${label}］${err.message}`);
    }
  };
  run('分类不对', () => assertCategory('乱写/分类'));
  run('名称非法', () => assertName('Bad Name.md'));
  run('关键词太长', () => keywordTooLong('教训/批量删除家目录前一定要先看清路径'));
  run('关键词段数太多', () => keywordTooLong('教训/一/二/三/四'));
  run('关键词是事后症状', () => lessonKeywordProblem('教训/422/缺 role'));
  run('关键词空泛', () => keywordTooVague('说明书/插件/工具'));
  run('查重没写', () => assertDupeReviewed({}));
  run('查重太短', () => assertDupeReviewed({ dup_check: '无关' }));
  run('查重没判定词', () => assertDupeReviewed({ dup_check: '我觉得跟以前那些都不一样所以直接新建一条吧' }));
  return out;
}

/** 追加一条调用流水，只留最近 CALL_KEEP 条。 */function appendCall(row) {
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
 *
 * 一次读多条（`file:"a、b、c"`）时必须拆成多条流水：早先拿整串当文件名，
 * `readMemoryBody("a、b.md")` 抛异常，被外层 catch 吞掉，于是这种读法在「记忆」视图里
 * 完全不留痕（2026-11-15 的现场：会话 ba659a96 读了两次记忆，页面写「暂无记忆调用」）。
 */
function recordMemoryCall(exec) {
  try {
    const args = exec?.arguments || {};
    const op = String(exec.name || '').replace(/^memory_/, '');
    const raw = String(args.file ?? args.name ?? '').trim();
    const callId = String(exec?.callId || '');
    const sessionId = exec?.agent?.session?.id || '';
    // 读可以一次传多条；写/改/删永远只有一个目标。
    const queries = op === 'read' ? raw.split(/[、,;；\n]+/) : [raw];
    const targets = [];
    for (const q of queries) {
      const name = String(q || '').trim().replace(/^教训\/|^资料\/|^说明书\/|^项目记忆\/|^其它\//, '');
      const stem = name.replace(/\.md$/i, '');
      if (!stem) continue;
      const entry = op === 'read' ? resolveEntry(stem) : null;
      const file = entry?.file || `${stem}.md`;
      const key = file.replace(/\.md$/i, '');
      if (targets.some((t) => t.file === file)) continue; // 两种叫法点到同一个文件只记一条
      targets.push({ file, key, entry });
    }
    if (!targets.length) return;
    // 同一批多条共用一个基础 id；没有 callId 时自己造一个，否则第二条会变成 `#2` 这种撞车 id。
    const baseId = callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    targets.forEach(({ file, key, entry }, i) => {
      const gone = op === 'delete' ? DELETED_BODIES.get(callId) : null;
      let content = '';
      try {
        if (op === 'read') content = `【记忆：${key}】\n\n${readMemoryBody(file) || ''}`;
        else if (op === 'write') content = String(args.body || '').trim();
        else if (op === 'update') content = readMemoryBody(file) || '';
        else if (op === 'delete') content = gone?.body || '';
      } catch {
        content = '';
      }
      const id = i === 0 ? baseId : `${baseId}#${i + 1}`;
      appendCall({
        id,
        callId,
        sessionId,
        op,
        target: key,
        keywords: entry?.keywords || gone?.keywords || '',
        type: entry?.type || gone?.type || '',
        cat: String(entry?.keywords || gone?.keywords || '').split('/')[0].trim(),
        chars: Array.from(content).length,
        content,
        ok: true,
      });
    });
    if (op === 'delete') DELETED_BODIES.delete(callId);
  } catch {
    /* 记录失败不影响工具本身 */
  }
}

/** 每条记忆该不该压缩、按哪一档。 */
function compressPlan() {
  const hits = recallHits();
  const plan = [];
  const all = readEntries();
  // 压缩只做改写，不做删除判决：该不该删由 snapshot() 里的脚本按「看够 100 轮 + 零回忆」算，
  // 压缩流水的分档只决定「改多重」。条目越多，同样的零回忆越容易落进重压档。
  const staleDays = pruneDays(all.length);
  for (const entry of all) {
    if (!entry.enabled || entry.protected) continue;
    const count = hits.get(entry.file) || 0;
    const age = daysSince(entry.reviewed);
    const body = readMemoryBody(entry.file);
    let level;
    if (count >= HIGH_FREQ) level = 'skip-high';
    else if (count === 0) level = 'heavy';
    else if (count === 1 && Number.isFinite(age) && age >= staleDays) level = 'heavy';
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

const COMPRESS_TOOL_NAME = 'submit_rewrites';

/**
 * 压缩提案的工具声明：file 用 enum 锁死本批候选文件名，
 * 模型写不出不存在的文件，也不会把 items/body 这类字段名写错。
 */
function compressToolSpec(files) {
  return {
    type: 'function',
    function: {
      name: COMPRESS_TOOL_NAME,
      description: '提交改写后的记忆正文。每一份都要提交，不能漏、不能改名、不能加新文件。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string', enum: files },
                body: { type: 'string', description: '改写后的完整正文（Markdown，不含 YAML 头与关键词）' },
              },
              required: ['file', 'body'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  };
}

/** 从回包里取工具调用填好的 items；模型没调工具、参数被截断都返回空数组。 */
function toolCallItems(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  for (const call of calls) {
    if (call?.function?.name !== COMPRESS_TOOL_NAME) continue;
    try {
      const parsed = JSON.parse(call.function.arguments || '');
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      if (Array.isArray(items)) return items.filter((it) => it && it.file && typeof it.body === 'string');
    } catch {
      /* 参数被截断或不是 JSON，试下一个调用 */
    }
  }
  return [];
}

/**
 * 一条压缩对话里的一轮：同一档位的所有批次共用一条 messages 链。
 * 后续请求把前面的「批次 + 助手改稿」当前缀，DeepSeek 的自动前缀缓存就能吃上，
 * 命中率随批次推进升高（2026-10-28 用户问「串行放进一个对话有没有用」——有用，就这么做）。
 *
 * 2026-11-18 起改稿走原生 tool-call：file 用 enum 锁死本批候选，结构由协议保证，
 * 不再靠散文描述形状；没拿到工具调用就重试一次，仍没有才降级回 json_object 文本模式。
 */
async function compressTurn(key, chain, userContent, files, budgetChars) {
  chain.push({ role: 'user', content: userContent });
  const maxTokens = compressMaxTokens(budgetChars);
  const base = { model: COMPRESS_MODEL, thinking: { type: 'disabled' }, max_tokens: maxTokens };
  const withTool = () => ({
    ...base,
    messages: chain,
    tools: [compressToolSpec(files)],
    tool_choice: { type: 'function', function: { name: COMPRESS_TOOL_NAME } },
  });

  let out = await chatOnce(key, withTool());
  let items = toolCallItems(out.payload);
  let mode = 'tool';
  if (!items.length) {
    const choice = out.payload?.choices?.[0] || {};
    compressTrace(
      `工具调用没拿到 items（finish=${choice.finish_reason}，正文 ${Array.from(String(out.content || '')).length} 字，max_tokens=${maxTokens}），重试一次`,
    );
    out = await chatOnce(key, withTool());
    items = toolCallItems(out.payload);
  }
  if (!items.length) {
    compressTrace('两次都没调工具，降级成 JSON 文本模式');
    out = await chatJson(key, { ...base, messages: chain, response_format: { type: 'json_object' } });
    items = parseCompressItems(out.content);
    mode = 'json';
  }
  const usage = out.payload?.usage || {};
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? 0;
  const rate = hit + miss ? Math.round((hit / (hit + miss)) * 100) : 0;
  compressTrace(
    `[${mode}] 缓存命中 ${hit} / 未命中 ${miss}（${rate}%），max_tokens=${maxTokens}，改写 ${items.length} 份，completion=${usage.completion_tokens ?? '?'}，reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 0}`,
  );
  chain.push({ role: 'assistant', content: JSON.stringify({ items }) });
  return { payload: out.payload, items, mode };
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

  const files = items.map((it) => it.file);
  const budget = items.reduce((n, it) => n + Array.from(String(it.body || '')).length, 0);

  let out = await compressTurn(key, chain, payload(''), files, budget);
  let got = out.items;
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
      files,
      budget,
    );
    got = out.items;
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
  writeJson(COMPRESS, { startedAt, turns: turnCount, stage: 'plan', reason, files: [], detail: '' });
  try {
    const plan = compressPlan();
    const pending = new Set(proposedFiles());
    const light = [];
    const heavy = [];
    for (const item of plan) {
      if (item.level === 'skip-high') continue;
      if (pending.has(item.file)) continue; // 已经有待审改稿，别重复提
      if (Array.from(item.body || '').length < 120) continue;
      (item.level === 'light' ? light : heavy).push(item);
    }
    if (!light.length && !heavy.length) {
      writeJson(COMPRESS, {
        startedAt,
        turns: turnCount,
        finishedAt: new Date().toISOString(),
        stage: 'done',
        reason,
        files: [],
        detail: '没有需要压缩的记忆',
      });
      return { files: [] };
    }
    const key = apiKey();
    if (!key) throw new Error('缺少 DSH_AUTOMATION_API_KEY，请在 ~/.dsh/automation.env 里配置');
    writeJson(COMPRESS, { startedAt, turns: turnCount, stage: 'request', reason, files: [], detail: `轻调整 ${light.length} 份、中删减 ${heavy.length} 份` });

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
      turns: turnCount,
      finishedAt: new Date().toISOString(),
      stage: allFailed ? 'failed' : 'done',
      reason,
      files: written,
      detail: [
        `${written.length} 份改稿待审批${belowTarget ? `（${belowTarget} 份未达目标比例）` : ''}`,
        unchanged ? `${unchanged} 份原文未动已跳过` : '',
        nearNoop ? `${nearNoop} 份几乎未缩短已跳过` : '',
        failures.length ? `${failures.length} 批请求失败：${failures[0]}` : '',
      ]
        .filter(Boolean)
        .join('，'),
    });
    return { files: written, failures };
  } catch (err) {
    writeJson(COMPRESS, {
      startedAt,
      turns: turnCount,
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
  const file = createMemory({ name, keywords, description, body, type: 'reference', session: agent?.session?.id || '' });
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
 * 关键词分隔符归一：索引表允许手改，人写起来会混进 `;`、`·`、`,`，混在表里会让分类解析错位。
 * 读的时候统一成 `/`，索引表本身不动。
 */
function normalizeKeywords(raw) {
  return String(raw || '')
    .replace(/[;；]/g, '/')
    .replace(/\s*·\s*/g, '/')
    .replace(/[,，、]/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
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
      keywords: normalizeKeywords((cells[1] || '').replace(/`/g, '')),
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

/**
 * 大纲的冷热分层（2026-11-25，照 Anthropic「顶层只留核心、细节下沉」的口径）：
 * 窗口内被读到过 ≥2 次的条目算热，完整给关键词；其余只给前几段——名字还在，
 * 想读随时能 memory_read，但不拿一长串冷记忆去挤占每轮的系统提示词。
 */
const OUTLINE_HOT_HITS = 2;
const OUTLINE_COLD_KW_MAX = 16;

function outlineText(entries = readEntries()) {
  const live = entries.filter((e) => e.enabled && e.keywords);
  if (!live.length) return '';
  const headOf = (kw) => {
    const head = String(kw).split('/')[0].trim();
    return CATEGORIES.includes(head) ? head : '未分类';
  };
  const hits = recallRates();
  // 观察窗口不足 20 轮时不做冷热区分：新装或刚清理时没有统计，全削短既没依据也会伤召回。
  const windowSize = Math.min(WINDOW_TURNS, turnCount);
  const coldStart = windowSize < 20;
  const isHot = (e) => coldStart || e.protected || (hits.get(e.file) || 0) >= OUTLINE_HOT_HITS;
  const lines = [
    '记忆索引（名称=关键词）。关键词是钩子，写的是「什么场景下必须点开这条」。读正文用 memory_read，可一次传多个（file:"a、b"）。',
    '动手改 / 删 / 装 / 跑命令之前，先扫【教训】；要用某个工具 / 插件 / 技能之前，先看它的【说明书】；提到旧事或接手旧任务，扫对应分组；拿不准就查——查错一次调用，漏查要返工。',
    // 总量口径：六套措辞由 PID 选出，模型只看到一句话，看不到机制。
    TIER_LINES[currentTier(entries.length) - 1],
  ];
  for (const [cat] of OUTLINE_GROUPS) {
    const rows = live
      .filter((e) => headOf(e.keywords) === cat)
      .map((e) => {
        const raw = String(e.keywords);
        const head = raw.split('/')[0].trim();
        const body = CATEGORIES.includes(head) ? raw.replace(/^[^/]+\//, '') : raw;
        // 组名已经写明了分类，关键词里省掉前缀；裁剪预算按「去前缀后的可用长度」算。
        // 冷条只留前几段：名字仍在大纲里，用到时再读正文。
        // 但至少放得下第一段——宁可多几个字，也不把「huashu-motion-install」切成半截。
        const prefix = CATEGORIES.includes(head) ? head.length + 1 : 0;
        const firstLen = Array.from(body.split('/')[0] || '').length;
        const budget = isHot(e)
          ? Math.max(10, OUTLINE_KW_MAX - prefix)
          : Math.max(10, Math.min(OUTLINE_KW_MAX - prefix, Math.max(OUTLINE_COLD_KW_MAX - prefix, firstLen)));
        return `${e.file.replace(/\.md$/, '')}=${clipKeywords(body, budget)}`;
      });
    if (rows.length) lines.push(`【${cat}】${rows.join(' · ')}`);
  }
  // 有教训就有前置检查：教训的钩子写的是「会闯祸的场面」，读者必须在动手前对一遍。
  if (live.some((e) => /^教训\//.test(e.keywords))) {
    lines.push('【教训】的钩子写的是「会闯祸的场面」：命中就先 memory_read 读完，再动手。');
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
  // 条目越多淘汰越紧（对数）；再叠加总量口径：越缺记忆越松、越挤越紧。
  const tier = currentTier(entries.length);
  const prune = {
    total: entries.length,
    days: pruneDays(entries.length, tier),
    minHits: pruneMinHits(entries.length, tier),
    tier,
    window: WINDOW_TURNS,
  };
  // 删除判决要等这条记忆「被看过一整个窗口」：新条目还没轮到被读，不能当零回忆垃圾。
  const seen = noteSeen(entries);
  const linkMap = readLinks();
  for (const e of entries) {
    const hits = rates.get(e.file);
    e.recallRate = windowSize ? hits || 0 : null;
    e.links = Object.keys(linkMap[stemOf(e.file)] || {}).length;
    const reviewedAge = daysSince(e.reviewed);
    const firstTurn = seen[stemOf(e.file)];
    const ageTurns = Number.isFinite(firstTurn) ? Math.max(0, turnCount - firstTurn) : null;
    e.ageTurns = ageTurns;
    // 待删除 = 窗口已满 + 这条已看够 100 轮 + 回忆次数低于门槛 + 复核日超出淘汰窗口；
    // 锁定的、停用的不参与。判决纯脚本算，模型不参与、压缩流水线也不碰。
    e.pendingDelete = Boolean(
      windowSize >= JUDGE_TURNS &&
        Number.isFinite(ageTurns) &&
        ageTurns >= JUDGE_TURNS &&
        (hits || 0) < prune.minHits &&
        Number.isFinite(reviewedAge) &&
        reviewedAge >= prune.days &&
        e.enabled &&
        !e.protected,
    );
  }

  // 压缩流水线状态：compressed.json 只有 startedAt 没有 finishedAt 就是没跑完。
  const cst = readJson(COMPRESS, null);
  const cstart = cst?.startedAt ? Date.parse(cst.startedAt) : NaN;
  const unfinished = Boolean(cst?.startedAt) && !cst?.finishedAt;
  const running = unfinished && Number.isFinite(cstart) && Date.now() - cstart < COMPRESS_STALE_MS;

  // 面板顶部那个环：整圈 = COMPRESS_EVERY 轮；浅蓝 = 距上次压缩已走的轮数，深蓝 = 其中真有回忆的轮数。
  const lastTurns = Number.isFinite(cst?.turns) ? cst.turns : null;
  const cycleStart = lastTurns === null ? turnCount - (turnCount % COMPRESS_EVERY) : lastTurns;
  const sinceTurns = Math.max(0, turnCount - cycleStart);

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
    recall: recallOverview(),
    // 口径控制：手动 / 自动。手动时 pid 照样在后台算，切回自动即接着用。
    control: (() => {
      const ctl = readControl();
      const pid = pidState(entries.length);
      return {
        mode: ctl.mode,
        manualTier: ctl.tier,
        autoTier: pid.tier,
        activeTier: ctl.mode === 'manual' ? ctl.tier : pid.tier,
        u: Number(pid.u.toFixed(3)),
        err: Number(pid.err.toFixed(3)),
        integral: Number(pid.integral.toFixed(3)),
        target: MEM_TARGET,
        total: entries.length,
      };
    })(),
    // 当前淘汰线：条目越多，days 越小、minHits 越大（面板照这个解释「为什么这条被标待删除」）。
    prune,
    compress: {
      running,
      interrupted: unfinished && !running,
      failed: cst?.stage === 'failed',
      startedAt: cst?.startedAt || '',
      finishedAt: cst?.finishedAt || '',
      // 上次压缩发生在第几轮：面板拿它和 turns 算「距上次压缩走了多少轮」。
      lastTurns,
      sinceTurns,
      recallSince: recallTurnsSince(cycleStart),
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

/**
 * 记住每条记忆「第一次被看见」的轮次。删除判决要求一条记忆先走完一整个统计窗口
 * （`WINDOW_TURNS`）才有资格被判零回忆——不然刚建的条目连被读的机会都没有。
 * 只记名字不记内容；条目被删掉时顺手清掉，免得同名新建被当成老条目。
 */
function noteSeen(entries) {
  const seen = readJson(SEEN_FILE, {}) || {};
  const stems = new Set(entries.map((e) => stemOf(e.file)));
  let dirty = false;
  for (const stem of stems) {
    if (!Number.isFinite(seen[stem])) {
      seen[stem] = turnCount;
      dirty = true;
    }
  }
  // 只在索引确实读到条目时才清理：读到空表可能是别的东西正写到一半，
  // 这时候把所有首次见到时间抹掉，等于让全部条目重新进入观察期。
  for (const stem of entries.length ? Object.keys(seen) : []) {
    if (!stems.has(stem)) {
      delete seen[stem];
      dirty = true;
    }
  }
  if (dirty) writeJson(SEEN_FILE, seen);
  return seen;
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
  const clean = normalizeKeywords(String(keywords).replace(/[|\r\n]/g, ' ').replace(/\s+/g, ' ').trim());
  const lengthProblem = keywordTooLong(clean);
  if (lengthProblem) throw new Error(lengthProblem);
  return updateCell(file, 2, clean.slice(0, 80));
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
    // 注册的同时把工具声明抄一份给 /dsh-memory/prompts：用户要看提示词全貌，不能靠手抄。
    const toolSink = {
      register(def) {
        recordToolDef(def);
        return toolCtx.tools.register(def);
      },
    };
    toolCtx.effect(
      () =>
        toolSink.register({
          name: 'memory_read',
          description: READ_TOOL_DESCRIPTION,
          parameters: {
            type: 'object',
            properties: {
              file: {
                type: 'string',
                description: '大纲里的记忆名称（可带或不带 .md），或一个关键词；多条用「、」或「,」分隔，最多 6 条。',
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
            const raw = Array.isArray(args?.file) ? args.file.join('、') : String(args?.file || '');
            const queries = raw
              .split(/[、,;；\n]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            if (!queries.length) throw new Error('需要 file：取大纲里的记忆名称或关键词（多条用「、」分隔）');
            const picked = [];
            const missing = [];
            for (const q of queries.slice(0, 20)) {
              const entry = resolveEntry(q);
              if (!entry) {
                missing.push(q);
                continue;
              }
              // 同一个文件被两种叫法点到，只读一次
              if (!picked.some((p) => p.file === entry.file)) picked.push(entry);
              if (picked.length >= 6) break;
            }
            if (!picked.length) {
              const names = readEntries()
                .filter((e) => e.enabled)
                .map((e) => e.file.replace(/\.md$/i, ''))
                .join('、');
              throw new Error(`没有找到记忆「${missing.join('、')}」。可用的有：${names || '（无）'}`);
            }
            const chunks = picked.map((entry) => {
              const name = entry.file.replace(/\.md$/i, '');
              recordRecall(entry.file); // 回忆率就靠这一行统计，读完才记
              return `【记忆：${name}】\n\n${readMemoryBody(entry.file)}${relatedNote(entry.file)}`;
            });
            const tail = missing.length ? `\n\n（没找到：${missing.join('、')}）` : '';
            return { text: chunks.join('\n\n———\n\n') + tail };
          },
        }),
      'memory read tool',
    );

    // 查项目记忆的原始上下文：默认只回元信息，读正文要显式 offset/limit。
    toolCtx.effect(
      () =>
        toolSink.register({
          name: 'memory_source',
          description: SOURCE_TOOL_DESCRIPTION,
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '项目记忆的名称（大纲里的 name，可带或不带 .md）。' },
              mode: { type: 'string', enum: ['meta', 'read', 'find'], description: 'meta=元信息（默认）；read=按字符区间读；find=按 pattern 找片段。' },
              offset: { type: 'number', description: 'mode=read 时的起始字符，默认 0。' },
              limit: { type: 'number', description: 'mode=read 时读多少字符，默认 4000（上限 20000）。' },
              pattern: { type: 'string', description: 'mode=find 时的匹配串（按正则用，不合法就当纯文本）。' },
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
            const name = String(args?.name || '').trim();
            if (!name) throw new Error('需要 name：一条项目记忆的名称');
            const entry = resolveEntry(name);
            if (!entry) throw new Error(`没有找到记忆「${name}」`);
            const session = sourceSessionOf(readMemoryBody(entry.file));
            if (!session) {
              throw new Error(`记忆 ${entry.file} 没有来源会话（只有 /remember 生成或带 session 新建的项目记忆才有原始上下文）`);
            }
            const meta = ensureSessionSource(session);
            const text = fs.readFileSync(meta.file, 'utf8');
            const chars = Array.from(text);
            const mode = String(args?.mode || 'meta').toLowerCase();
            if (mode === 'read') {
              const offset = clampNum(args?.offset ?? 0, 0, chars.length);
              const limit = clampNum(args?.limit ?? 4000, 200, 20000);
              const end = Math.min(chars.length, offset + limit);
              return {
                text: `【原文 ${session}】字符 ${offset}..${end} / 共 ${chars.length}${end < chars.length ? `（还有 ${chars.length - end} 字，接着用 offset=${end}）` : ''}\n\n${chars.slice(offset, end).join('')}`,
              };
            }
            if (mode === 'find') {
              const pattern = String(args?.pattern || '').trim();
              if (!pattern) throw new Error('mode=find 需要 pattern');
              let re;
              try {
                re = new RegExp(pattern, 'gi');
              } catch {
                re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
              }
              const hits = [];
              let hit;
              while ((hit = re.exec(text)) && hits.length < 8) {
                const at = hit.index;
                hits.push(`（字符 ${at}）…${text.slice(Math.max(0, at - 160), at + 240).replace(/\s+/g, ' ')}…`);
                if (re.lastIndex === hit.index) re.lastIndex += 1;
              }
              return { text: hits.length ? `【原文 ${session}】命中 ${hits.length} 处：\n\n${hits.join('\n\n')}` : `【原文 ${session}】没找到「${pattern}」` };
            }
            const st = meta.stats || {};
            return {
              text: [
                `【原文备份】${session}`,
                `可读转录：${meta.file}（${meta.chars} 字）`,
                `原始日志副本：${meta.zst}`,
                `统计：轮次 ${st.turns ?? '?'} · 用户 ${st.user ?? '?'} · 助手 ${st.assistant ?? '?'} · 工具调用 ${st.tool ?? '?'}`,
                `备份时间：${meta.builtAt}${meta.cached ? '（复用已有备份）' : ''}`,
                '要看内容：mode=read（offset/limit）或 mode=find（pattern）。',
              ].join('\n'),
            };
          },
        }),
      'memory source tool',
    );

    // 一次调用写一条记忆：插件负责建文件、补索引、查重、报字数。
    toolCtx.effect(
      () =>
        toolSink.register({
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
            const lengthProblem = keywordTooLong(keywords);
            if (lengthProblem) throw new Error(lengthProblem);
            const kwProblem = lessonKeywordProblem(keywords);
            if (kwProblem) throw new Error(kwProblem);
            const vagueProblem = keywordTooVague(keywords);
            if (vagueProblem) throw new Error(vagueProblem);
            if (!description) throw new Error('description 不能为空，一句话说清什么时候读');
            if (!body) throw new Error('body 不能为空');
            assertBodyLength(body);
            // 查重闸门：模型自己比关键词、必要时读全文，然后把结论写进 dup_check。
            const dupe = assertDupeReviewed(args);
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
            // 查重结论里点到名的相近条目，记成关系边：以后读到任一条都能顺线索找到另一条。
            if (dupe.named.length && /相似|相关|并入|相同/.test(dupe.line)) {
              for (const other of dupe.named) addLink(file, other, dupe.line);
            }
            return {
              text:
                `已记下：${file}\n关键词：${keywords}${lengthNote(file, body)}` +
                (dupe.named.length
                  ? `\n（查重结论：${dupe.line}）`
                  : ''),
            };
          },
        }),
      'memory write tool',
    );

    // 订正一条已有记忆；锁定的不许改。
    toolCtx.effect(
      () =>
        toolSink.register({
          name: 'memory_update',
          description: UPDATE_TOOL_DESCRIPTION,
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要改的记忆名称（大纲里的名称，可带或不带 .md）。' },
              keywords: {
                type: 'string',
                description:
                  '可选：新的关键词，写「什么场景下必须点开它」，像标题党一样勾人；1~4 段用 / 分隔，第一段必须是分类，每段 ≤10 字。',
              },
              description: { type: 'string', description: '可选：新的一句话描述。' },
              body: { type: 'string', description: '可选：新的正文，整段替换（append:true 时改为追加到正文末尾）。' },
              append: {
                type: 'boolean',
                description: '可选：为 true 时把 body 追加到现有正文末尾（中间空一行），而不是整段替换。适合「同一件事又有了新经验」。',
              },
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
            const appendMode = Boolean(args?.append);
            const incoming = args?.body ? String(args.body).trim() : '';
            const body = appendMode ? (incoming ? `${doc.body}\n\n${incoming}` : doc.body) : incoming || doc.body;
            if (!body) throw new Error('body 不能为空');
            assertBodyLength(body);
            // 关键词先校验再落盘：否则正文改了、关键词被拒，留下半截修改
            const nextKeywords = args?.keywords ? oneLine(args.keywords, 80) : '';
            if (nextKeywords) {
              assertCategory(nextKeywords); // 换关键词也要守住分类
              const lengthProblem = keywordTooLong(nextKeywords);
              if (lengthProblem) throw new Error(lengthProblem);
              const kwProblem = lessonKeywordProblem(nextKeywords);
              if (kwProblem) throw new Error(kwProblem);
              const vagueProblem = keywordTooVague(nextKeywords);
              if (vagueProblem) throw new Error(vagueProblem);
            }
            if (appendMode && !incoming) throw new Error('append:true 时要传 body（要追加的那段）');
            fs.writeFileSync(path.join(MEM, file), joinDoc(attrs, body), 'utf8');
            if (nextKeywords) updateCell(file, 2, nextKeywords);
            if (args?.type) updateCell(file, 4, oneLine(args.type, 24));
            if (args?.description) updateCell(file, 5, oneLine(args.description));
            updateCell(file, 6, today());
            return {
              text: `${appendMode ? '已追加' : '已订正'}：${file}${lengthNote(file, body)}`,
            };
          },
        }),
      'memory update tool',
    );

    // 删除一条记忆；锁定的不许删。
    toolCtx.effect(
      () =>
        toolSink.register({
          name: 'memory_delete',
          description: DELETE_TOOL_DESCRIPTION,
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
            dropLinks(file);
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
          return { kind: 'deny', reason: MEMORY_DIR_DENY_TEXT };
        }
        // grep / glob 搜仓库根或正文，等于批量跳过 memory_read。
        if ((exec.name === 'grep' || exec.name === 'glob') && (kind === 'root' || kind === 'body')) {
          return { kind: 'deny', reason: MEMORY_DIR_GREP_DENY_TEXT };
        }
        // 破坏性命令不再硬拦（2026-11-25 用户要求关掉）：只保留 post-execute 的动手前提醒，
        // 判断权交回模型——硬拦会误伤日常命令，也会把「该不该读」变成机械反应。
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
        if (!decision || decision.kind !== 'accept') return decision;
        const extra = [];
        // 动手前提醒：写 / 跑 / 装删之前把【教训】钩子递一次（每轮最多一条，已读过教训就不打扰）。
        if (REMIND_TOOLS.has(exec.name) && lastRemindTurn !== turnCount && !lessonReadThisTurn()) {
          // 把这次动作的字面（命令 / 路径 / 参数）当提示词，让相关的教训钩子浮到最前面。
          let hint = '';
          try {
            hint = `${exec.name || ''} ${JSON.stringify(exec.arguments || {})}`;
          } catch {
            hint = String(exec.name || '');
          }
          const text = lessonReminder(hint);
          if (text) {
            lastRemindTurn = turnCount;
            extra.push({ type: 'text', text });
          }
        }
        // 正文超长提醒：写进记忆仓库的文件超了建议长度就提示一句。
        if ((exec.name === 'write' || exec.name === 'edit') && decision.value === undefined) {
          const abs = memoryTargetOf(exec);
          if (abs) {
            const { length } = bodyLength(fs.readFileSync(abs, 'utf8'));
            if (length > MEM_LIMIT) extra.push({ type: 'text', text: oversizeWarning(path.basename(abs), length) });
          }
        }
        if (!extra.length) return decision;
        return { ...decision, content: [...(decision.content || result.content || []), ...extra] };
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
          path: KEEP_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              const kept = keepEntry(String(body.file || ''));
              sendJson(res, 200, { ...snapshot(), kept });
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: CONTROL_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse(await readBody(req));
              const control = writeControl({ mode: body.mode, tier: body.tier });
              // 只取一次快照：snapshot() 要读索引、全量正文和几个 json，调两次既浪费也可能前后不一致。
              const snap = snapshot();
              sendJson(res, 200, { ...snap, control: { ...snap.control, ...control } });
            } catch (err) {
              sendJson(res, 400, { error: err.message });
            }
          },
        }),
        webCtx.webServer.register({
          kind: 'exact',
          path: PROMPTS_ROUTE,
          handler: (req, res) => {
            try {
              sendJson(res, 200, promptInventory());
            } catch (err) {
              sendJson(res, 500, { error: err.message });
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
        webCtx.webServer.register({
          kind: 'exact',
          path: REINDEX_ROUTE,
          handler: async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
            try {
              const body = JSON.parse((await readBody(req)) || '{}');
              const stats = await reindexMemories({ full: Boolean(body.full), names: body.names });
              sendJson(res, 200, stats);
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
              // 会话 id 有两种写法（`session-xxx` 与裸 uuid，宿主不同版本给的形态不同），
              // 直接全等会让另一形态的记录在视图里凭空消失，所以比较前统一去掉前缀。
              const norm = (s) => String(s || '').replace(/^session-/, '');
              const rows = (Array.isArray(all) ? all : []).filter(
                (e) => e && (!sessionId || norm(e.sessionId) === norm(sessionId)),
              );
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

/** 给 tools/selfcheck.mjs 用的纯函数出口：压缩预算、工具声明、回包解析。 */
export const __test = {
  compressMaxTokens,
  compressToolSpec,
  toolCallItems,
  parseCompressItems,
  COMPRESS_MAX_TOKENS,
  COMPRESS_MAX_TOKENS_CAP,
  TIER_LINES,
  readControl,
  writeControl,
  JUDGE_TURNS,
  decodeSessionLog,
  sessionLogPath,
  renderSessionTranscript,
  ensureSessionSource,
  sourceLine,
  sourceSessionOf,
  SOURCES,
  addLink,
  dropLinks,
  relatedOf,
  readLinks,
  LINKS,
  outlineText,
  OUTLINE_HOT_HITS,
  OUTLINE_COLD_KW_MAX,
};
