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
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 路径里可能有空格（如 `C:\DSH Plugin\...`）：必须走 fileURLToPath，
// 直接取 URL.pathname 会留下 %20，再套 pathToFileURL 就变成 %2520。
const HERE = path.dirname(fileURLToPath(import.meta.url));
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
// 待删除判决的观察期默认 100 轮；自检里把观察期压到 1 轮，才能测到「刚被看见的条目不算待删除」。
process.env.MEMORY_JUDGE_TURNS = '1';
// 自检绝不联网：强制走「没有 embedding Key」的降级分支
process.env.DSH_MEMORY_NO_EMBED = '1';

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

/** 跑一遍 post-execute 链：返回最终 decision（可能被追加了 content）。 */
async function afterTool(state, name, args, result = { content: [] }) {
  let decision = { kind: 'accept', content: result.content || [] };
  for (const handler of state.post) {
    const prev = decision;
    decision = await handler({ name, arguments: args }, result, async () => prev);
  }
  return decision;
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

const mod = await import(pathToFileURL(path.join(PKG, 'index.js')).href);
const { apply } = mod;
const T = mod.__test; // 压缩流水线的纯函数：预算、工具声明、回包解析

const agent = { id: 'selfcheck-root' };
const { ctx, state } = makeCtx(agent);
apply(ctx);

console.log(`\n[1] 装载面  DSH_HOME=${HOME}`);
eq('两段系统提示注入', state.sections.length, 2);
ok('注入顺序 outline < tidy-status', state.sections[0].name === 'memory:outline' && state.sections[1].name === 'memory:tidy-status');
eq('八个模型工具', [...state.tools.keys()].sort().join(','), 'memory_delete,memory_organize,memory_read,memory_reindex,memory_search,memory_source,memory_update,memory_write');
eq('十九条路由（含 /remember、保留、口径控制、提示词检视、重建索引、调用流水/详情与探针）', state.routes.size, 19);

console.log('\n[2] 大纲不丢条目');
const outline = state.sections[0].text();
const names = [...outline.matchAll(/([\w-]+)=/g)].map((m) => m[1]);
eq('12 条全在', names.length, 12);
ok('最后一条 huashu-motion-install 在', names.includes('huashu-motion-install'), `大纲 ${Array.from(outline).length} 字`);
ok('教训排最前（动手前先对场景）', names[0] === 'noahs-ark', names.slice(0, 3).join(','));
const longSeg = outline.split(' · ').find((s) => s.startsWith('huashu-motion-install='));
ok('40 字关键词整段保留', !longSeg.includes('…'), longSeg);
const plMem = outline.split(' · ').find((s) => s.startsWith('pl-mem='));
ok(
  '摘要整句进大纲，不切半截',
  !plMem.includes('…') && Array.from(plMem.slice('pl-mem='.length)).length <= 45,
  plMem,
);

// 有「教训/」条目时，大纲必须自带「什么场景该点开」+ 末尾前置检查：
// 召回率不靠模型自觉，靠索引里写清场景钩子。
ok('大纲开头写清关键词是场景钩子', /什么场景下必须点开/.test(outline) && /动手改 \/ 删 \/ 装 \/ 跑命令之前/.test(outline));
ok('大纲提示可一次读多条', /可一次传多个/.test(outline));
ok('大纲带教训前置检查', /命中就先 memory_read 读完，再动手/.test(outline), outline.slice(-120));

// 索引表允许手改：有人会写 `;`、`·`、`,` 当分隔符，混进表里会让分类解析错位。
{
  const indexPath = path.join(MEM, 'MEMORY.md');
  const before = fs.readFileSync(indexPath, 'utf8');
  const dirty = '| `dirty-sep.md` | 说明书/记忆插件;关键说明 · 读写记忆必读 | 是 | reference | 手写的脏分隔符。 | 2026-11-13 | 否 |';
  fs.writeFileSync(indexPath, `${before}${dirty}\n`, 'utf8');
  fs.writeFileSync(
    path.join(MEM, 'dirty-sep.md'),
    '---\nname: dirty-sep\ndescription: 脏分隔符自检。\ntype: reference\n---\n\n自检正文。\n',
    'utf8',
  );
  const snap = await call(state, '/dsh-memory/status');
  const row = (snap.body.entries || []).find((e) => e.file === 'dirty-sep.md');
  eq('脏分隔符（; · ,）读成 /', row?.keywords, '说明书/记忆插件/关键说明/读写记忆必读');
  ok('归一后大纲里也是 / 分隔', /dirty-sep=记忆插件\/关键说明\/读写记忆必读/.test(snap.body.outline));
  fs.writeFileSync(indexPath, before, 'utf8');
  fs.rmSync(path.join(MEM, 'dirty-sep.md'), { force: true });
}

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
  '关键词提示要求写成短钩子（不是句子）',
  /什么场景下必须点开这条/.test(write.description) &&
    /每段 ≤10 字/.test(write.description) &&
    /像标题党一样/.test(write.description) &&
    /空泛词/.test(write.description),
  write.description.slice(0, 80),
);
ok(
  '教训关键词明确禁止事后症状/错误码',
  /别写错误码和根因/.test(write.description) && /教训\/422|422、报错/.test(write.description),
);
ok(
  'summary 参数写明它是「什么场景下必须点开」的一句话',
  /≤40 字/.test(write.parameters.properties.summary.description) &&
    /什么场景下必须点开/.test(write.parameters.properties.summary.description),
  write.parameters.properties.summary.description,
);
ok(
  'category 参数只认四个分类',
  /资料 \/ 教训 \/ 说明书 \/ 其它/.test(write.parameters.properties.category.description),
  write.parameters.properties.category.description,
);
ok('教训正文要求写场景/链条/修复三段', /错误链条/.test(write.description) && /绕开与修复/.test(write.description));
const mk = (keywords) => ({
  name: 'tmp-check',
  keywords,
  description: '自检用',
  body: '自检正文',
  dup_check: '只比了关键词，跟已有条目无关，新建',
});
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
// 教训关键词的预防性校验：症状名/错误码一律拒，动作短语放行
threw = '';
try {
  write.execute({ name: 'tmp-bad', keywords: '教训/422 报错', description: '自检', body: '自检正文' });
} catch (err) {
  threw = err.message;
}
ok('教训关键词写症状名被拒', /不能写事后症状/.test(threw), threw);
threw = '';
try {
  update.execute({ name: 'tmp-check', keywords: '教训/根因是缺 role' });
} catch (err) {
  threw = err.message;
}
ok('memory_update 同样拦症状名', /不能写事后症状/.test(threw), threw);
ok(
  '被拒时正文没被改（先校验后落盘）',
  fs.readFileSync(path.join(MEM, 'tmp-check.md'), 'utf8').includes('自检正文'),
);
const actOk = write.execute({
  name: 'tmp-act',
  keywords: '教训/批量删除家目录/清理缓存目录',
  description: '自检用',
  body: '自检正文',
  dup_check: '只比了关键词，没有同类删目录的教训，判为无关，新建',
});
ok('动作短语放行', /已记下/.test(actOk.text), actOk.text.slice(0, 60));

// 关键词是钩子不是句子（2026-11-13 用户口径）：段太长、段太多都要拒，并把该砍哪段说清楚。
threw = '';
try {
  write.execute({ name: 'tmp-long', keywords: '教训/批量删除家目录前一定要先看清路径', description: '自检', body: '自检正文', dup_check: '只比了关键词，判为无关，新建' });
} catch (err) {
  threw = err.message;
}
ok('关键词写成长句被拒', /写成句子了/.test(threw) && /10 字/.test(threw), threw);
threw = '';
try {
  write.execute({ name: 'tmp-seg', keywords: '教训/删目录/清缓存/装插件/改配置/卸插件', description: '自检', body: '自检正文', dup_check: '只比了关键词，判为无关，新建' });
} catch (err) {
  threw = err.message;
}
ok('关键词段数超 4 被拒', /最多 4 段/.test(threw), threw);
r = await call(state, '/dsh-memory/keyword', { file: 'pl-mcd.md', summary: '点'.repeat(45) });
eq('设置页改摘要同样拦过长', r.code, 400);
ok('拦住时说的是 40 字上限', /40 字上限/.test(r.body?.error || ''), r.body?.error);
r = await call(state, '/dsh-memory/keyword', { file: 'pl-mcd.md', summary: '说明书/点麦当劳之前先看看有没有券' });
eq('摘要口径改名成功', r.code, 200);
const mcdRow = (r.body?.entries || []).find((e) => e.file === 'pl-mcd.md') || {};
eq('旧写法里的分类被拆到分类列', mcdRow.category, '说明书');
eq('第 2 列只剩摘要本身', mcdRow.summary, '点麦当劳之前先看看有没有券');

