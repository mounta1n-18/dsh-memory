/**
 * dsh-memory 2.0 —— 记忆仓库骨架（阶段一）
 *
 * 这一版**只定义结构与契约**，不做任何读写、不算向量、不碰现有记忆。
 * 目的是把后面六阶段要往哪儿放、放成什么样先钉死，避免填内容时返工。
 *
 * 设计要点：
 * 1. Markdown 正文永远是唯一真源；下面这些全是可删可重建的派生物。
 * 2. 段（segment）= 一条记忆里的一个 `## ` 小节；超长的按空行再切，overlap = 0。
 * 3. 向量只落在 `.index/vectors.bin`，段记录里只存偏移与长度，便于整目录删除重建。
 * 4. 工具契约以数据形式冻结在这里，自检与 `tools/contracts.mjs` 都读同一份。
 */

export const STORE_VERSION = 1;
export const STORE_DIRNAME = '.index';

/** 段切分口径（阶段二/七会用到，先钉死） */
export const SEGMENT_RULES = {
  splitOn: '## ',
  maxChars: 500, // 单段超过这个字数，按空行二次切
  overlap: 0, // 不做重叠：只增体积，不增召回
  minChars: 24, // 更短的段并进上一段，避免碎句
};

/** 仓库目录布局。入参是记忆根目录（默认 ~/.dsh/memory）。 */
export function storeLayout(memDir) {
  const root = join(memDir, STORE_DIRNAME);
  return {
    root,
    manifest: join(root, 'manifest.json'),
    segments: join(root, 'segments.jsonl'),
    vectors: join(root, 'vectors.bin'),
    lock: join(root, 'build.lock'),
  };
}

function join(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

/** 空清单：一次全量重建的起点。 */
export function emptyManifest({ model = '', dim = 0 } = {}) {
  return {
    version: STORE_VERSION,
    model,
    dim,
    metric: 'cosine',
    normalize: 'l2',
    builtAt: null,
    source: { files: 0, segments: 0 },
    vectorFile: { name: 'vectors.bin', bytes: 0, unit: 4 },
    files: {},
  };
}

/** 清单校验：返回 { ok, errors }，不抛异常，方便自检与面板显示。 */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest 不是对象'] };
  if (m.version !== STORE_VERSION) errors.push(`version 应为 ${STORE_VERSION}`);
  if (!Number.isInteger(m.dim) || m.dim <= 0) errors.push('dim 必须是正整数');
  if (m.normalize !== 'l2') errors.push('normalize 只支持 l2');
  if (m.metric !== 'cosine') errors.push('metric 只支持 cosine');
  if (!m.files || typeof m.files !== 'object') errors.push('files 必须是对象');
  if (m.vectorFile && m.vectorFile.unit !== 4) errors.push('向量单元必须是 4 字节（float32）');
  for (const [file, info] of Object.entries(m.files || {})) {
    if (!/\.md$/.test(file)) errors.push(`files 的键必须是 .md：${file}`);
    if (!info || typeof info.hash !== 'string') errors.push(`${file} 缺少 hash`);
    if (!Array.isArray(info.segments)) errors.push(`${file} 的 segments 必须是数组`);
  }
  return { ok: errors.length === 0, errors };
}

/** 段 id：名称 + 序号 + 正文哈希前 8 位，便于增量时对齐。 */
export function segmentId({ name, ordinal, hash }) {
  return `${name}#${String(ordinal).padStart(3, '0')}@${String(hash || '').slice(0, 8)}`;
}

/** 一行 segments.jsonl 的形状。 */
export function makeSegment(input) {
  const {
    name,
    file,
    ordinal = 0,
    heading = '',
    text = '',
    hash = '',
    keywords = '',
    category = '',
    voff = null,
    vlen = 0,
  } = input || {};
  return {
    id: segmentId({ name, ordinal, hash }),
    name,
    file,
    ordinal,
    heading,
    chars: Array.from(text).length,
    text,
    hash,
    keywords,
    category,
    voff,
    vlen,
  };
}

