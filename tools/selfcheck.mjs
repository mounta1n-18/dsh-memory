#!/usr/bin/env node
/**
 * 离线自检：mock 一个 cordis ctx 把 apply() 整条路径跑起来，
 * 用临时 DSH_HOME（绝不碰真实记忆库）验证四件事：
 *
 *   1. 大纲不丢条目：12 条全在、单条超长只在 `/` 边界裁剪、整行不截断。
 *   2. 闸门按路径身份：大小写 / `..` / 符号链接归一，只拦正文，放行索引与 .tidy。
 *   3. status 单一事实源：state/count 由 proposed/ 现算，status.json 只提供 lastRun/result/detail；
 *      status.json 带 BOM 也能读（PowerShell 5.1 的经典坑）。
 *   4. 首关键词硬约束：模型写入/改关键词必须带合法分类，「项目记忆」拒绝。
 *
 * 用法：node tools/selfcheck.mjs      （退出码 0 = 全过）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PKG = path.resolve(HERE, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-selfcheck-'));
const MEM = path.join(HOME, 'memory');
const TIDY = path.join(MEM, '.tidy');
const PROPOSED = path.join(TIDY, 'proposed');

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${extra ? `  (${extra})` : ''}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? `  (${extra})` : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/** 建一个假记忆库：12 条，最后一条关键词 43 字（必须裁剪）。 */
const ROWS = [
  ['user-profile', '资料/身份/张三/生日/学号/身高', '是', '是'],
  ['girlfriend-profile', '资料/女友/李四', '是'],
  ['noahs-ark', '教训/诺亚方舟/恢复', '是'],
  ['pl-btw', '说明书/btw/旁路问答', '是'],
  ['pl-ctx', '说明书/上下文/用量', '是'],
  ['pl-mcp', '说明书/MCP/懒加载', '是'],
  ['pl-mem', '说明书/记忆/索引/dsh-memory/大纲/整理/压缩/回忆率/待删除/审批/流水线', '是'],
  ['pl-perm', '说明书/权限/预设', '是'],
  ['pl-mcd', '说明书/麦当劳/MCP', '是'],
  ['pl-teach', '说明书/教学/预设', '是'],
  ['random-signal-review', '资料/随机信号分析/期末复习', '是'],
  ['huashu-motion-install', '说明书/huashu-motion/花叔/宣传片/om CLI/动效片/安装位置', '是'],
];

function buildRepo() {
  fs.mkdirSync(PROPOSED, { recursive: true });
  const lines = [
    '# 记忆索引',
    '',
    '| 文件 | 关键词 | 启用 | 类型 | 何时读 | 复核 | 受保护 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [name, kw, enabled, locked = '否'] of ROWS) {
    lines.push(`| \`${name}.md\` | ${kw} | ${enabled} | reference | ${name} 的用途说明。 | 2026-10-27 | ${locked} |`);
    // 正文写长一点（>120 字），否则压缩流水线会按「太短」跳过
    const body = [
      `这是 ${name} 的正文。`,
      '',
      '## 用法',
      '1. 先在设置页打开对应开关，再重启宿主；',
      '2. 命令行示例：node tools/selfcheck.mjs --dry-run；',
      '3. 改动只落在包内，不动宿主原码。',
      '',
      '## 坑',
      '- PowerShell 5.1 写文件会带 BOM，JSON.parse 直接抛错；',
      '- 宿主改动必须重启才生效，客户端改动刷新页面即可。',
      '',
      '## 备注',
      `这条是 ${name} 的自检正文，长度需要超过一百二十字，才能走到压缩判定里。`,
    ].join('\n');
    fs.writeFileSync(
      path.join(MEM, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} 的用途说明。\ntype: reference\nreviewed: 2026-10-27\n---\n\n${body}\n`,
      'utf8',
    );
  }
  fs.writeFileSync(path.join(MEM, 'MEMORY.md'), `${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(
    path.join(HOME, 'automation.env'),
    'DSH_AUTOMATION_API_KEY=sk-selfcheck-dummy\n',
    'utf8',
  );
}

buildRepo();
process.env.DSH_HOME = HOME;

/** /remember 用的假转录：两条人类消息 + 一条助手消息 + 一条子代理消息（后者应被排除）。 */
const FAKE_EVENTS = [
  { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '帮我修一下 dsh-memory 的闸门' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '闸门改成按路径身份判定了。' }] } } },
  { type: 'user/message', data: { source: { kind: 'agent' }, message: { content: [{ type: 'text', text: '子代理的提示不该进转录' }] } } },
  { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '顺便把压缩也修了' }] } } },
];