// 正文长度：2000 字以内静默，超过只提一句（用户口径 2026-10-28：别用「警告」把人吓短）
const shortBody = write.execute({ name: 'len-short', keywords: '其它/短正文静默', description: '自检', body: '甲'.repeat(600), dup_check: '只比了关键词，判为无关，新建' });
ok('600 字照常写入', /len-short/.test(shortBody.text), shortBody.text.slice(-60));
let tooLong = '';
try {
  write.execute({ name: 'len-long', keywords: '其它/长正文提示', description: '自检', body: '乙'.repeat(2100), dup_check: '只比了关键词，判为无关，新建' });
} catch (err) {
  tooLong = err.message;
}
ok('2.0 起超过 2000 字硬拒写入', /超过 2000 字上限/.test(tooLong), tooLong);
ok('拒绝时给出拆条建议', /拆成两条|附录条目/.test(tooLong), tooLong);
ok('刚好 2000 字能写进去', (() => {
  try {
    write.execute({ name: 'len-edge', keywords: '其它/边界正文', description: '自检', body: '丙'.repeat(2000), dup_check: '只比了关键词，判为无关，新建' });
    return true;
  } catch {
    return false;
  }
})());
// 绕过工具直接写文件时，仍只给一句软提示（那条路不归 memory_write 管）
fs.writeFileSync(path.join(MEM, 'len-long.md'), `---
name: len-long
description: 自检
type: reference
reviewed: ${new Date().toISOString().slice(0, 10)}
---

${'乙'.repeat(2100)}
`, 'utf8');
const oversizeDecision = await afterTool(state, 'write', { file_path: path.join(MEM, 'len-long.md') });
const oversizeHint = (oversizeDecision.content || []).map((c) => c.text || '').join('\n');
ok('直写超长文件只提示不拦', /建议 2000 字以内/.test(oversizeHint), oversizeHint.slice(-90));
ok('提示语气放轻（不写警告/超出上限）', !/警告|超出上限/.test(oversizeHint), oversizeHint.slice(-90));

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

console.log('\n[6a] 一次读多条 + 整体召回率');
const batch = read.execute({ file: 'pl-btw、noahs-ark,pl-mem' });
ok(
  '一次取回三条正文',
  /【记忆：pl-btw】/.test(batch.text) && /【记忆：noahs-ark】/.test(batch.text) && /【记忆：pl-mem】/.test(batch.text),
  batch.text.slice(0, 40),
);
eq('多条之间分段', (batch.text.match(/———/g) || []).length, 2);
const dup2 = read.execute({ file: 'pl-btw、pl-btw' });
eq('同一文件两种叫法只读一次', (dup2.text.match(/【记忆：pl-btw】/g) || []).length, 1);
const partial = read.execute({ file: 'pl-btw、zznope' });
ok('缺的一条汇总在末尾，不整单失败', /没找到：zznope/.test(partial.text) && /【记忆：pl-btw】/.test(partial.text));
let allMiss = '';
try {
  read.execute({ file: 'zznope' });
} catch (err) {
  allMiss = err.message;
}
ok('全都没找到时仍报错', /没有找到记忆/.test(allMiss), allMiss.slice(0, 40));
r = await call(state, '/dsh-memory/status');
const ov = r.body.recall;
ok('整体召回率按轮算', ov && ov.window === 5 && ov.anyTurns === 2, JSON.stringify(ov));
ok('本轮读了 4 条 → 覆盖率 4', ov.covered === 4, JSON.stringify(ov.covered));
ok('教训召回率单独给（第 5 轮读了 noahs-ark）', ov.lessonTurns === 1 && ov.lessonRate === 20, JSON.stringify(ov));

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
const readRow = callsA.body.calls.find((c) => c.op === 'read') || {};
ok('读的记录带摘要', /麦当劳|说明书|记忆插件/.test(String(readRow.keywords || readRow.summary || '')), JSON.stringify({ keywords: readRow.keywords, summary: readRow.summary }));
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

// 一次读多条：早先整串当文件名 → readMemoryBody 抛异常被吞，整条读法在视图里不留痕。
await runPost('memory_read', { file: 'pl-btw、noahs-ark' }, 'sess-c');
const callsC = await call(state, '/dsh-memory/calls?sessionId=sess-c');
eq('一次读多条记成多条流水', callsC.body.calls.length, 2);
ok('批量读的两条都带各自目标', JSON.stringify(callsC.body.calls.map((c) => c.target).sort()) === JSON.stringify(['noahs-ark', 'pl-btw']), JSON.stringify(callsC.body.calls.map((c) => c.target)));
ok('批量读的两条各自带正文', callsC.body.calls.every((c) => typeof c.chars === 'number' && c.chars > 20), JSON.stringify(callsC.body.calls.map((c) => c.chars)));
ok('批量读的 id 互不相同', new Set(callsC.body.calls.map((c) => c.id)).size === 2, JSON.stringify(callsC.body.calls.map((c) => c.id)));
const detailOne = await call(state, `/dsh-memory/call?id=${encodeURIComponent(callsC.body.calls[0].id)}`);
ok('批量读的每条详情都取得到正文', /【记忆：/.test(detailOne.body.call.content || ''), JSON.stringify(detailOne.body.call?.chars));