export function validateSegment(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return { ok: false, errors: ['段不是对象'] };
  if (!s.id) errors.push('缺少 id');
  if (!s.name) errors.push('缺少 name');
  if (!/\.md$/.test(s.file || '')) errors.push('file 必须是 .md');
  if (!Number.isInteger(s.ordinal) || s.ordinal < 0) errors.push('ordinal 必须是非负整数');
  if (typeof s.text !== 'string' || !s.text) errors.push('text 不能为空');
  if (s.chars !== Array.from(s.text || '').length) errors.push('chars 与 text 长度不符');
  if (s.voff !== null && !Number.isInteger(s.voff)) errors.push('voff 只能是 null 或整数');
  if (!Number.isInteger(s.vlen) || s.vlen < 0) errors.push('vlen 必须是非负整数');
  return { ok: errors.length === 0, errors };
}

/** 嵌入用的文本：名称 | 分类 | 摘要 | 小节标题 + 正文。阶段二照这个拼。 */
export function embedText({ name, category, summary, keywords, heading, text }) {
  const head = [name, category, summary || keywords || '', heading].filter(Boolean).join(' | ');
  return head ? `${head}\n${text}` : String(text || '');
}

/**
 * 工具契约（冻结）。
 * phase：哪一阶段真正实现；在此之前一律返回「未实现」，不产生副作用。
 * returns：模型看到的文本串 + 可选的机器可读字段（Host 内部用）。
 */
export const TOOL_CONTRACTS = [
  {
    name: 'memory_read',
    phase: 3,
    purpose: '读一条或多条记忆正文',
    params: {
      file: { type: 'string', required: true, note: '名称，可一次传多个（、,;；换行 分隔），最多 6 条' },
    },
    returns: { text: 'string', fields: ['files', 'missing'] },
  },
  {
    name: 'memory_source',
    phase: 3,
    purpose: '查项目记忆的来源会话原始上下文（meta/read/find）',
    params: {
      name: { type: 'string', required: true, note: '项目记忆名' },
      mode: { type: 'string', required: false, enum: ['meta', 'read', 'find'], note: '默认 meta，不吐正文' },
      offset: { type: 'integer', required: false, note: 'mode=read 的字符起点' },
      limit: { type: 'integer', required: false, note: 'mode=read 的长度，200~20000，默认 4000' },
      pattern: { type: 'string', required: false, note: 'mode=find 的匹配串' },
    },
    returns: { text: 'string', fields: ['session', 'chars'] },
  },
  {
    name: 'memory_write',
    phase: 3,
    purpose: '新建一条记忆（落盘前查重、分类与长度校验）',
    params: {
      name: { type: 'string', required: true, note: '英文小写连字符' },
      keywords: { type: 'string', required: true, note: '2.0 起改为一句话摘要（≤40 字），分类单独给' },
      category: { type: 'string', required: false, enum: ['教训', '资料', '说明书', '项目记忆', '其它'] },
      description: { type: 'string', required: true, note: '一句话说明这是什么' },
      body: { type: 'string', required: true, note: '完整正文（Markdown）' },
      dup_check: { type: 'string', required: true, note: '必填：自己判断的查重结论，提到名字必须读过' },
      session: { type: 'string', required: false, note: '项目记忆的来源会话号' },
    },
    returns: { text: 'string', fields: ['file', 'bytes'] },
  },
  {
    name: 'memory_update',
    phase: 3,
    purpose: '订正或追加已有记忆',
    params: {
      name: { type: 'string', required: true, note: '已有记忆名' },
      body: { type: 'string', required: false, note: '新正文；append=true 时作为追加段' },
      description: { type: 'string', required: false, note: '新的说明' },
      keywords: { type: 'string', required: false, note: '新的一句话摘要（≤40 字）' },
      append: { type: 'boolean', required: false, note: 'true = 追加到正文末尾' },
    },
    returns: { text: 'string', fields: ['file', 'mode'] },
  },
  {
    name: 'memory_delete',
    phase: 3,
    purpose: '删除一条记忆（正文文件直接删，不可回滚；流水留底）',
    params: { name: { type: 'string', required: true, note: '要删的记忆名' } },
    returns: { text: 'string', fields: ['file'] },
  },
  {
    name: 'memory_search',
    phase: 3,
    purpose: '语义 + 关键词混合检索；只回名称/小节/分/摘要，正文用 memory_read 取',
    params: {
      query: { type: 'string', required: true, note: '自然语言查询' },
      k: { type: 'integer', required: false, note: '返回条数，默认 5，最大 20' },
      mode: { type: 'string', required: false, enum: ['hybrid', 'vector', 'bm25'], note: '默认 hybrid' },
      min_score: { type: 'number', required: false, note: '低于这个分就不回' },
    },
    returns: { text: 'string', fields: ['hits', 'lowConfidence', 'degraded'] },
  },
  {
    name: 'memory_organize',
    phase: 6,
    purpose: '整理：合并重复、拆分过长、刷新摘要与关系边（默认 dry_run）',
    params: {
      dry_run: { type: 'boolean', required: false, note: '默认 true，只出提案不动文件' },
      scope: { type: 'string', required: false, note: '按分类或名称前缀限定范围' },
    },
    returns: { text: 'string', fields: ['proposals'] },
  },
  {
    name: 'memory_reindex',
    phase: 2,
    purpose: '重建索引：切段 → 嵌入 → 落盘（可增量）',
    params: {
      full: { type: 'boolean', required: false, note: 'true = 忽略缓存全量重算' },
      names: { type: 'array', required: false, note: '只重建这几条' },
    },
    returns: { text: 'string', fields: ['files', 'segments', 'tokens', 'ms'] },
  },
];