/** 极简 cordis ctx：只实现本插件真的用到的面。 */
function makeCtx(agent) {
  const state = { sections: [], tools: new Map(), routes: new Map(), commands: new Map(), pre: [], post: [], turnHandlers: [], sessionHandlers: [], followups: [], llm: undefined, llmOptions: null };
  const agentsMock = {
    get: (id) => {
      if (id === 'sess-1') return { session: { ownEvents: () => FAKE_EVENTS }, followup: (m) => state.followups.push(m) };
      if (id === 'sess-empty') return { session: { ownEvents: () => [] }, followup: (m) => state.followups.push(m) };
      if (id === 'sess-llm') {
        return {
          session: {
            id: 'sess-llm',
            ownEvents: () => FAKE_EVENTS,
            deriveMessages: () => [
              { role: 'system', content: '你是主 agent' },
              { role: 'user', content: '帮我看下闸门' },
            ],
            requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
          },
        };
      }
      return undefined;
    },
    roots: () => [],
  };
  const base = {
    effect(fn) {
      const d = fn();
      return () => {
        if (typeof d === 'function') d();
      };
    },
    on(evt, cb) {
      if (evt === 'agent/turn-stopping') state.turnHandlers.push(cb);
      if (evt === 'session/event') state.sessionHandlers.push(cb);
      if (evt === 'tools/pre-execute') state.pre.push(cb);
      if (evt === 'tools/post-execute') state.post.push(cb);
      return () => {};
    },
    agents: { roots: () => [agent] },
  };
  const toolCtx = {
    effect: base.effect,
    on: base.on,
    tools: {
      register(def) {
        state.tools.set(def.name, def);
        return () => {};
      },
      on(evt, cb) {
        if (evt === 'tools/pre-execute') state.pre.push(cb);
        if (evt === 'tools/post-execute') state.post.push(cb);
        return () => {};
      },
    },
  };
  const webCtx = {
    effect: base.effect,
    webServer: {
      register(spec) {
        state.routes.set(spec.path, spec.handler);
        return () => {};
      },
    },
  };
  const cmdCtx = {
    effect: base.effect,
    commands: {
      register(def) {
        state.commands.set(def.name, def);
        return () => {};
      },
    },
  };
  const ctx = {
    ...base,
    get(name) {
      if (name === 'agents') return agentsMock;
      if (name === 'llm') return state.llm;
      return undefined;
    },
    systemPrompt: {
      section(spec) {
        state.sections.push(spec);
        return () => {};
      },
    },
    inject(names, fn) {
      if (names.includes('tools')) fn(toolCtx);
      if (names.includes('webServer')) fn(webCtx);
      if (names.includes('commands')) fn(cmdCtx);
    },
  };
  return { ctx, state };
}

/** 调一次 pre-execute：返回 'deny' 或 'pass'。 */
async function gate(state, name, args) {
  for (const handler of state.pre) {
    let passed = false;
    const decision = await handler({ name, arguments: args }, async () => {
      passed = true;
      return { kind: 'accept' };
    });
    if (decision && decision.kind === 'deny') return 'deny';
    if (passed) return 'pass';
  }
  return 'pass';
}

/** 打一次路由：body 是对象就 POST JSON。 */
async function call(state, routePath, body) {
  const handler = state.routes.get(routePath.split('?')[0]);
  if (!handler) throw new Error(`没有路由 ${routePath}`);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method: body === undefined ? 'GET' : 'POST',
    url: routePath,
    on(evt, cb) {
      if (evt === 'data' && payload) cb(Buffer.from(payload));
      if (evt === 'end') cb();
    },
  };
  let out = null;
  let code = 0;
  const res = {
    set statusCode(v) {
      code = v;
    },
    get statusCode() {
      return code;
    },
    setHeader() {},
    end(text) {
      out = text;
    },
  };
  await handler(req, res);
  return { code, body: out ? JSON.parse(out) : null };
}

const { apply } = await import(pathToFileURL(path.join(PKG, 'index.js')).href);

const agent = { id: 'selfcheck-root' };
const { ctx, state } = makeCtx(agent);
apply(ctx);

console.log(`\n[1] 装载面  DSH_HOME=${HOME}`);
eq('两段系统提示注入', state.sections.length, 2);
ok('注入顺序 outline < tidy-status', state.sections[0].name === 'memory:outline' && state.sections[1].name === 'memory:tidy-status');
eq('四个模型工具', [...state.tools.keys()].sort().join(','), 'memory_delete,memory_read,memory_update,memory_write');
eq('十五条路由（含 /remember、调用流水/详情与探针）', state.routes.size, 15);

console.log('\n[2] 大纲不丢条目');
const outline = state.sections[0].text();
const names = [...outline.matchAll(/([\w-]+)=/g)].map((m) => m[1]);
eq('12 条全在', names.length, 12);
ok('最后一条 huashu-motion-install 在', names.includes('huashu-motion-install'), `大纲 ${Array.from(outline).length} 字`);
ok('教训排最前（动手前先对场景）', names[0] === 'noahs-ark', names.slice(0, 3).join(','));
const longSeg = outline.split(' · ').find((s) => s.startsWith('huashu-motion-install='));
ok('40 字关键词整段保留', !longSeg.includes('…'), longSeg);
const plMem = outline.split(' · ').find((s) => s.startsWith('pl-mem='));
ok('44 字关键词在 / 边界裁剪并加 …', /…$/.test(plMem), plMem);
ok(
  '裁剪后不切半截（每段都是完整关键词）',
  plMem
    .slice('pl-mem='.length)
    .replace(/…$/, '')
    .split('/')
    .every((p) => ['说明书', '记忆', '索引', 'dsh-memory', '大纲', '整理', '压缩', '回忆率', '待删除', '审批'].includes(p)),
);
ok('裁剪后长度不超过上限+省略号', Array.from(plMem.slice('pl-mem='.length)).length <= 43, `${Array.from(plMem.slice('pl-mem='.length)).length} 字`);

// 有「教训/」条目时，大纲末尾必须带前置检查指令
ok('大纲带教训前置检查', /动手前先过一遍【教训】/.test(outline), outline.slice(-120));

console.log('\n[3] 闸门按路径身份');
const body = path.join(MEM, 'pl-perm.md');
eq('read 正文（大写盘符）', await gate(state, 'read', { file_path: body }), 'deny');
eq('read 正文（小写盘符，旧版可绕过）', await gate(state, 'read', { file_path: body.toLowerCase() }), 'deny');
eq('read 正文（.. 绕行）', await gate(state, 'read', { file_path: path.join(MEM, '.tidy', '..', 'pl-perm.md') }), 'deny');
eq('read .tidy/status.json（旧版被拦）', await gate(state, 'read', { file_path: path.join(TIDY, 'status.json') }), 'pass');
eq('read 索引 MEMORY.md', await gate(state, 'read', { file_path: path.join(MEM, 'MEMORY.md') }), 'pass');
eq('grep 仓库根', await gate(state, 'grep', { path: MEM }), 'deny');
eq('grep 正文文件', await gate(state, 'grep', { path: body }), 'deny');
eq('grep 索引', await gate(state, 'grep', { path: path.join(MEM, 'MEMORY.md') }), 'pass');
eq('glob 仓库根', await gate(state, 'glob', { path: MEM }), 'deny');
eq('read 仓库外文件', await gate(state, 'read', { file_path: path.join(HOME, 'automation.env') }), 'pass');