// 会话 id 有 `session-xxx` 与裸 `xxx` 两种形态，视图不能因为前缀不同就一条都不显示。
await runPost('memory_read', { file: 'pl-mem' }, 'session-zzz-prefix');
const callsPrefixed = await call(state, '/dsh-memory/calls?sessionId=zzz-prefix');
eq('会话 id 前缀不同也能对上', callsPrefixed.body.calls.length, 1);
const callsBare = await call(state, '/dsh-memory/calls?sessionId=session-zzz-prefix');
eq('反方向也对得上', callsBare.body.calls.length, 1);

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
  write.execute({ name: 'tmp-orphan2', keywords: '资料/自检', description: 'x', body: 'x', dup_check: '只比了关键词，跟已有条目无关，新建' });
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
let sawToolName = null;
let sawToolEnum = null;
let sawTokensBudget = null;
let sawBudgetChars = null;
globalThis.fetch = async (url, opts) => {
  compressCalls += 1;
  const request = JSON.parse(opts.body);
  sawThinking = request.thinking;
  sawModel = request.model;
  sawResponseFormat = request.response_format;
  sawTokensBudget = request.max_tokens;
  const tool = (request.tools || [])[0];
  sawToolName = tool ? tool.function.name : null;
  sawToolEnum = tool ? tool.function.parameters.properties.items.items.properties.file.enum : null;
  const memories = JSON.parse(request.messages[1].content).memories;
  sawBudgetChars = memories.reduce((n, m) => n + Array.from(String(m.body || '')).length, 0);
  // 按档位造改稿：轻调整压到 85%，中删减压到 60%，都落在目标区间
  const factor = request.messages[0].content.includes('轻调整器') ? 0.85 : 0.6;
  const items = memories.map((m) => ({
    file: m.file,
    body: m.body.slice(0, Math.max(60, Math.floor(Array.from(m.body).length * factor))),
  }));
  // 主路径：工具调用填参；没有 tools 的请求（降级路径）才回 JSON 文本
  const message = tool
    ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_rewrites', arguments: JSON.stringify({ items }) } }] }
    : { content: JSON.stringify({ items }) };
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
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
eq('改稿走工具调用（不是散文 JSON）', sawToolName, 'submit_rewrites');
ok('file 用 enum 锁死本批文件', Array.isArray(sawToolEnum) && sawToolEnum.length > 0 && sawToolEnum.every((f) => /\.md$/.test(f)), JSON.stringify(sawToolEnum));
eq('输出预算按正文量算（1.6 倍 + 1024）', sawTokensBudget, T.compressMaxTokens(sawBudgetChars));
ok('预算不低于 8192', sawTokensBudget >= 8192, String(sawTokensBudget));
eq('主路径不吃降级（没有 response_format）', sawResponseFormat, undefined);
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
  const items = memories.map((m) => ({ file: m.file, body: m.body.slice(0, Math.max(60, Math.floor(Array.from(m.body).length * factor))) }));
  // 有 tools 就按工具调用回（主路径），没有才回 JSON 文本（降级路径）
  const message = (req.tools || [])[0]
    ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_rewrites', arguments: JSON.stringify({ items }) } }], finish_reason: 'tool_calls' }
    : { content: JSON.stringify({ items }), finish_reason: 'stop' };
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message }] }); } };
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
ok('每次请求都显式给足 max_tokens（不少于下限 8192）', sawMaxTokens >= T.COMPRESS_MAX_TOKENS, String(sawMaxTokens));
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
ok('索引行的分类列是项目记忆', /\| `dsh-memory\.md` \|.*\| 项目记忆 \|/.test(fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8')));
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
ok('分类被强制成项目记忆', /\| `wild\.md` \|.*\| 项目记忆 \|/.test(fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8')));

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

console.log('\n[15] 保留（否决待删除）与动手前提醒');
{
  const s = await call(state, '/dsh-memory/status');
  const stale = s.body.entries.find((e) => e.pendingDelete);
  ok('夹具里有「待删除」条目（否则这条测不到）', Boolean(stale), `prune=${JSON.stringify(s.body.prune)} 判据=${JSON.stringify(s.body.control)} ` + s.body.entries.map((e) => `${e.file}:${e.pendingDelete}:age=${e.ageTurns}`).join(','));
  if (stale) {
    eq('待删除条目的回忆率是 0', stale.recallRate, 0);
    const kept = await call(state, '/dsh-memory/keep', { file: stale.file });
    eq('保留接口 200', kept.code, 200);
    eq('回包带 kept', kept.body.kept, stale.file);
    const after = kept.body.entries.find((e) => e.file === stale.file);
    ok('保留后不再待删除', !after.pendingDelete, `${after.file} pendingDelete=${after.pendingDelete}`);
    eq('复核日刷成今天', after.reviewed, new Date().toLocaleDateString('sv-SE'));
    ok('保留没动正文（YAML 头还在）', /^---\r?\n/.test(fs.readFileSync(path.join(MEM, stale.file), 'utf8')));
    const bad = await call(state, '/dsh-memory/keep', { file: '../evil.md' });
    eq('保留：非法文件名 400', bad.code, 400);
  }
  // 动手前提醒：写文件那一刻把【教训】钩子递一次，同一轮不重复，读过教训就不打扰。
  userTurn();
  const first = await afterTool(state, 'write', { file_path: path.join(MEM, 'pl-mcd.md') });
  const firstText = (first.content || []).map((b) => String(b.text || '')).join('');
  ok('写文件后被追加【教训提醒】', firstText.includes('【教训提醒】'), firstText.slice(0, 60));
  ok('提醒里带「名称=关键词」', /noahs-ark=/.test(firstText), firstText.slice(0, 120));
  const again = await afterTool(state, 'write', { file_path: path.join(MEM, 'pl-mcd.md') });
  ok('同一轮只提醒一次', !(again.content || []).some((b) => String(b.text || '').includes('【教训提醒】')));
  userTurn();
  state.tools.get('memory_read').execute({ file: 'noahs-ark' });
  const afterRead = await afterTool(state, 'write', { file_path: path.join(MEM, 'pl-mcd.md') });
  ok('本轮已读教训就不再提醒', !(afterRead.content || []).some((b) => String(b.text || '').includes('【教训提醒】')));
}

console.log('\n[16] 新建前查重（模型自己判断）/ 并进已有条目 / 空泛词 / 淘汰线');
{
  userTurn();
  const base = { description: '自检', body: '正文' };
  // 缺少查重结论 → 不许写。
  threw = '';
  try {
    write.execute({ name: 'dup-a', keywords: '说明书/查重基准/自检', ...base });
  } catch (err) {
    threw = err.message;
  }
  ok('没有 dup_check 被拒', /先查重/.test(threw) && /dup_check/.test(threw), threw.slice(0, 80));

  // 结论太短、没有判定词 → 都不算想过。
  threw = '';
  try {
    write.execute({ name: 'dup-b', keywords: '说明书/查重基准/自检', ...base, dup_check: '新建' });
  } catch (err) {
    threw = err.message;
  }
  ok('结论太短被拒', /太短/.test(threw), threw.slice(0, 80));
  threw = '';
  try {
    write.execute({ name: 'dup-c', keywords: '说明书/查重基准/自检', ...base, dup_check: '我随便写了一句关于这个工具的话' });
  } catch (err) {
    threw = err.message;
  }
  ok('结论里没有判定词被拒', /判定词/.test(threw), threw.slice(0, 80));

  // 结论里报了名字，本轮就必须真读过。
  threw = '';
  try {
    write.execute({ name: 'dup-d', keywords: '说明书/查重基准/自检', ...base, dup_check: '跟 noahs-ark 不同，判为无关，新建' });
  } catch (err) {
    threw = err.message;
  }
  ok('提到没读过的条目被拒', /没读过/.test(threw), threw.slice(0, 80));

  // 读过 + 说清 → 放行，回执里带查重结论。
  read.execute({ file: 'noahs-ark' });
  const allowed = write.execute({
    name: 'dup-e',
    keywords: '说明书/查重基准/自检',
    ...base,
    dup_check: '跟 noahs-ark 都涉及删目录，读了全文发现对象是家目录，这条是 mklink 目录，判为无关，新建',
  });
  ok('读过全文后放行', /已记下/.test(allowed.text), allowed.text.slice(0, 60));
  ok('回执带上查重结论', /查重结论/.test(allowed.text), allowed.text.slice(0, 120));

  // 这一轮读过的记忆必须在 dup_check 里表态：读到了却另开一条，是最容易漏的浪费。
  userTurn();
  read.execute({ file: 'noahs-ark' });
  threw = '';
  try {
    write.execute({ name: 'dup-g', keywords: '说明书/查重基准/自检', ...base, dup_check: '只比了关键词，跟已有条目无关，新建' });
  } catch (err) {
    threw = err.message;
  }
  ok('读过却没表态被拒', /却没提它/.test(threw), threw.slice(0, 80));
  const namedRead = write.execute({
    name: 'dup-h',
    keywords: '说明书/查重基准/自检',
    ...base,
    dup_check: '跟 noahs-ark 无关（它是删家目录，这条是自检夹具），判为无关，新建',
  });
  ok('表态后放行', /已记下/.test(namedRead.text), namedRead.text.slice(0, 60));

  // 只比关键词、不提任何名字 → 也算查过了，直接放行（这一轮没读过任何正文）。
  userTurn();
  const kwOnly = write.execute({ name: 'dup-f', keywords: '资料/另一种咖啡/自检', ...base, dup_check: '只比了关键词：没有涉及咖啡或冲泡的条目，判为无关，新建' });
  ok('只比关键词也能放行', /已记下/.test(kwOnly.text), kwOnly.text.slice(0, 60));

  // 空泛词：整条只有「插件/记忆/工具」这种，等于没写。
  threw = '';
  try {
    write.execute({ name: 'vague-one', keywords: '说明书/插件/工具', ...base, dup_check: '只比了关键词，无关，新建' });
  } catch (err) {
    threw = err.message;
  }
  ok('整条都是空泛词被拒', /空泛词/.test(threw), threw.slice(0, 80));

  // 并进已有条目：append:true 追加在正文尾部，不是覆盖。
  const appended = update.execute({ name: 'dup-e', body: '追加的一段', append: true });
  ok('append:true 回「已追加」', /已追加/.test(appended.text), appended.text.slice(0, 40));
  const merged = fs.readFileSync(path.join(MEM, 'dup-e.md'), 'utf8');
  ok('追加没覆盖原正文', merged.includes('正文') && merged.includes('追加的一段'));

  // 淘汰线随条目数收紧：条目越多，窗口天数越小、最低回忆次数越大；再按当前口径缩放。
  const snap = await call(state, '/dsh-memory/status');
  const pr = snap.body.prune;
  ok('状态里带淘汰线', Boolean(pr) && typeof pr.days === 'number' && typeof pr.minHits === 'number', JSON.stringify(pr));
  ok('状态里带口径档位', Number.isInteger(pr.tier) && pr.tier >= 1 && pr.tier <= 6, JSON.stringify(pr));
  const SCALE = [1.5, 1.25, 1, 0.85, 0.7, 0.6];
  const ADD = [0, 0, 0, 1, 1, 2];
  const daysOf = (n, tier) =>
    Math.max(7, Math.min(60, Math.round((45 / (1 + Math.log2(Math.max(1, n / 8)))) * SCALE[tier - 1])));
  const hitsOf = (n, tier) => Math.max(1, 1 + Math.round(Math.log2(Math.max(1, n / 8))) + ADD[tier - 1]);
  eq('淘汰天数按条目数与口径算出来', pr.days, daysOf(pr.total, pr.tier));
  eq('最低回忆次数按条目数与口径算出来', pr.minHits, hitsOf(pr.total, pr.tier));
  ok('淘汰窗口落在 7~60 天', pr.days >= 7 && pr.days <= 60, String(pr.days));

  // 提示词检视：/dsh-memory/prompts 要把模型能看到的东西都交出来（记忆正文除外）。
  const inv = await call(state, '/dsh-memory/prompts');
  const ids = (inv.body?.items || []).map((it) => it.id);
  ok('提示词接口可用', inv.code === 200 && ids.length >= 8, `${inv.code} / ${ids.length} 段`);
  ok('含大纲抬头与工具定义', ids.includes('系统提示词·大纲抬头') && ids.includes('工具·memory_read') && ids.includes('工具·memory_write'), ids.join(' | ').slice(0, 120));
  ok('含提醒原文', ids.includes('工具·动手前提醒'), ids.join(' | ').slice(0, 120));
  const wt = (inv.body?.items || []).find((it) => it.id === '工具·memory_write');
  ok('工具定义里带参数说明', /参数：/.test(wt?.text || '') && /dup_check/.test(wt?.text || ''), String(wt?.text || '').slice(0, 60));
  ok('口径总字数可统计', Number.isFinite(inv.body?.totalChars) && inv.body.totalChars > 1000, String(inv.body?.totalChars));
  const outlineNow = (inv.body?.items || []).find((it) => it.id === '系统提示词·大纲抬头')?.text || '';
  ok('大纲里有当前口径那一句', /记的时候大方点|新主题优先|先看看现成的|优先改写|少一条胜过|记忆已经很挤/.test(outlineNow), outlineNow.slice(0, 80));

  // 硬闸门已关（2026-11-25 用户要求）：破坏性命令不再被 deny，只留 post-execute 的动手前提醒。
  userTurn();
  eq('破坏性命令不再被拦', await gate(state, 'pwsh', { command: 'Remove-Item -Recurse -Force C:\\tmp\\foo' }), 'pass');
  eq('git reset --hard 也不再被拦', await gate(state, 'pwsh', { command: 'git reset --hard HEAD~1' }), 'pass');
  eq('普通命令照旧放行', await gate(state, 'pwsh', { command: 'git status --short' }), 'pass');
  const invIds = (await call(state, '/dsh-memory/prompts')).body?.items?.map((it) => it.id) || [];
  ok('提示词检视里不再有硬闸门话术', !invIds.includes('拦截·破坏性命令'), invIds.join(' | ').slice(0, 120));
}

console.log('\n[17] 压缩请求的结构化输出（工具调用 + 预算 + 回包解析）');
{
  // 预算：地板 8192、天花板 65536、中间按正文量线性放大（2026-11-18 截断事故的根因就是预算不够）
  eq('空批次取下限', T.compressMaxTokens(0), T.COMPRESS_MAX_TOKENS);
  ok('大批次预算随正文量放大', T.compressMaxTokens(8000) > T.COMPRESS_MAX_TOKENS, String(T.compressMaxTokens(8000)));
  eq('超大批次封顶 65536', T.compressMaxTokens(1e6), T.COMPRESS_MAX_TOKENS_CAP);
  // 工具声明：file 用 enum 锁死候选，多给文件名也写不出来
  const spec = T.compressToolSpec(['a.md', 'b.md']);
  eq('工具名固定', spec.function.name, 'submit_rewrites');
  eq('file 的 enum 就是本批文件', JSON.stringify(spec.function.parameters.properties.items.items.properties.file.enum), JSON.stringify(['a.md', 'b.md']));
  eq('items 必填且不许多余字段', JSON.stringify(spec.function.parameters.properties.items.items.required), JSON.stringify(['file', 'body']));
  eq('整条参数不许多余字段', spec.function.parameters.additionalProperties, false);
  // 回包解析：拿得到 tool_calls / 拿不到就空数组（由上层重试或降级）
  const okPayload = { choices: [{ message: { tool_calls: [{ function: { name: 'submit_rewrites', arguments: JSON.stringify({ items: [{ file: 'a.md', body: 'x' }] }) } }] } }] };
  eq('从 tool_calls 取到 items', JSON.stringify(T.toolCallItems(okPayload)), JSON.stringify([{ file: 'a.md', body: 'x' }]));
  eq('没有工具调用返回空数组', JSON.stringify(T.toolCallItems({ choices: [{ message: { content: '{}' } }] })), '[]');
  eq('别的工具名不算数', JSON.stringify(T.toolCallItems({ choices: [{ message: { tool_calls: [{ function: { name: 'other', arguments: '{"items":[]}' } }] } }] })), '[]');
  eq('参数被截断（坏 JSON）返回空数组', JSON.stringify(T.toolCallItems({ choices: [{ message: { tool_calls: [{ function: { name: 'submit_rewrites', arguments: '{"items":[{"file":"a.md"' } }] } }] })), '[]');
  eq('缺 file 的条目被丢掉', JSON.stringify(T.toolCallItems({ choices: [{ message: { tool_calls: [{ function: { name: 'submit_rewrites', arguments: JSON.stringify({ items: [{ body: 'x' }, { file: 'b.md', body: 'y' }] }) } }] } }] })), JSON.stringify([{ file: 'b.md', body: 'y' }]));
  // 降级路径仍然可用：围栏里包着的 JSON 也能抠出来
  eq('降级解析容忍代码围栏', JSON.stringify(T.parseCompressItems('```json\n{"items":[{"file":"a.md","body":"z"}]}\n```')), JSON.stringify([{ file: 'a.md', body: 'z' }]));
}

console.log('\n[18] 客户端配色跟着主题走（深色模式不回潮）');
{
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // 这几个写死色曾经只对浅色主题成立：环轨近白、差异行底色为浅粉/浅绿。
  for (const hex of ['#e6e6e8', '#a8c8f5', '#2f6fe4', '#ffc2c2', '#b4efb4']) {
    ok(`client.js 不再写死 ${hex}`, !cli.includes(`'${hex}'`));
  }
  ok('环轨取主题变量', cli.includes('var(--dsw-alias-border-l2)'));
  ok('环的两段取品牌色', cli.includes("stroke: 'var(--dsw-alias-brand-primary)'"));
  ok('差异行改成叠色（深浅主题都读得清）', cli.includes('rgba(226, 87, 76, 0.28)') && cli.includes('rgba(47, 163, 107, 0.28)'));
}

console.log('\n[19] 项目记忆的来源会话与原始上下文备份');
{
  const SID = 'session-11112222-3333-4444-5555-666677778888';
  const sessDir = path.join(HOME, 'sessions', '--selfcheck--', SID);
  fs.mkdirSync(sessDir, { recursive: true });
  const logFile = path.join(sessDir, 'session.v4.jsonl.zstd');
  // 多帧拼接是真实形态：一次 append 一帧，整文件一口气解不开。
  const frame = (rows) => zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
  fs.writeFileSync(
    logFile,
    Buffer.concat([
      frame([{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { content: [{ type: 'text', text: '第一句用户原话' }], source: { kind: 'user' } } }]),
      frame([
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手回答' }, { type: 'tool-call', name: 'memory_read', arguments: '{"file":"pl-mem"}' }] } } },
        { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '记忆正文片段' }] } } },
        { type: 'system/message', data: { content: [{ type: 'text', text: '系统提示不该进转录' }] } },
      ]),
    ]),
  );
  eq('多帧会话日志能找到', T.sessionLogPath(SID), logFile);
  const decoded = T.decodeSessionLog(logFile);
  ok('两帧都解出来了', decoded.includes('第一句用户原话') && decoded.includes('助手回答'));
  const rendered = T.renderSessionTranscript(decoded);
  ok('转录保留用户与助手', rendered.md.includes('## 用户（第 1 轮）') && rendered.md.includes('## 助手'));
  ok('工具调用与结果都在', rendered.md.includes('► memory_read') && rendered.md.includes('◄ 记忆正文片段'));
  ok('系统消息不进转录', !rendered.md.includes('系统提示不该进转录'));
  eq('统计对得上', JSON.stringify(rendered.stats), JSON.stringify({ turns: 1, user: 1, assistant: 1, tool: 1 }));

  const line = T.sourceLine(SID);
  ok('来源行带会话号', line.startsWith('> 来源会话：') && line.includes(SID), line);
  eq('来源行能反解回会话号', T.sourceSessionOf(`> 来源会话：${SID}（原始上下文已另存）`), SID);
  eq('没有来源行的正文解出空串', T.sourceSessionOf('普通正文'), '');

  const meta = T.ensureSessionSource(SID);
  ok('备份出可读转录与原始日志副本', fs.existsSync(meta.file) && fs.existsSync(meta.zst), `${meta.chars} 字`);
  ok('备份幂等（第二次直接复用）', T.ensureSessionSource(SID).cached === true);

  const created = await call(state, '/dsh-memory/create', {
    name: 'tmp-src',
    keywords: '项目记忆/自检来源',
    description: '自检用',
    body: '项目正文',
    session: SID,
  });
  eq('带 session 新建成功', created.body.created, 'tmp-src.md');
  const bodyFile = fs.readFileSync(path.join(MEM, 'tmp-src.md'), 'utf8');
  ok('正文头部自动注明来源会话', bodyFile.includes(`> 来源会话：${SID}`) && bodyFile.indexOf('> 来源会话：') < bodyFile.indexOf('项目正文'));

  const readTool = state.tools.get('memory_read');
  const readBack = await readTool.execute({ file: 'tmp-src' });
  ok('memory_read 带上头部来源行', readBack.text.includes(`> 来源会话：${SID}`));

  const src = state.tools.get('memory_source');
  const m1 = await src.execute({ name: 'tmp-src' });
  ok('meta 回会话号与统计', m1.text.includes(SID) && /轮次 1/.test(m1.text), m1.text.split('\n')[0]);
  ok('meta 不吐正文', !m1.text.includes('第一句用户原话'));
  const m2 = await src.execute({ name: 'tmp-src', mode: 'read', offset: 0, limit: 120 });
  ok('read 按字符区间回原文', m2.text.includes('字符 0..') && m2.text.includes('原始上下文'), m2.text.split('\n')[0]);
  const m3 = await src.execute({ name: 'tmp-src', mode: 'find', pattern: '第一句用户原话' });
  ok('find 命中并带字符偏移', /（字符 \d+）/.test(m3.text) && m3.text.includes('第一句用户原话'));
  const m4 = await src.execute({ name: 'tmp-src', mode: 'find', pattern: '根本没有这句' });
  ok('find 没命中如实说', /没找到/.test(m4.text));
  let noSource = '';
  try {
    await src.execute({ name: 'user-profile' });
  } catch (err) {
    noSource = err.message;
  }
  ok('没有来源会话的记忆被拒', /没有来源会话/.test(noSource), noSource);
}