export const TOOL_NAMES = TOOL_CONTRACTS.map((t) => t.name);

/** 路由契约（HTTP 面向上设置页与自检）。 */
export const ROUTE_CONTRACTS = [
  { path: '/dsh-memory/status', method: 'GET', phase: 1, purpose: '面板快照' },
  { path: '/dsh-memory/create', method: 'POST', phase: 1, purpose: '面板新建（人工通道）' },
  { path: '/dsh-memory/keep', method: 'POST', phase: 1, purpose: '保留：刷新复核日' },
  { path: '/dsh-memory/control', method: 'POST', phase: 1, purpose: '口径模式与档位' },
  { path: '/dsh-memory/prompts', method: 'GET', phase: 1, purpose: '提示词检视' },
  { path: '/dsh-memory/calls', method: 'GET', phase: 1, purpose: '调用流水' },
  { path: '/dsh-memory/call', method: 'GET', phase: 1, purpose: '单条详情' },
  { path: '/dsh-memory/reindex', method: 'POST', phase: 2, purpose: '重建索引（阶段二接上）' },
  { path: '/dsh-memory/search', method: 'POST', phase: 3, purpose: '面板试搜（阶段三接上）' },
];

/** 契约自检：唯一性、命名前缀、参数形状、阶段号。返回 { ok, errors }。 */
export function validateContracts() {
  const errors = [];
  const seen = new Set();
  for (const t of TOOL_CONTRACTS) {
    if (seen.has(t.name)) errors.push(`工具重名：${t.name}`);
    seen.add(t.name);
    if (!/^memory_[a-z]+$/.test(t.name)) errors.push(`工具名不合规：${t.name}`);
    if (!Number.isInteger(t.phase) || t.phase < 1 || t.phase > 7) errors.push(`${t.name} 的 phase 越界`);
    if (!t.purpose) errors.push(`${t.name} 缺少 purpose`);
    const params = t.params || {};
    if (!Object.keys(params).length) errors.push(`${t.name} 没有参数`);
    for (const [key, p] of Object.entries(params)) {
      if (!p.type) errors.push(`${t.name}.${key} 缺少 type`);
      if (!['string', 'integer', 'number', 'boolean', 'array', 'object'].includes(p.type)) {
        errors.push(`${t.name}.${key} 的类型不支持：${p.type}`);
      }
      if (p.enum && !Array.isArray(p.enum)) errors.push(`${t.name}.${key} 的 enum 必须是数组`);
    }
    if (!t.returns || typeof t.returns.text !== 'string') errors.push(`${t.name} 缺少 returns.text`);
  }
  const routes = new Set();
  for (const r of ROUTE_CONTRACTS) {
    if (routes.has(`${r.method} ${r.path}`)) errors.push(`路由重复：${r.method} ${r.path}`);
    routes.add(`${r.method} ${r.path}`);
    if (!r.path.startsWith('/dsh-memory/')) errors.push(`路由前缀不对：${r.path}`);
  }
  return { ok: errors.length === 0, errors };
}