console.log('\n[4] status 单一事实源 + BOM 宽容');
let r = await call(state, '/dsh-memory/status');
eq('初始 ok', r.body.state, 'ok');
eq('初始 files=13（12 条 + 索引）', r.body.files, 13);
eq('初始 count=0', r.body.count, 0);

// PowerShell 5.1 写的 status.json 带 BOM
fs.writeFileSync(
  path.join(TIDY, 'status.json'),
  `\uFEFF${JSON.stringify({ lastRun: '2026-10-27T13:58:34+08:00', result: 'ok', detail: '' })}`,
  'utf8',
);
r = await call(state, '/dsh-memory/status');
eq('BOM 也能读出 lastRun', r.body.lastRun, '2026-10-27T13:58:34+08:00');
eq('BOM 文件仍判 ok', r.body.state, 'ok');

// proposed/ 有方案，但 status.json 还停在上次的 ok —— 状态必须跟着磁盘走
fs.writeFileSync(path.join(PROPOSED, 'pl-perm.md'), '拟改后的正文\n', 'utf8');
r = await call(state, '/dsh-memory/status');
eq('方案出现即 pending（不依赖 status.json 回写）', r.body.state, 'pending');
eq('count 现算=1', r.body.count, 1);
eq('proposal 带原文与新文', r.body.proposal.files[0].file, 'pl-perm.md');
ok('proposal 带前后字数', r.body.proposal.files[0].beforeCount > 0 && r.body.proposal.files[0].afterCount > 0, JSON.stringify({ b: r.body.proposal.files[0].beforeCount, a: r.body.proposal.files[0].afterCount }));
eq('proposal 标记有改动', r.body.proposal.files[0].same, false);
const stamp = r.body.entries[0].params.find((p) => p.label === '创建');
ok('参数里有精确到秒的创建时间', Boolean(stamp && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp.value)), stamp && stamp.value);
const stamp2 = r.body.entries[0].params.find((p) => p.label === '更新');
ok('参数里有精确到秒的更新时间', Boolean(stamp2 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp2.value)), stamp2 && stamp2.value);

// 批准后不写 status.json，也要能回到 ok
r = await call(state, '/dsh-memory/approve-file', { file: 'pl-perm.md' });
eq('批准后回到 ok', r.body.state, 'ok');
eq('批准后 count=0', r.body.count, 0);
ok('原文件被覆盖', fs.readFileSync(body, 'utf8').includes('拟改后的正文'));
const permRow = fs
  .readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8')
  .split(/\r?\n/)
  .find((l) => l.includes('`pl-perm.md`'));
eq('复核日刷新为今天', (permRow.split('|')[6] || '').trim(), new Date().toLocaleDateString('sv-SE'));

fs.writeFileSync(
  path.join(TIDY, 'status.json'),
  JSON.stringify({ lastRun: 'bad', result: 'failed', detail: '模型超时' }),
  'utf8',
);
r = await call(state, '/dsh-memory/status');
eq('失败态透传', r.body.state, 'failed');
eq('失败原因透传', r.body.detail, '模型超时');

console.log('\n[5] 首关键词硬约束');
const write = state.tools.get('memory_write');
ok(
  '教训关键词要求写场景而不是症状名',
  /不要写 400、422/.test(write.description) && /犯这个错之前/.test(write.description),
  write.description.slice(0, 80),
);
ok('教训正文要求写场景/链条/修复三段', /错误链条/.test(write.description) && /绕开与修复/.test(write.description));
const mk = (keywords) => ({ name: 'tmp-check', keywords, description: '自检用', body: '自检正文' });
let threw = '';
try {
  write.execute(mk('身份/张三'));
} catch (err) {
  threw = err.message;
}
ok('无分类被拒', /不是合法分类/.test(threw), threw);
threw = '';
try {
  write.execute(mk('项目记忆/自检'));
} catch (err) {
  threw = err.message;
}
ok('项目记忆 被拒（只能手动）', /只能由用户点/.test(threw), threw);
const wrote = write.execute(mk('教训/自检'));
ok('合法分类放行', /已记下/.test(wrote.text));
const update = state.tools.get('memory_update');
threw = '';
try {
  update.execute({ name: 'tmp-check', keywords: '乱七八糟/自检' });
} catch (err) {
  threw = err.message;
}
ok('memory_update 改关键词也校验', /不是合法分类/.test(threw), threw);

// 正文长度：2000 字以内静默，超过只提一句（用户口径 2026-10-28：别用「警告」把人吓短）
const shortBody = write.execute({ name: 'len-short', keywords: '其它/长度自检', description: '自检', body: '甲'.repeat(600) });
ok('600 字静默', !/建议长度/.test(shortBody.text), shortBody.text.slice(-60));
const longBody = write.execute({ name: 'len-long', keywords: '其它/长度自检', description: '自检', body: '乙'.repeat(2100) });
ok('2100 字只提示不拦截', /建议 2000 字以内/.test(longBody.text), longBody.text.slice(-90));
ok(
  '提示措辞与定稿一致',
  longBody.text.includes('提示：正文略长，排除 YAML 头共 2100 字，建议 2000 字以内。如果正文已足够简洁，可以忽略本提醒。'),
  longBody.text.slice(-90),
);
ok('提示语气放轻（不写警告/超出上限）', !/警告|超出上限/.test(longBody.text), longBody.text.slice(-90));