console.log('\n[20] 关系边与大纲冷热分层');
{
  // 关系边：dup_check 里点名、且判成相似/相关/并入的条目，会连成一条双向边。
  userTurn();
  read.execute({ file: 'pl-mem' });
  const linked = write.execute({
    name: 'rel-new',
    keywords: '说明书/关系边/自检',
    description: '自检：关系边',
    body: '关系边自检正文。',
    dup_check: '跟 pl-mem 都涉及记忆索引，读了全文发现它是工具说明、这条是链路自检，判成相关',
  });
  ok('带关系结论的写入成功', /已记下/.test(linked.text), linked.text.slice(0, 60));
  const rel = T.relatedOf('pl-mem.md').map((r) => r.file);
  ok('新条目与原条目连成边', rel.includes('rel-new.md'), rel.join(','));
  const back = T.relatedOf('rel-new.md').map((r) => r.file);
  ok('边是双向的', back.includes('pl-mem.md'), back.join(','));
  const readBack = read.execute({ file: 'rel-new' });
  ok('读一条时顺带提示邻居', /相关记忆：/.test(readBack.text) && /pl-mem/.test(readBack.text), readBack.text.slice(-100));
  ok('关系边不进大纲', !T.outlineText().includes('相关记忆'));
  state.tools.get('memory_delete').execute({ name: 'rel-new' });
  ok('删掉一条后边一并清掉', !T.relatedOf('pl-mem.md').map((r) => r.file).includes('rel-new.md'));

  // 冷热分层：窗口够长时，读到的条目保留完整关键词，没被读到的削短（名字仍在大纲里）。
  for (let i = 0; i < 60; i += 1) userTurn();
  read.execute({ file: 'pl-mem' });
  userTurn();
  read.execute({ file: 'pl-mem' });
  const text = T.outlineText();
  const seg = (name) => text.split(' · ').find((s) => s.startsWith(`${name}=`)) || '';
  const kwLen = (name) => Array.from(seg(name).slice(name.length + 1)).length;
  ok('热条目（读到过的）保留长关键词', kwLen('pl-mem') > T.OUTLINE_COLD_KW_MAX, `${kwLen('pl-mem')} 字 / ${seg('pl-mem')}`);
  ok('冷条目被削短', kwLen('huashu-motion-install') < kwLen('pl-mem') && kwLen('huashu-motion-install') <= T.OUTLINE_COLD_KW_MAX + 8, `${kwLen('huashu-motion-install')} 字 / ${seg('huashu-motion-install')}`);
  ok('削短后名字还在大纲里', seg('huashu-motion-install').startsWith('huashu-motion-install='));
  ok('削短的条目以省略号结尾（在关键词边界剪）', /…$/.test(seg('huashu-motion-install')), seg('huashu-motion-install'));
}

