/**
 * dsh-memory 2.0 · 索引器（阶段二）
 *
 * 职责：把记忆正文切成「小节段」→ 批量嵌入 → 落盘 .index/。
 * 约束：
 *  - 正文是唯一真源，索引可整目录删除重建；
 *  - 增量靠「段 id（名称#序号@内容哈希）」+ 旧向量复用，内容没变就不重复花钱；
 *  - 不读环境外的密钥、不打印正文、不碰 MEMORY.md。
 *
 * 这个模块只依赖 store.js 与 node 内置模块，方便单测与离线跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEMORY_BODY_MAX, bodyChars, embedText, makeSegment, segmentId, storeLayout, SEGMENT_RULES, emptyManifest, validateManifest } from './store.js';

export const EMBED_DEFAULTS = {
  model: 'text-embedding-v4',
  dim: 1024,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  batchSize: 10, // 百炼 text-embedding-v4 单请求 ≤10 条
  timeoutMs: 30000,
};

/** 正文 → 小节列表。按 `## ` 切；超长小节按空行再切；过短的丢弃。 */
export function splitSections(body) {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const parts = [];
  const re = /^##\s+(.*)$/gm;
  let match;
  const marks = [];
  while ((match = re.exec(text))) marks.push({ heading: match[1].trim(), start: match.index, bodyStart: re.lastIndex });
  if (!marks.length) {
    const only = text.trim();
    return only ? [{ heading: '', text: only }] : [];
  }
  // 首个 `##` 之前的内容（YAML 之外通常为空）当作前言，附着在第一节之前
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const chunk = text.slice(marks[i].bodyStart, end).trim();
    if (chunk) parts.push({ heading: marks[i].heading, text: chunk });
  }
  return parts;
}

/** 单个小节超长时按空行再切，避免一次嵌入吃掉整条记忆。 */
export function splitLong(text, maxChars = SEGMENT_RULES.maxChars) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return [text];
  const paras = String(text).split(/\n{2,}/);
  const out = [];
  let buf = '';
  for (const para of paras) {
    const next = buf ? `${buf}\n\n${para}` : para;
    if (Array.from(next).length > maxChars && buf) {
      out.push(buf);
      buf = para;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function hashText(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 一条记忆 → 段记录（还没算向量）。
 * 默认**整条入库**：一条记忆 = 一个向量，检索命中即整条，不需要再拼段。
 * 只有超过 MEMORY_BODY_MAX 的遗留条目才退回按小节切，并标 split:true。
 */
export function buildSegments(entry) {
  const name = String(entry.name || '').replace(/\.md$/, '');
  const file = entry.file || `${name}.md`;
  const summary = entry.summary || entry.keywords || '';
  const category = entry.category || String(entry.keywords || '').split('/')[0] || '其它';
  const body = String(entry.body || '');
  const whole = Array.from(body.trim()).join('');
  const fits = bodyChars(whole) <= MEMORY_BODY_MAX;
  const base = { name, file, keywords: summary, category, summary };

  if (fits && Array.from(whole).length >= SEGMENT_RULES.minChars) {
    const hash = hashText(whole);
    return [makeSegment({ ...base, ordinal: 1, heading: '', text: whole, hash })];
  }

  const segs = [];
  let ordinal = 0;
  for (const section of splitSections(body)) {
    for (const piece of splitLong(section.text)) {
      if (Array.from(piece).length < SEGMENT_RULES.minChars) continue;
      ordinal += 1;
      segs.push(
        makeSegment({
          ...base,
          ordinal,
          heading: section.heading,
          text: piece,
          hash: hashText(`${section.heading}\n${piece}`),
          split: true,
        }),
      );
    }
  }
  return segs;
}

/** 嵌入用文本：名称 | 分类 | 摘要 | 小节标题 + 正文。 */
export function segmentEmbedText(seg) {
  return embedText({
    name: seg.name,
    category: seg.category,
    summary: seg.summary || seg.keywords || '',
    heading: seg.heading,
    text: seg.text,
  });
}

export function l2normalize(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => Math.fround(v / norm));
}

/**
 * 百炼的 base_url 多半只写到域名（`https://dashscope.aliyuncs.com`），
 * 这里补成 OpenAI 兼容端点；已经带 `/compatible-mode` 或 `/v1` 的原样用。
 */
export function embedEndpoint(baseUrl) {
  const base = String(baseUrl || EMBED_DEFAULTS.baseUrl).replace(/\/+$/, '');
  if (/\/(compatible-mode|api)\/v\d+/.test(base) || /\/embeddings$/.test(base)) return `${base.replace(/\/embeddings$/, '')}/embeddings`;
  return `${base}/compatible-mode/v1/embeddings`;
}

/** 批量嵌入：每批 ≤10 条，失败重试一次，返回与输入等长的向量数组。 */
export async function embedTexts(texts, options = {}) {
  const cfg = { ...EMBED_DEFAULTS, ...options };
  if (!cfg.apiKey) throw new Error('没有配置 embedding API Key');
  const out = [];
  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    const batch = texts.slice(i, i + cfg.batchSize);
    const body = {
      model: cfg.model,
      input: batch,
      dimensions: cfg.dim,
      encoding_format: 'float',
    };
    let payload = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const res = await (cfg.fetchImpl || fetch)(embedEndpoint(cfg.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`embedding HTTP ${res.status}: ${String(text).slice(0, 160)}`);
          err.status = res.status;
          throw err;
        }
        payload = JSON.parse(text);
        break;
      } catch (err) {
        lastErr = err;
        const retriable = !err.status || err.status >= 500 || err.status === 429 || err.name === 'AbortError';
        if (!retriable) break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!payload) throw lastErr || new Error('embedding 请求失败');
    const data = Array.isArray(payload.data) ? payload.data : [];
    for (const item of data) {
      const vec = Array.isArray(item.embedding) ? item.embedding : null;
      if (!vec) throw new Error('embedding 回包里没有向量');
      out.push(vec.length === cfg.dim ? vec : vec.slice(0, cfg.dim));
    }
  }
  if (out.length !== texts.length) throw new Error(`embedding 数量对不上：要 ${texts.length} 条，拿到 ${out.length} 条`);
  return out;
}