console.log('\n[6] 回忆统计（轮计数 + 回忆率）');
const userTurn = () => {
  for (const cb of state.sessionHandlers) cb({ id: 's' }, { type: 'user/message', data: { source: { kind: 'user' } } });
};
const foreignEvent = (source, type = 'user/message') => {
  for (const cb of state.sessionHandlers) cb({ id: 's' }, { type, data: { source } });
};
for (let i = 0; i < 4; i += 1) userTurn();
r = await call(state, '/dsh-memory/status');
eq('轮计数=4（人类消息每发一条算一轮）', r.body.turns, 4);
eq('窗口=4', r.body.windowTurns, 4);
// 子代理 / goal 自动续轮 / 别的会话事件都不算
foreignEvent({ kind: 'agent' });
foreignEvent({ kind: 'goal', goalId: 'g' });
foreignEvent({ kind: 'user' }, 'tool/result');
r = await call(state, '/dsh-memory/status');
eq('非人类轮不计入', r.body.turns, 4);
const read = state.tools.get('memory_read');
read.execute({ file: 'pl-mcd' });
// 读的那一下就算在**当前轮**（用户发一次消息 = 一轮，不是一次工具调用）
r = await call(state, '/dsh-memory/status');
eq('窗口=4（按已完成的 4 轮算）', r.body.windowTurns, 4);
const mcdNow = r.body.entries.find((e) => e.file === 'pl-mcd.md');
eq('读完当轮就计数：1/4 = 25%', mcdNow.recallRate, 25);
// 同一轮再读一次，仍然只算一轮
read.execute({ file: 'pl-mcd' });
r = await call(state, '/dsh-memory/status');
eq('同轮重复读不重复计数', r.body.entries.find((e) => e.file === 'pl-mcd.md').recallRate, 25);
// 又发一条人类消息 → 第 5 轮，1/5 = 20%
userTurn();
r = await call(state, '/dsh-memory/status');
eq('轮计数=5', r.body.turns, 5);
const mcd = r.body.entries.find((e) => e.file === 'pl-mcd.md');
eq('回忆率 = 1/5 = 20%', mcd.recallRate, 20);
const btw = r.body.entries.find((e) => e.file === 'pl-btw.md');
eq('没回忆过 = 0%', btw.recallRate, 0);

console.log('\n[6b] 记忆调用流水（供「记忆」视图）');
const runPost = (name, args, sessionId) =>
  state.post[0](
    { name, arguments: args, agent: { session: { id: sessionId } } },
    { content: [] },
    async () => ({ kind: 'accept', content: [] }),
  );
await runPost('memory_read', { file: 'pl-mcd' }, 'sess-a');
await runPost('memory_write', { name: 'tmp-call', keywords: '其它/自检', description: 'x', body: '一二三四五' }, 'sess-a');
await runPost('memory_read', { file: 'pl-btw' }, 'sess-b');
const callsA = await call(state, '/dsh-memory/calls?sessionId=sess-a');
eq('只回本会话的调用', callsA.body.calls.length, 2);
ok('时间正序：老记录在前、新记录在后', callsA.body.calls[0].op === 'read' && callsA.body.calls[1].op === 'write', JSON.stringify(callsA.body.calls.map((c) => c.op)));
ok('读的记录带关键词', /说明书/.test((callsA.body.calls.find((c) => c.op === 'read') || {}).keywords || ''));
eq('写的记录带字数', (callsA.body.calls.find((c) => c.op === 'write') || {}).chars, 5);
ok('列表不回正文（省流量）', callsA.body.calls.every((c) => c.content === undefined), JSON.stringify(Object.keys(callsA.body.calls[0] || {})));
const writeRow = callsA.body.calls.find((c) => c.op === 'write');
const oneCall = await call(state, `/dsh-memory/call?id=${encodeURIComponent(writeRow.id)}`);
eq('详情能取到真正写入的正文', oneCall.body.call.content, '一二三四五');
ok('详情带操作类型与目标', oneCall.body.call.op === 'write' && oneCall.body.call.target === 'tmp-call', JSON.stringify(oneCall.body.call.target));
const missingCall = await call(state, '/dsh-memory/call?id=nope');
eq('不存在的详情报 404', missingCall.code, 404);
const callsAll = await call(state, '/dsh-memory/calls');
eq('不带会话时回全部', callsAll.body.calls.length, 3);