console.log('\n[21] 口径的自动/手动混合控制与删除判决的观察期');
{
  const first = await call(state, '/dsh-memory/status');
  const ctl0 = first.body.control;
  ok('状态里带控制方式', Boolean(ctl0) && ['auto', 'manual'].includes(ctl0.mode), JSON.stringify(ctl0));
  eq('默认是自动', ctl0.mode, 'auto');
  ok('自动档位与 prune.tier 一致', ctl0.activeTier === first.body.prune.tier, `${ctl0.activeTier} / ${first.body.prune.tier}`);

  const locked = await call(state, '/dsh-memory/control', { mode: 'manual', tier: 5 });
  eq('切手动 200', locked.code, 200);
  eq('回包是手动', locked.body.control.mode, 'manual');
  eq('手动档位生效', locked.body.control.activeTier, 5);
  eq('手动档位同时压到 prune.tier', locked.body.prune.tier, 5);
  ok('手动时仍给出自动档位（PID 后台照算）', Number.isFinite(locked.body.control.autoTier), JSON.stringify(locked.body.control));

  const clamped = await call(state, '/dsh-memory/control', { mode: 'manual', tier: 99 });
  eq('档位超范围被夹到 6', clamped.body.control.activeTier, 6);
  const bad = await call(state, '/dsh-memory/control', { mode: 'weird', tier: 2 });
  eq('非法 mode 被拒 400', bad.code, 400);

  const manual = await call(state, '/dsh-memory/control', { mode: 'manual', tier: 2 });
  eq('再切回手动第 2 档', manual.body.control.activeTier, 2);
  ok('手动档位会写进大纲（模型看到第 2 档那句口径）', T.outlineText().includes(T.TIER_LINES[1]), T.TIER_LINES[1]);

  const auto = await call(state, '/dsh-memory/control', { mode: 'auto' });
  eq('切回自动', auto.body.control.mode, 'auto');
  eq('自动档位由 PID 决定', auto.body.control.activeTier, auto.body.control.autoTier);

  // 删除判决：观察期内的新条目一律不判（哪怕复核日很旧、回忆 0 次）。
  userTurn();
  const fresh = write.execute({
    name: 'judge-fresh',
    keywords: '说明书/判决观察期/自检',
    description: '自检：观察期',
    body: '观察期自检。',
    dup_check: '只比了关键词，没有讲判决观察期的条目，判成新建',
  });
  ok('观察期内条目能正常新建', /已记下/.test(fresh.text), fresh.text.slice(0, 40));
  const st = await call(state, '/dsh-memory/status');
  const me = st.body.entries.find((e) => e.file === 'judge-fresh.md');
  ok('新条目 ageTurns 是 0', me && me.ageTurns === 0, JSON.stringify(me && me.ageTurns));
  ok('观察期没走完就不判待删除', me && me.pendingDelete === false, `${me && me.pendingDelete}`);
  state.tools.get('memory_delete').execute({ name: 'judge-fresh' });

  // 语义对齐：中文钩子（删除/清理）也要能被英文命令（Remove-Item）顶到提醒最前面。
  userTurn();
  const danger = await afterTool(state, 'pwsh', { command: 'Remove-Item build -Recurse -Force' });
  const dangerText = (danger.content || []).map((b) => String(b.text || '')).join('');
  const order = dangerText.split('：')[1] || '';
  ok('破坏性命令把「删/清理」类教训顶到最前', order.startsWith('tmp-act='), order.slice(0, 90));
}