export function readIndex(memDir) {
  const layout = storeLayout(memDir);
  const manifestRaw = fs.existsSync(layout.manifest) ? JSON.parse(fs.readFileSync(layout.manifest, 'utf8')) : null;
  const segments = fs.existsSync(layout.segments)
    ? fs
        .readFileSync(layout.segments, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  let vectors = [];
  if (manifestRaw && fs.existsSync(layout.vectors)) {
    const buf = fs.readFileSync(layout.vectors);
    const dim = Number(manifestRaw.dim) || 0;
    if (dim > 0) {
      const count = Math.floor(buf.length / (dim * 4));
      for (let i = 0; i < count; i += 1) {
        const slice = buf.subarray(i * dim * 4, (i + 1) * dim * 4);
        vectors.push(new Float32Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)));
      }
    }
  }
  return { layout, manifest: manifestRaw, segments, vectors };
}

/**
 * 建索引。
 * files: [{ name, file, body, summary?, keywords?, category? }]  —— 本次参与建索引的文件
 * prev:  readIndex() 的结果（增量复用旧向量）
 * opts:  { full, model, dim, embed: async (texts) => vectors }
 */
export async function buildIndex(files, prev, opts = {}) {
  const model = opts.model || prev?.manifest?.model || EMBED_DEFAULTS.model;
  const dim = opts.dim || prev?.manifest?.dim || EMBED_DEFAULTS.dim;
  const embed = opts.embed;
  const full = Boolean(opts.full);
  const force = new Set((opts.force || []).map((n) => String(n).replace(/\.md$/, '')));
  const started = Date.now();

  const prevById = new Map();
  if (!full && prev?.manifest?.model === model && prev?.manifest?.dim === dim) {
    prev.segments.forEach((seg, i) => {
      const vec = prev.vectors[i];
      if (vec && vec.length === dim) prevById.set(seg.id, vec);
    });
  }

  const nextSegments = [];
  const needText = [];
  const needSlot = [];
  for (const file of files) {
    for (const seg of buildSegments(file)) {
      const slot = nextSegments.length;
      nextSegments.push(seg);
      if (force.has(seg.name) || !prevById.has(seg.id)) {
        needText.push(segmentEmbedText(seg));
        needSlot.push(slot);
      }
    }
  }

  let embedded = 0;
  const fresh = needText.length && embed ? await embed(needText) : [];
  const bySlot = new Map();
  needSlot.forEach((slot, i) => {
    const vec = fresh[i];
    if (!vec || vec.length !== dim) throw new Error(`向量维度不对：要 ${dim}，拿到 ${vec ? vec.length : 0}`);
    bySlot.set(slot, l2normalize(vec));
    embedded += 1;
  });

  const vectors = [];
  const outSegments = nextSegments.map((seg, slot) => {
    const vec = bySlot.get(slot) || prevById.get(seg.id);
    const normalized = bySlot.has(slot) ? vec : vec;
    vectors.push(normalized);
    return { ...seg, voff: slot * dim * 4, vlen: dim * 4 };
  });

  const manifest = {
    ...emptyManifest({ model, dim }),
    builtAt: new Date().toISOString(),
    source: { files: files.length, segments: outSegments.length },
    files: {},
  };
  for (const file of files) {
    const name = String(file.name || '').replace(/\.md$/, '');
    manifest.files[`${name}.md`] = {
      hash: hashText(String(file.body || '')),
      segments: outSegments.filter((s) => s.name === name).map((s) => s.id),
    };
  }
  const check = validateManifest(manifest);
  if (!check.ok) throw new Error(`清单不合法：${check.errors.join('; ')}`);

  const buf = Buffer.alloc(outSegments.length * dim * 4);
  vectors.forEach((vec, i) => {
    if (!vec) throw new Error(`第 ${i} 段缺向量`);
    Buffer.from(Float32Array.from(vec).buffer).copy(buf, i * dim * 4);
  });

  return {
    manifest,
    segments: outSegments,
    buffer: buf,
    stats: {
      files: files.length,
      segments: outSegments.length,
      embedded,
      reused: outSegments.length - embedded,
      dim,
      model,
      ms: Date.now() - started,
    },
  };
}