console.log('\n[7] 设置页新建 / 删除');
const mdCountBefore = fs.readdirSync(MEM).filter((f) => f.endsWith('.md')).length;
r = await call(state, '/dsh-memory/create', {
  name: 'tmp-new',
  keywords: '资料/自检/新建',
  description: '自检新建用',
  body: '这是新建的正文。',
});
eq('新建成功', r.body.created, 'tmp-new.md');
ok('文件已建', fs.existsSync(path.join(MEM, 'tmp-new.md')));
ok('索引行已补', fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8').includes('`tmp-new.md`'));
ok('大纲出现新条目', r.body.outline.includes('tmp-new='));
eq('文件数 +1（不写死总数，免得前面新增用例就红）', r.body.files, mdCountBefore + 1);

r = await call(state, '/dsh-memory/create', { name: 'tmp-new', keywords: '资料/x', description: 'x', body: 'x' });
eq('重名拒绝', r.code, 400);
r = await call(state, '/dsh-memory/create', { name: 'tmp-bad', keywords: '瞎写/x', description: 'x', body: 'x' });
eq('非法分类拒绝', r.code, 400);
ok('失败不留孤儿文件', !fs.existsSync(path.join(MEM, 'tmp-bad.md')));
r = await call(state, '/dsh-memory/create', { name: 'tmp-proj', keywords: '项目记忆/自检项目', description: '项目收尾', body: '项目正文' });
eq('人工通道可建「项目记忆」', r.body.created, 'tmp-proj.md');

r = await call(state, '/dsh-memory/delete', { file: 'user-profile.md' });
eq('锁定的拒绝删除', r.code, 400);
ok('锁定提示说清原因', /已锁定/.test(r.body.error), r.body.error);
r = await call(state, '/dsh-memory/delete', { file: 'tmp-proj.md' });
eq('能删自己建的', r.body.deleted?.file, 'tmp-proj.md');
eq('普通删除不标 ghost', r.body.deleted?.ghost, false);
ok('文件已删', !fs.existsSync(path.join(MEM, 'tmp-proj.md')));
ok('索引行已删', !fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8').includes('`tmp-proj.md`'));
r = await call(state, '/dsh-memory/delete', { file: 'tmp-proj.md' });
eq('删不存在的拒绝', r.code, 400);

// 文件被外部删掉、索引行还在：这条死行必须删得掉（否则永远钉在面板上）
r = await call(state, '/dsh-memory/create', { name: 'tmp-ghost', keywords: '其它/自检', description: 'x', body: 'x' });
eq('死行探针已建', r.body.created, 'tmp-ghost.md');
fs.unlinkSync(path.join(MEM, 'tmp-ghost.md'));
r = await call(state, '/dsh-memory/status');
const ghostRow = r.body.entries.find((e) => e.file === 'tmp-ghost.md');
eq('面板能认出「文件已丢失」', ghostRow && ghostRow.missing, true);
r = await call(state, '/dsh-memory/delete', { file: 'tmp-ghost.md' });
eq('死行能删掉', r.code, 200);
eq('回包标出这是死行', r.body.deleted?.ghost, true);
ok('索引行已清', !fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8').includes('`tmp-ghost.md`'));

// 索引写不进去时必须把已建的文件撤回，不留孤儿
const indexBackup = fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8');
fs.writeFileSync(path.join(MEM, 'MEMORY.md'), '# 记忆索引\n\n没有表格\n', 'utf8');
r = await call(state, '/dsh-memory/create', { name: 'tmp-orphan', keywords: '资料/自检', description: 'x', body: 'x' });
eq('索引缺失时新建失败', r.code, 400);
ok('失败已撤回文件（不留孤儿）', !fs.existsSync(path.join(MEM, 'tmp-orphan.md')));
let writeErr = '';
try {
  write.execute({ name: 'tmp-orphan2', keywords: '资料/自检', description: 'x', body: 'x' });
} catch (err) {
  writeErr = err.message;
}
ok('memory_write 同样撤回文件', /已撤回文件/.test(writeErr) && !fs.existsSync(path.join(MEM, 'tmp-orphan2.md')), writeErr);
fs.writeFileSync(path.join(MEM, 'MEMORY.md'), indexBackup, 'utf8');

console.log('\n[8] 设置页搜索');
r = await call(state, '/dsh-memory/search', { q: '麦当劳' });
eq('关键词命中一条', r.body.matches.length, 1);
eq('命中文件正确', r.body.matches[0].file, 'pl-mcd.md');
ok('给出关键词片段', r.body.matches[0].snippets.some((s) => s.kind === 'keywords'));
r = await call(state, '/dsh-memory/search', { q: 'BOM' });
ok('正文命中给原文附近几行', r.body.matches.length >= 3, `命中 ${r.body.matches.length} 条`);
const bomHit = r.body.matches.find((m) => m.file === 'pl-teach.md') || r.body.matches[0];
const bodySnip = bomHit.snippets.find((s) => s.kind === 'body');
ok('片段带行号', Boolean(bodySnip && bodySnip.line >= 1), JSON.stringify(bodySnip));
ok('片段包含命中词', Boolean(bodySnip && /BOM/i.test(bodySnip.text)));
r = await call(state, '/dsh-memory/search', { q: '绝对搜不到的词' });
eq('搜不到就是空', r.body.matches.length, 0);

console.log('\n[9] 压缩流水线（每 100 轮 / 沙漏 / 报审 / 中断标记）');
const realFetch = globalThis.fetch;
let compressCalls = 0;
let sawThinking = null;
let sawModel = null;
let sawResponseFormat = null;
globalThis.fetch = async (url, opts) => {
  compressCalls += 1;
  const request = JSON.parse(opts.body);
  sawThinking = request.thinking;
  sawModel = request.model;
  sawResponseFormat = request.response_format;
  const memories = JSON.parse(request.messages[1].content).memories;
  // 按档位造改稿：轻调整压到 85%，中删减压到 60%，都落在目标区间
  const factor = request.messages[0].content.includes('轻调整器') ? 0.85 : 0.6;
  const items = memories.map((m) => ({
    file: m.file,
    body: m.body.slice(0, Math.max(60, Math.floor(Array.from(m.body).length * factor))),
  }));
  const content = JSON.stringify({ items });
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  };
};

r = await call(state, '/dsh-memory/compress', {});
eq('沙漏按钮能起跑', r.body.started, true);
for (let i = 0; i < 60; i += 1) {
  const st = fs.existsSync(path.join(TIDY, 'compress.json'))
    ? JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'))
    : null;
  if (st && st.finishedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const compressState = JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'));
ok('压缩跑完并记账', Boolean(compressState.finishedAt), JSON.stringify(compressState));
eq('压缩显式关掉思考', sawThinking && sawThinking.type, 'disabled');
eq('模型用官方 ID deepseek-flash', sawModel, 'deepseek-flash');
eq('用 json_object 保证回包是 JSON', sawResponseFormat && sawResponseFormat.type, 'json_object');
ok('至少一组请求', compressCalls >= 1, `${compressCalls} 次`);
eq('高频/锁定不送模型', compressState.files.includes('user-profile.md'), false);
r = await call(state, '/dsh-memory/status');
eq('状态里 running=false', r.body.compress.running, false);
eq('状态里 interrupted=false', r.body.compress.interrupted, false);
ok('改稿进了 proposed/', r.body.compress.files.length > 0 && fs.existsSync(path.join(PROPOSED, r.body.compress.files[0])));
const proposalRaw = fs.readFileSync(path.join(PROPOSED, r.body.compress.files[0]), 'utf8');
ok('方案只存正文（不带 YAML 头）', !proposalRaw.startsWith('---'));
const approvedFile = r.body.compress.files[0];
const before = fs.readFileSync(path.join(MEM, approvedFile), 'utf8');
eq('批准前有 description', /description:/.test(before), true);
r = await call(state, '/dsh-memory/approve-file', { file: approvedFile });
ok('批准成功', r.code === 200);
const after = fs.readFileSync(path.join(MEM, approvedFile), 'utf8');
ok('批准后 YAML 头（含 description）还在', /description:/.test(after), after.slice(0, 120));
ok('正文被改稿覆盖', after.length < before.length);

// 只字未动的改稿不该提审：清空 pending，让模型原样返回
for (const f of fs.readdirSync(PROPOSED)) fs.unlinkSync(path.join(PROPOSED, f));
globalThis.fetch = async (url, opts) => {
  const request = JSON.parse(opts.body);
  const memories = JSON.parse(request.messages[1].content).memories;
  const content = JSON.stringify({ items: memories.map((m) => ({ file: m.file, body: m.body })) });
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content } }] }); } };
};
r = await call(state, '/dsh-memory/compress', {});
for (let i = 0; i < 60; i += 1) {
  const st = fs.existsSync(path.join(TIDY, 'compress.json'))
    ? JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'))
    : null;
  if (st && st.finishedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const noopState = JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'));
eq('原样返回不提审', noopState.files.length, 0);
ok('说明里点出「未动」', /未动/.test(noopState.detail), noopState.detail);
eq('proposed/ 里没有空方案', fs.readdirSync(PROPOSED).length, 0);

// 改了字但几乎等长（缩减不到 3%）：不该占待审列表
globalThis.fetch = async (url, opts) => {
  const request = JSON.parse(opts.body);
  const memories = JSON.parse(request.messages[1].content).memories;
  const content = JSON.stringify({
    items: memories.map((m) => ({ file: m.file, body: `${m.body}。` })),
  });
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content } }] }); } };
};
if (fs.existsSync(path.join(TIDY, 'compress.json'))) fs.unlinkSync(path.join(TIDY, 'compress.json'));
r = await call(state, '/dsh-memory/compress', {});
for (let i = 0; i < 60; i += 1) {
  const st = fs.existsSync(path.join(TIDY, 'compress.json'))
    ? JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'))
    : null;
  if (st && st.finishedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const noopState2 = JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'));
eq('几乎等长不提审', noopState2.files.length, 0);
ok('说明里点出「几乎未缩短」', /几乎未缩短/.test(noopState2.detail), noopState2.detail);
eq('proposed/ 仍然空', fs.readdirSync(PROPOSED).length, 0);

// 偏长：同一档位的下一轮必须在同一条对话里带着反馈重压（前缀缓存靠这条链）
const chainLengths = [];
let attemptNo = 0;
globalThis.fetch = async (url, opts) => {
  const request = JSON.parse(opts.body);
  chainLengths.push(request.messages.length);
  attemptNo += 1;
  const memories = JSON.parse(request.messages[1].content).memories;
  const light = request.messages[0].content.includes('轻调整器');
  // 第一次按原样返回（100%，偏长）；第二次才压到目标区间
  const factor = request.messages.length <= 2 ? 1 : light ? 0.85 : 0.6;
  const content = JSON.stringify({
    items: memories.map((m) => ({ file: m.file, body: m.body.slice(0, Math.max(60, Math.floor(Array.from(m.body).length * factor))) })),
  });
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content } }] }); } };
};
if (fs.existsSync(path.join(TIDY, 'compress.json'))) fs.unlinkSync(path.join(TIDY, 'compress.json'));
r = await call(state, '/dsh-memory/compress', {});
for (let i = 0; i < 60; i += 1) {
  const st = fs.existsSync(path.join(TIDY, 'compress.json'))
    ? JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'))
    : null;
  if (st && st.finishedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const retried = JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'));
ok('偏长会触发重压', attemptNo >= 2, `${attemptNo} 次请求`);
ok('重压在同一个对话里（messages 链变长）', chainLengths.some((n) => n >= 4), chainLengths.join(','));
ok('重压后出了方案', retried.files.length > 0, retried.detail);
for (const f of fs.readdirSync(PROPOSED)) fs.unlinkSync(path.join(PROPOSED, f));

// 思考把输出预算吃光、回包只有 reasoning 没有正文：必须自动显式关掉思考重跑
let compAttempts = 0;
const thinkings = [];
const batchSizes = [];
let sawMaxTokens = 0;
globalThis.fetch = async (url, opts) => {
  const req = JSON.parse(opts.body);
  compAttempts += 1;
  sawMaxTokens = req.max_tokens;
  thinkings.push(req.thinking);
  batchSizes.push(JSON.parse(req.messages[1].content).memories.length);
  if (compAttempts === 1) {
    // 第一次：finish=stop 但正文是空的（实测就是这个样子）
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: '我想想……' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 3140, completion_tokens_details: { reasoning_tokens: 3140 } },
        });
      },
    };
  }
  const memories = JSON.parse(req.messages[1].content).memories;
  const factor = req.messages[0].content.includes('轻调整器') ? 0.85 : 0.6;
  const content = JSON.stringify({
    items: memories.map((m) => ({ file: m.file, body: m.body.slice(0, Math.max(60, Math.floor(Array.from(m.body).length * factor))) })),
  });
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }); } };
};
r = await call(state, '/dsh-memory/compress', {});
for (let i = 0; i < 60; i += 1) {
  const st = fs.existsSync(path.join(TIDY, 'compress.json'))
    ? JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8'))
    : null;
  if (st && st.finishedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
ok('空正文回包会自动重跑', compAttempts >= 2, `${compAttempts} 次请求`);
ok('每次请求都显式关掉思考（不传字段 ≠ 关闭）', thinkings.every((t) => t?.type === 'disabled'), JSON.stringify(thinkings));
eq('每次请求都显式给足 max_tokens', sawMaxTokens, 8192);
ok('分批送，单批不超过 4 份', batchSizes.every((n) => n <= 4), batchSizes.join(','));
ok('重跑后照样出方案', JSON.parse(fs.readFileSync(path.join(TIDY, 'compress.json'), 'utf8')).files.length > 0);
for (const f of fs.readdirSync(PROPOSED)) fs.unlinkSync(path.join(PROPOSED, f));

// 上次压缩被关掉：只有 startedAt
fs.writeFileSync(
  path.join(TIDY, 'compress.json'),
  JSON.stringify({ startedAt: new Date(Date.now() - 3600_000).toISOString(), stage: 'request', files: [] }),
  'utf8',
);
r = await call(state, '/dsh-memory/status');
eq('中断可见', r.body.compress.interrupted, true);
eq('中断时 running=false', r.body.compress.running, false);
globalThis.fetch = realFetch;

console.log('\n[10] /remember 命令（宿主自己发请求，不再往会话注入消息）');
ok('不再注册宿主命令（改客户端 action）', state.commands.size === 0, [...state.commands.keys()].join(','));
eq('会话里不产生 followup 注入', state.followups.length, 0);

state.commands.size;
// 桩掉模型：/remember 后台自己发请求，这里只验请求体与落盘
let askedBody = null;
const rememberArgs = {
  name: 'dsh-memory',
  keywords: '项目记忆/dsh-memory/压缩/闸门',
  description: '接手 dsh-memory 相关工作时读',
  body: '- 工作剖面：在 C:\\DSHprojects\\dsh-memory 维护记忆插件\n- 项目目标：修闸门与压缩\n- 产物：index.js/client.js\n- 待办：验证重启后效果\n- 风险：别把 followup 写法带回会话',
};
// 桩掉模型：兜底路径也走 function calling，回包里给的是 tool_calls 而不是正文 JSON
globalThis.fetch = async (url, opts) => {
  askedBody = JSON.parse(opts.body);
  const tool_calls = [
    { id: 'call_1', type: 'function', function: { name: 'memory_write', arguments: JSON.stringify(rememberArgs) } },
  ];
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: '', tool_calls } }] }); } };
};
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-1' });
eq('路由返回 200', r.code, 200);
eq('返回文件名', r.body.file, 'dsh-memory.md');
ok('返回正文字数', Number.isFinite(r.body.chars) && r.body.chars > 0, String(r.body.chars));
ok('返回当时的轮计数（供前端判断下一轮）', Number.isFinite(r.body.turns), String(r.body.turns));
ok('请求体里带转录（用户 + 助手）', /用户：帮我修一下/.test(askedBody.messages[1].content) && /助手：闸门改成/.test(askedBody.messages[1].content));
ok('子代理的提示没进转录', !/子代理的提示不该进转录/.test(askedBody.messages[1].content));
eq('推理强度 low（thinking 子对象）', askedBody.thinking && askedBody.thinking.reasoning_effort, 'low');
eq('/remember 也用 flash', askedBody.model, 'deepseek-flash');
// 关键回归：记忆靠工具参数写入，而不是让模型在正文里手写 JSON
eq('兜底也递 memory_write 工具声明', askedBody.tools?.[0]?.function?.name, 'memory_write');
eq('tool_choice 点名 memory_write', askedBody.tool_choice?.function?.name, 'memory_write');
ok('工具声明带四个必填字段', ['name', 'keywords', 'description', 'body'].every((k) => askedBody.tools[0].function.parameters.required.includes(k)));
ok('不再要求 response_format=json_object', askedBody.response_format === undefined, JSON.stringify(askedBody.response_format));
ok('文件已落盘', fs.existsSync(path.join(MEM, 'dsh-memory.md')));
const remembered = fs.readFileSync(path.join(MEM, 'dsh-memory.md'), 'utf8');
ok('正文分条列写', /工作剖面/.test(remembered) && /风险/.test(remembered));
ok('索引行首关键词是项目记忆', /\| `dsh-memory\.md` \| 项目记忆\//.test(fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8')));
// 撞名：同一项目再记一次 → 加序号，不覆盖
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-1' });
ok('撞名自动加序号', r.code === 200 && fs.existsSync(path.join(MEM, 'dsh-memory-2.md')), JSON.stringify(r.body));
// 没有可记内容 / 会话不存在
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-empty' });
eq('空对话报 400', r.code, 400);
ok('空对话说清原因', /没有可记的内容/.test(r.body.error), r.body.error);
r = await call(state, '/dsh-memory/remember', { sessionId: 'no-such' });
eq('会话不存在报 404', r.code, 404);
// 模型给的首关键词不是项目记忆时，强制补上
globalThis.fetch = async () => {
  const tool_calls = [
    {
      id: 'call_wild',
      type: 'function',
      function: { name: 'memory_write', arguments: JSON.stringify({ name: 'wild', keywords: '资料/随便', description: 'x', body: '- 工作剖面：x' }) },
    },
  ];
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: '', tool_calls } }] }); } };
};
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-1' });
ok('首关键词被强制成项目记忆', /\| `wild\.md` \| 项目记忆\//.test(fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8')));

// 主 agent 自己写：走 DSH 的 llm 服务 + memory_write 工具声明，不写会话、不发 HTTP
let httpCalls = 0;
globalThis.fetch = async () => {
  httpCalls += 1;
  throw new Error('不该发 HTTP');
};
// 工具参数是分片流回来的，这里故意切成三段，验拼装
const toolCallChunks = (args) => {
  const chars = Array.from(args);
  const a = chars.slice(0, 20).join('');
  const b = chars.slice(20).join('');
  return [
    { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'memory_write', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: a },
    { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: b },
  ];
};
state.llm = {
  stream: async function* (options) {
    state.llmOptions = options;
    const args = JSON.stringify({ name: 'ctx-agent', keywords: '项目记忆/ctx-agent/上下文', description: 'x', body: '- 工作剖面：主 agent 自己写' });
    for (const chunk of toolCallChunks(args)) yield chunk;
  },
};
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-llm' });
eq('走 llm 服务也能成功', r.code, 200);
eq('没有走外网 HTTP', httpCalls, 0);
eq('复用主 agent 的消息前缀（system + history + 指令）', state.llmOptions.messages.length, 3);
ok('前缀第一条是主 agent 的 system', state.llmOptions.messages[0].role === 'system');
ok('末尾追加的是隐藏指令', /记忆插件·隐藏指令/.test(state.llmOptions.messages[2].content[0].text));
eq('把 memory_write 的工具声明递过去', state.llmOptions.tools?.[0]?.name, 'memory_write');
ok('工具参数即 JSON Schema（模型填空，不手写 JSON）', state.llmOptions.tools[0].parameters.required.includes('body'));
ok('不再要求 responseFormat=json_object', state.llmOptions.responseFormat === undefined);
eq('带上会话 id（共享前缀缓存）', state.llmOptions.sessionId, 'sess-llm');
ok('文件落盘', fs.existsSync(path.join(MEM, 'ctx-agent.md')));
ok('分片参数拼回完整正文', /工作剖面/.test(fs.readFileSync(path.join(MEM, 'ctx-agent.md'), 'utf8')));

// llm 服务抛错时要退回独立请求，并把原因写进 plugin-error.log
globalThis.fetch = async () => {
  const tool_calls = [
    {
      id: 'call_fb',
      type: 'function',
      function: { name: 'memory_write', arguments: JSON.stringify({ name: 'fallback-agent', keywords: '项目记忆/fallback-agent/兜底', description: 'x', body: '- 工作剖面：退回独立请求' }) },
    },
  ];
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: '', tool_calls } }] }); } };
};
state.llm = {
  stream: () => {
    throw new Error('llm boom');
  },
};
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-llm' });
eq('llm 抛错时退回 HTTP 仍成功', r.code, 200);
ok('兜底产物落盘', fs.existsSync(path.join(MEM, 'fallback-agent.md')));
ok('降级原因写进 plugin-error.log', fs.existsSync(path.join(TIDY, 'plugin-error.log')) && /llm\.stream/.test(fs.readFileSync(path.join(TIDY, 'plugin-error.log'), 'utf8')));