console.log('\n[22] 2.0 仓库骨架与工具契约（阶段一）');
{
  const S = await import(pathToFileURL(path.join(PKG, 'store.js')).href);
  eq('仓库骨架版本', S.STORE_VERSION, 1);
  const contract = S.validateContracts();
  eq('工具与路由契约没有自相矛盾', contract.errors.join('; '), '');
  eq('冻结的工具数', S.TOOL_NAMES.length, 8);
  eq(
    '工具名清单',
    S.TOOL_NAMES.join(','),
    'memory_read,memory_source,memory_write,memory_update,memory_delete,memory_search,memory_organize,memory_reindex',
  );
  ok('每个工具都标了实现阶段', S.TOOL_CONTRACTS.every((t) => Number.isInteger(t.phase) && t.phase >= 1 && t.phase <= 7));
  ok('memory_search 的 query 是必填', S.TOOL_CONTRACTS.find((t) => t.name === 'memory_search').params.query.required === true);
  ok(
    'memory_write 要求 dup_check（查重结论）',
    S.TOOL_CONTRACTS.find((t) => t.name === 'memory_write').params.dup_check.required === true,
  );

  const layout = S.storeLayout('/mem');
  eq('索引目录与正文分开', layout.root, '/mem/.index');
  eq('清单落在 .index 下', layout.manifest, '/mem/.index/manifest.json');
  eq('段落在 .index 下', layout.segments, '/mem/.index/segments.jsonl');
  eq('向量落在 .index 下', layout.vectors, '/mem/.index/vectors.bin');

  const man = S.emptyManifest({ model: 'text-embedding-v4', dim: 1024 });
  const mcheck = S.validateManifest(man);
  ok('空清单可用', mcheck.ok, mcheck.errors.join('; '));
  ok('清单记了模型与维度', man.model === 'text-embedding-v4' && man.dim === 1024);
  ok('清单声明 L2 归一化 + 余弦', man.normalize === 'l2' && man.metric === 'cosine');
  const bad = S.validateManifest({ ...man, dim: 0 });
  ok('坏清单被拒（dim=0）', !bad.ok && bad.errors.some((e) => /dim/.test(e)), bad.errors.join('; '));
  const badFile = S.validateManifest({ ...man, files: { 'a.txt': { hash: 'x', segments: [] } } });
  ok('清单只收 .md', !badFile.ok && badFile.errors.some((e) => /\.md/.test(e)), badFile.errors.join('; '));

  const seg = S.makeSegment({
    name: 'demo',
    file: 'demo.md',
    ordinal: 1,
    heading: '示例小节',
    text: '一段用于验证段记录形状的正文。',
    hash: 'abcdef1234567890',
    keywords: '示例/骨架',
    category: '其它',
  });
  ok('段记录形状可用', S.validateSegment(seg).ok, S.validateSegment(seg).errors.join('; '));
  eq('段 id = 名称#序号@哈希前 8 位', seg.id, 'demo#001@abcdef12');
  eq('段里记了字数', seg.chars, Array.from('一段用于验证段记录形状的正文。').length);
  ok('没算向量时 voff 为 null', seg.voff === null && seg.vlen === 0);
  eq(
    '嵌入文本 = 名称|分类|摘要|小节标题 + 正文',
    S.embedText({ name: 'demo', category: '教训', summary: '删家目录前必读', heading: '为什么', text: '正文' }),
    'demo | 教训 | 删家目录前必读 | 为什么\n正文',
  );
}