export function writeIndex(memDir, built) {
  const layout = storeLayout(memDir);
  fs.mkdirSync(layout.root, { recursive: true });
  fs.writeFileSync(layout.vectors, built.buffer);
  fs.writeFileSync(layout.segments, built.segments.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(layout.manifest, JSON.stringify(built.manifest, null, 2) + '\n', 'utf8');
  return layout;
}

/** 从本机百炼配置里取 key（只读，不外传；返回时打码）。 */
export function resolveEmbedConfig(env = process.env) {
  // 离线自检用：强制「没有 Key」的分支，免得测试真去调百炼
  if (env.DSH_MEMORY_NO_EMBED === '1') {
    return {
      apiKey: '',
      baseUrl: EMBED_DEFAULTS.baseUrl,
      model: env.DSH_MEMORY_EMBED_MODEL || EMBED_DEFAULTS.model,
      dim: Number(env.DSH_MEMORY_EMBED_DIM || EMBED_DEFAULTS.dim) || EMBED_DEFAULTS.dim,
      masked: '',
    };
  }
  let apiKey = env.DSH_MEMORY_EMBED_KEY || '';
  let baseUrl = env.DSH_MEMORY_EMBED_BASE || '';
  if (!apiKey) {
    try {
      const cfgPath = path.join(env.USERPROFILE || env.HOME || '', '.bailian', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        apiKey = cfg.api_key || '';
        baseUrl = baseUrl || cfg.base_url || '';
      }
    } catch {
      /* 读不到就当没配置 */
    }
  }
  const model = env.DSH_MEMORY_EMBED_MODEL || EMBED_DEFAULTS.model;
  const dim = Number(env.DSH_MEMORY_EMBED_DIM || EMBED_DEFAULTS.dim) || EMBED_DEFAULTS.dim;
  return {
    apiKey,
    baseUrl: baseUrl || EMBED_DEFAULTS.baseUrl,
    model,
    dim,
    masked: apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : '',
  };
}