// 主 agent 第一次不调工具、第二次才调：应当自动重试成功
let askCalls = 0;
state.llm = {
  stream: async function* () {
    askCalls += 1;
    if (askCalls === 1) {
      yield { type: 'text-delta', text: '好的，我来总结一下这段对话。' };
      return;
    }
    const args = JSON.stringify({ name: 'retry-tool', keywords: '项目记忆/retry-tool', description: 'x', body: '- 工作剖面：重试成功' });
    for (const chunk of toolCallChunks(args)) yield chunk;
  },
};
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-llm' });
eq('散文→工具调用的重试能成功', r.code, 200);
eq('确实问了两次', askCalls, 2);
ok('重试产物落盘', fs.existsSync(path.join(MEM, 'retry-tool.md')));

// 主 agent 两次都不调工具：退回独立请求，仍然靠工具参数写入
globalThis.fetch = async () => {
  const tool_calls = [
    {
      id: 'call_fb2',
      type: 'function',
      function: { name: 'memory_write', arguments: JSON.stringify({ name: 'http-fallback', keywords: '项目记忆/http-fallback', description: 'x', body: '- 工作剖面：兜底' }) },
    },
  ];
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: '', tool_calls } }] }); } };
};
state.llm = {
  stream: async function* () {
    yield { type: 'text-delta', text: '我还是用中文解释一下比较好。' };
  },
};
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-llm' });
eq('两次都不调工具时退回独立请求', r.code, 200);
ok('兜底产物落盘（http-fallback）', fs.existsSync(path.join(MEM, 'http-fallback.md')));

// 兜底也不调工具：说清是「没调工具」，不再报「模型没有返回 JSON」
globalThis.fetch = async () => {
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: '我用文字解释一下。' } }] }); } };
};
r = await call(state, '/dsh-memory/remember', { sessionId: 'sess-llm' });
eq('全都失败时报 400', r.code, 400);
ok('错误指向「没有调用 memory_write 工具」', /没有调用 memory_write/.test(r.body.error), r.body.error);
state.llm = undefined;state.llm = undefined;state.llm = undefined;
globalThis.fetch = realFetch;

console.log(`\n结果：${pass} 通过，${fails.length} 失败`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
}
// 清理临时目录：只删自己 mkdtemp 出来的那个。
try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* 删不掉就算了，临时目录系统会清 */
}