console.log('\n[23] 2.0 章节级索引（阶段二）');
{
  const IDX = await import(pathToFileURL(path.join(PKG, 'indexer.js')).href);
  const S = await import(pathToFileURL(path.join(PKG, 'store.js')).href);
  const sections = IDX.splitSections('前言\n## 为什么\n正文 A\n## 怎么用\n正文 B');
  eq('按 ## 切小节', sections.map((s) => s.heading).join('|'), '为什么|怎么用');
  eq('超长小节按空行再切', IDX.splitLong(`${'a'.repeat(300)}\n\n${'b'.repeat(300)}`, 500).length, 2);

  const memDir = path.join(HOME, 'idx-demo');
  const alpha = {
    name: 'alpha',
    file: 'alpha.md',
    body: `## 一\n${'甲'.repeat(80)}\n## 二\n${'乙'.repeat(80)}`,
    summary: '资料/甲/乙',
    keywords: '资料/甲/乙',
    category: '资料',
  };
  const beta = { name: 'beta', file: 'beta.md', body: `## 一\n${'丙'.repeat(80)}`, summary: '教训/丙', keywords: '教训/丙', category: '教训' };
  const dim = 8;
  const fakeEmbed = (texts) => texts.map(() => Array.from({ length: dim }, () => 1 / Math.sqrt(dim)));

  const first = await IDX.buildIndex([alpha, beta], null, { dim, model: 'm', embed: fakeEmbed });
  eq('一条记忆 = 一个向量', first.segments.length, 2);
  ok('整条入库不带 split 标记', first.segments.every((seg) => seg.split === false));
  eq('首建全部嵌入', first.stats.embedded, 2);
  eq('向量文件 = 段×维度×4 字节', first.buffer.length, 2 * dim * 4);
  ok('清单通过校验', S.validateManifest(first.manifest).ok, S.validateManifest(first.manifest).errors.join('; '));
  ok('段里记了向量偏移', first.segments[1].voff === dim * 4 && first.segments[1].vlen === dim * 4);
  eq('整条入库段的正文 = 全文', first.segments[0].chars, Array.from(alpha.body.trim()).length);

  const rawWithHead = `---\nreviewed: 2026-01-01\nkeywords: 资料/甲/乙\n---\n${alpha.body}`;
  eq('CLI 与宿主对同一份正文算哈希', IDX.hashText(IDX.stripFrontmatter(rawWithHead)), IDX.hashText(alpha.body.trim()));

  IDX.writeIndex(memDir, first);
  const prev = IDX.readIndex(memDir);
  eq('读回 2 段', prev.segments.length, 2);
  ok('读回 2 条向量且维度对', prev.vectors.length === 2 && prev.vectors[0].length === dim);
  ok('向量已 L2 归一化', Math.abs(Math.hypot(...prev.vectors[0]) - 1) < 1e-4);

  const again = await IDX.buildIndex([alpha, beta], prev, { dim, model: 'm', embed: fakeEmbed });
  eq('内容没变就零嵌入', again.stats.embedded, 0);
  eq('全部复用旧向量', again.stats.reused, 2);

  const beta2 = { ...beta, body: `## 一\n${'丁'.repeat(80)}` };
  const third = await IDX.buildIndex([alpha, beta2], prev, { dim, model: 'm', embed: fakeEmbed });
  eq('只改一条就只重算那一条', third.stats.embedded, 1);

  const forced = await IDX.buildIndex([alpha, beta], prev, { dim, model: 'm', embed: fakeEmbed, force: ['alpha'] });
  eq('names 强制重算指定文件', forced.stats.embedded, 1);

  const over = await IDX.buildSegments({ name: 'long', file: 'long.md', body: `## 一
${'长'.repeat(1500)}
## 二
${'文'.repeat(900)}`, category: '其它' });
  ok('超过 2000 字的遗留条目退回分段并标记', over.length > 1 && over.every((seg) => seg.split === true));
  eq('正好 2000 字仍整条入库', IDX.buildSegments({ name: 'edge', file: 'edge.md', body: '字'.repeat(2000) }).length, 1);

  let bad = '';
  try {
    await IDX.buildIndex([alpha], null, { dim, model: 'm', embed: (texts) => texts.map(() => [1, 2]) });
  } catch (err) {
    bad = err.message;
  }
  ok('向量维度不符会报错', /维度/.test(bad), bad);

  eq('只给域名就补成兼容端点', IDX.embedEndpoint('https://dashscope.aliyuncs.com'), 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
  eq(
    '已是兼容端点就不重复拼',
    IDX.embedEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
  );

  const cfg = IDX.resolveEmbedConfig({ USERPROFILE: path.join(HOME, 'nokey'), DSH_MEMORY_EMBED_KEY: '' });
  eq('没配置时 apiKey 为空', cfg.apiKey, '');
  eq('默认模型是 text-embedding-v4', cfg.model, 'text-embedding-v4');
  eq('默认维度 1024', cfg.dim, 1024);
}

console.log('\n[24] 2.0 检索（阶段三：BM25 + 向量 + RRF）');
{
  const S = await import(pathToFileURL(path.join(PKG, 'search.js')).href);
  const terms = S.tokenize('改客户端插件 memory_search');
  ok('中文按 2 字滑窗切词', terms.includes('插件') && terms.includes('户端'), terms.slice(0, 8).join(','));
  ok('英文整词保留', terms.includes('memory_search'));

  const docs = [
    { id: 'a', text: '跑长命令要用 ops_bash，pnpm 在某些壳里会挂' },
    { id: 'b', text: '删家目录之前先看教训，别用 Remove-Item -Recurse' },
  ];
  eq('BM25 命中排第一', S.bm25Rank(docs, 'ops_bash')[0]?.id, 'a');
  eq('BM25 中文查询也命中', S.bm25Rank(docs, '删家目录')[0]?.id, 'b');
  eq('BM25 完全没命中就空', S.bm25Rank(docs, 'zzz不存在的东西').length, 0);

  const vectors = [
    { id: 'x', vec: [1, 0] },
    { id: 'y', vec: [0, 1] },
  ];
  eq('余弦取最像的', S.cosineRank(vectors, [1, 0])[0].id, 'x');
  eq('minScore 门槛生效', S.cosineRank(vectors, [1, 0], { minScore: 0.9 }).length, 1);
  eq('维度不符的向量被跳过', S.cosineRank([{ id: 'z', vec: [1] }], [1, 0]).length, 0);

  const fused = S.rrfFuse([
    [{ id: 'a', score: 9 }],
    [
      { id: 'b', score: 1 },
      { id: 'a', score: 0.5 },
    ],
  ]);
  eq('两路都命中的排第一', fused[0].id, 'a');
  eq('融合后两条都在', fused.length, 2);
  eq('融合结果带每路名次', fused[0].ranks.length, 2);

  const flat = S.oneLineSummary('## 标题\n\n一句话\n\n' + '字'.repeat(200), 20);
  ok('摘要把标题符与换行压平', !flat.includes('#') && !flat.includes('\n'), flat);
  ok('摘要超长加省略号', flat.endsWith('…') && Array.from(flat).length === 21, `${Array.from(flat).length}`);

  const tool = state.tools.get('memory_search');
  ok('memory_search 已注册', Boolean(tool));
  ok('search 工具要求 query', (tool.parameters.required || []).includes('query'));
  let emptyErr = '';
  try {
    await tool.execute({ query: '   ' });
  } catch (err) {
    emptyErr = err.message;
  }
  ok('空 query 被拒', /query 不能为空/.test(emptyErr), emptyErr);
  let noIdx = '';
  try {
    await tool.execute({ query: '删家目录' });
  } catch (err) {
    noIdx = err.message;
  }
  ok('没索引时给出可操作提示', /索引还是空的|没找到|embedding/.test(noIdx), noIdx);
}

console.log('\n[25] 2.0 自动召回（阶段四）');
{
  ok('寒暄不值得搜', !T.shouldAutoRecall('好的') && !T.shouldAutoRecall('谢谢！'));
  ok('斜杠命令不搜', !T.shouldAutoRecall('/remember 记一下'));
  ok('太短不搜', !T.shouldAutoRecall('嗯'));
  ok('已经在召回块里的不重复搜', !T.shouldAutoRecall(`${T.RECALL_MARK} 旧内容`));
  ok('正常提问才搜', T.shouldAutoRecall('改完源码客户端没变化怎么办'));

  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一句' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答一句' }] },
    { role: 'user', content: [{ type: 'text', text: '插件改了不生效怎么办' }] },
  ];
  eq('取到最后一条用户消息', T.lastUserText(messages), '插件改了不生效怎么办');
  eq('没有用户消息就空', T.lastUserText([{ role: 'assistant', content: [] }]), '');

  const block = T.recallBlock([
    { name: 'plugin-fork-dist-not-live', summary: '教训/插件源码生效/改 dist' },
    { name: 'pl-mcp', summary: '说明书/MCP/懒加载' },
  ]);
  ok('召回块带标记', block.startsWith(T.RECALL_MARK), block.slice(0, 20));
  ok('召回块只给名字与摘要', block.includes('plugin-fork-dist-not-live —— 教训/插件源码生效/改 dist'));
  ok('召回块指路 memory_read', /memory_read/.test(block));
  ok('召回块说明可忽略', /不相关就忽略/.test(block));
  eq('没结果就没有块', T.recallBlock([]), '');

  T.resetRecall();
  T.setRecallImpl(async () => ({ results: [{ name: 'pl-mem', summary: '记忆读写', ranks: [1, 1], cos: 0.62 }] }));
  const decision = { kind: 'enter', messages: messages.map((m) => ({ ...m, content: m.content.slice() })) };
  const out = await T.autoRecallListener({}, async () => decision);
  eq('召回行是独立的一条消息，不是塞进用户气泡', out.messages.length, decision.messages.length + 1);
  const injected = out.messages[3];
  eq('插件消息紧跟在用户那句之后', injected.role, 'user');
  eq('插件消息带 plugin: 出处', injected.source.kind, 'plugin:dsh-memory');
  eq('插件消息标明是 notice', injected.source.form, 'notice');
  ok('插件消息有自己的 id', typeof injected.id === 'string' && injected.id.length > 8);
  ok('插件消息内容是召回块', String(injected.content[0].text).startsWith(T.RECALL_MARK), String(injected.content[0].text).slice(0, 20));
  eq('用户自己的消息一字未动', out.messages[2].content.length, 1);
  eq('用户自己的文本没被拼接', out.messages[2].content[0].text, '插件改了不生效怎么办');
  eq('前面的历史也没动', out.messages[0].content[0].text, '第一句');

  const again = await T.autoRecallListener({}, async () => ({ kind: 'enter', messages: out.messages }));
  eq('同一条消息后面已有召回行就不再插', again.messages.length, out.messages.length);
  eq('插件行不会被当成用户提问', T.lastUserText(out.messages), '插件改了不生效怎么办');

  T.resetRecall();
  T.setRecallImpl(async () => ({ results: [] }));
  const none = await T.autoRecallListener({}, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '另一个问题' }] }],
  }));
  eq('没搜到就不加消息', none.messages.length, 1);

  T.resetRecall();
  T.setRecallImpl(async () => {
    throw new Error('索引坏了');
  });
  const broken = await T.autoRecallListener({}, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '第三个问题' }] }],
  }));
  eq('检索抛错也不能影响对话', broken.messages.length, 1);

  T.resetRecall();
  T.setRecallImpl(async () => ({ results: [{ name: 'weak', summary: '弱命中', ranks: [null, 7], cos: 0.2 }] }));
  const weak = await T.autoRecallListener({}, async () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: '第四个问题' }] }],
  }));
  eq('弱命中不加消息', weak.messages.length, 1);

  const gate = async (results) => {
    T.resetRecall();
    T.setRecallImpl(async () => ({ results }));
    const got = await T.autoRecallListener({}, async () => ({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '第五个问题呢' }] }],
    }));
    return got.messages.length - 1;
  };
  eq('cos 到门槛才注入（0.56）', await gate([{ name: 'a', summary: 's', ranks: [1, 3], cos: 0.56, bm25: 1 }]), 1);
  eq('cos 不够就闭嘴（0.3）', await gate([{ name: 'a', summary: 's', ranks: [1, 1], cos: 0.3, bm25: 12 }]), 0);
  eq('没有语义分时看字面分（bm25 12）', await gate([{ name: 'a', summary: 's', ranks: [1, 2], cos: 0, bm25: 12 }]), 1);
  eq('字面分也不够还是闭嘴（bm25 3）', await gate([{ name: 'a', summary: 's', ranks: [1, 1], cos: 0, bm25: 3 }]), 0);

  T.setRecallImpl(null);
  T.resetRecall();
}

console.log('\n[26] 2.0 整理体检与索引重建（阶段五）');
{
  eq('两条新工具都注册了', ['memory_organize', 'memory_reindex'].every((n) => state.tools.has(n)), true);
  const organize = state.tools.get('memory_organize');
  ok('organize 默认 dry_run', /dry_run/.test(JSON.stringify(organize.parameters)) && /只出提案/.test(organize.description));

  const dry = await T.organizeMemories({ dryRun: true });
  ok('体检会报条数', /^体检 \d+ 条/.test(dry.text), dry.text.split('\n')[0]);
  ok('四类提案都列出来', ['合并', '拆分', '删除', '补边'].every((k) => dry.text.includes(k)));
  ['merge', 'split', 'link', 'drop'].forEach((k) => ok(`提案字段 ${k} 是数组`, Array.isArray(dry.proposals[k])));

  const scoped = await T.organizeMemories({ dryRun: true, scope: '教训' });
  ok('scope 只数教训', /（范围：教训）/.test(scoped.text), scoped.text.split('\n')[0]);

  const applied = await T.organizeMemories({ dryRun: false });
  ok('dry_run=false 会说清自己做了什么', /已补|没有可自动补的关系边/.test(applied.text));

  let noKey = '';
  try {
    await T.reindexMemory({});
  } catch (err) {
    noKey = String(err && err.message);
  }
  ok('没有 Key 时重建会明确拒绝', /没有 embedding Key/.test(noKey), noKey.slice(0, 40));

  const S2 = await import(pathToFileURL(path.join(PKG, 'store.js')).href);
  eq('契约里仍是 8 个工具（organize/reindex 已实装）', S2.TOOL_NAMES.length, 8);
}

console.log('\n[27] 2.0 压缩后自动体检（阶段六）');
{
  ok('autoOrganize 导出可用', typeof T.autoOrganize === 'function');
  ok('体检报告文件在 .tidy 下', /organize\.json$/.test(T.ORGANIZE_FILE), T.ORGANIZE_FILE);
  eq('还没跑过时 snapshot.organize 是 null 或对象', ['object'].includes(typeof (await call(state, '/dsh-memory/status')).body.organize), true);

  const report = await T.autoOrganize('selfcheck');
  ok('体检能出报告', report && typeof report === 'object');
  eq('报告记下触发原因', report.reason, 'selfcheck');
  ['merge', 'split', 'drop', 'link'].forEach((k) => eq(`报告里的 ${k} 是数字`, typeof report[k], 'number'));
  ok('报告带耗时', typeof report.ms === 'number' && report.ms >= 0);
  ok('报告写进了 organize.json', fs.existsSync(T.ORGANIZE_FILE) && fs.readFileSync(T.ORGANIZE_FILE, 'utf8').includes('selfcheck'));

  const after = await call(state, '/dsh-memory/status');
  ok('状态接口带出上次体检', Boolean(after.body.organize) && after.body.organize.reason === 'selfcheck');
  ok('体检报告不进大纲', !/organize\.json|selfcheck/.test(T.outlineText()));
}

console.log('\n[28] 束稳态：目标可配 + 阈值随 PID 走');
{
  eq('束大小门槛默认 3', T.MERGE_BUNDLE_SIZE, 3);
  await call(state, '/dsh-memory/control', { target: 7 });
  eq('目标条数跟着 control.json 走（设 7 读 7）', T.pidTarget(), 7);

  const setSmall = await call(state, '/dsh-memory/control', { target: 12 });
  eq('目标条数能设成 12', setSmall.body.control.target, 12);
  eq('状态接口读回目标', (await call(state, '/dsh-memory/status')).body.control.target, 12);

  const clampLow = await call(state, '/dsh-memory/control', { target: 1 });
  eq('目标条数下限夹到 3', clampLow.body.control.target, 3);
  const clampHigh = await call(state, '/dsh-memory/control', { target: 9999 });
  eq('目标条数上限夹到 500', clampHigh.body.control.target, 500);
  await call(state, '/dsh-memory/control', { target: 50 });

  // 阈值 = μ + z·σ，z 随 PID 的 u 走：u 大（条目太少）→ 阈值抬高 → 少合并
  const mk = (u) => {
    fs.writeFileSync(T.PID_FILE, JSON.stringify({ turn: 1e9, integral: 0, prevErr: 0, u, tier: 2, total: 40 }));
  };
  const thresholdAt = async (u) => {
    mk(u);
    const r = await T.organizeMemories({ dryRun: true });
    return r.proposals.plan ? r.proposals.plan.threshold : null;
  };
  const hi = await thresholdAt(0.8);
  const lo = await thresholdAt(-0.8);
  ok('PID 的 u 越大，合并阈值越高（条目少 → 少合并）', hi !== null && lo !== null && hi > lo, `${hi} vs ${lo}`);
  eq('体检摘要里写明目标条数', /目标 \d+ 条/.test((await T.organizeMemories({ dryRun: true })).text), true);
}

console.log('\n[29] 2.0 摘要口径：一句话 summary + 独立 category');
{
  const body = '自检正文：这条只用来验证摘要口径。';
  const dup = '只比了关键词，判为无关，新建';

  const w1 = write.execute({
    name: 'tmp-summary',
    summary: '要改插件前端前先看这条',
    category: '资料',
    description: '自检用摘要条目',
    body,
    dup_check: dup,
  });
  ok('用 summary + category 能写入', /已记下/.test(String(w1?.text || '')), String(w1?.text || '').slice(0, 40));

  const idx = fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8');
  const row = idx.split(/\r?\n/).find((l) => l.includes('tmp-summary.md')) || '';
  ok('索引第 2 列存的是摘要', /\| `tmp-summary\.md` \| 要改插件前端前先看这条 \|/.test(row), row);
  ok('索引最后一列是分类', /\| 资料 \|\s*$/.test(row), row);

  const outline = T.outlineText();
  ok('大纲里带摘要、不再带分类前缀', /tmp-summary=要改插件前端前先看这条/.test(outline), outline.split('\n').find((l) => l.includes('tmp-summary')) || '');
  ok('大纲把它放进【资料】组', /【资料】[^\n]*tmp-summary=/.test(outline));

  let longErr = '';
  try {
    write.execute({ name: 'tmp-sum-long', summary: '甲'.repeat(41), category: '资料', description: '自检', body, dup_check: dup });
  } catch (err) {
    longErr = err.message;
  }
  ok('摘要超过 40 字被拒', /超过 40 字/.test(longErr), longErr);

  let catErr = '';
  try {
    write.execute({ name: 'tmp-cat-bad', summary: '分类写错也要拦住', category: '杂项', description: '自检', body, dup_check: dup });
  } catch (err) {
    catErr = err.message;
  }
  ok('非法分类被拒', /category 只能是/.test(catErr), catErr);

  let manualErr = '';
  try {
    write.execute({ name: 'tmp-cat-manual', summary: '模型不许自己写项目记忆', category: '项目记忆', description: '自检', body, dup_check: dup });
  } catch (err) {
    manualErr = err.message;
  }
  ok('模型通道不许写项目记忆', /只能由用户点/.test(manualErr), manualErr);

  // 旧口径仍能写：keywords 首段当分类，其余当摘要。
  write.execute({ name: 'tmp-legacy', keywords: '教训/删目录/清缓存', description: '自检旧口径', body, dup_check: dup });
  const row2 = fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8').split(/\r?\n/).find((l) => l.includes('tmp-legacy.md')) || '';
  ok('旧 keywords 写法仍可用，且分类落到最后一列', /\| 教训 \|\s*$/.test(row2), row2);

  for (const f of ['tmp-summary.md', 'tmp-legacy.md']) {
    try {
      fs.unlinkSync(path.join(MEM, f));
    } catch {
      /* 清不掉也不影响后续断言 */
    }
  }
}

if (process.env.DUMP_PROMPTS) {
  const inv = await call(state, '/dsh-memory/prompts');
  const lines = [
    '# 记忆插件：模型能看到的全部提示词',
    '',
    `> 自动生成，别手改：\`$env:DUMP_PROMPTS="<文件>" ; node tools/selfcheck.mjs\``,
    `> 当次口径：第 ${inv.body.tier} 套 / 条目 ${inv.body.total} 条 / 目标 ${inv.body.target} 条。`,
    '',
    `全部原文合计 **${inv.body.totalChars}** 字。记忆正文不在其中（那是数据，不是提示词）。`,
    '',
    '## 每次请求都发的部分',
    '',
  ];
  const always = [
    '系统提示词·大纲抬头',
    '系统提示词·大纲分组',
    '工具·memory_read',
    '工具·memory_source',
    '工具·memory_write',
    '工具·memory_update',
    '工具·memory_search',
    '工具·memory_reindex',
    '工具·memory_organize',
    '工具·memory_delete',
  ];
  const once = inv.body.items.filter((it) => always.includes(it.id));
  lines.push(`这 ${once.length} 段合计 **${once.reduce((n, it) => n + it.chars, 0)}** 字。`, '');
  for (const it of inv.body.items) {
    lines.push(`### ${it.id}（${it.chars} 字）`, '', `触发时机：${it.where}`, '', '```text', String(it.text || ''), '```', '');
  }
  fs.writeFileSync(process.env.DUMP_PROMPTS, lines.join('\n'), 'utf8');
  console.log(`提示词清单已写到 ${process.env.DUMP_PROMPTS}`);
}
console.log(`\n结果：${pass} 通过，${fails.length} 失败`);if (fails.length) {
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
