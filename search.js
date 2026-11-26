/**
 * dsh-memory 2.0 · 检索（阶段三）
 *
 * 三件事，全部纯函数，方便单测：
 *  1. 分词：中文按「字符 bigram」，英文按整词 —— 中文分词器对小库没有增益（实测 bigram 精确率更高），且零依赖。
 *  2. BM25：字面打分，负责「名字、缩写、报错原文、路径」这类向量捞不到的东西。
 *  3. RRF：把 BM25 与向量的排名融合，不比较两家分数量纲（它们本来就不可比）。
 *
 * 注意：这里不读文件、不调网络；取索引、算 query 向量由调用方传进来。
 */

/** 中英混合分词：中文 2 字滑窗，英文/数字整词，全小写。 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const word of s.match(/[a-z0-9][a-z0-9_.-]*/g) || []) {
    if (word.length > 1) out.push(word);
  }
  const cjk = s.replace(/[^\u4e00-\u9fff]+/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    const chars = Array.from(run);
    if (chars.length === 1) {
      out.push(chars[0]);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
    // 也收整段（滑窗查不到的长词靠它兜底）
    if (chars.length <= 8) out.push(run);
  }
  return out;
}

/**
 * BM25。
 * docs: [{ id, text }]，返回 [{ id, score }]（降序，分数 >0）。
 * 参数取常见默认：k1=1.2、b=0.75。
 */
export function bm25Rank(docs, query, { k1 = 1.2, b = 0.75, limit = 0 } = {}) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length || !docs.length) return [];
  const docTerms = docs.map((doc) => {
    const tf = new Map();
    for (const term of tokenize(doc.text)) tf.set(term, (tf.get(term) || 0) + 1);
    return { doc, tf, len: [...tf.values()].reduce((a, c) => a + c, 0) };
  });
  const avgdl = docTerms.reduce((n, d) => n + d.len, 0) / docTerms.length || 1;
  const df = new Map();
  for (const term of qTerms) {
    let n = 0;
    for (const d of docTerms) if (d.tf.has(term)) n += 1;
    df.set(term, n);
  }
  const N = docTerms.length;
  const scored = [];
  for (const d of docTerms) {
    let score = 0;
    for (const term of qTerms) {
      const f = d.tf.get(term) || 0;
      if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgdl));
    }
    if (score > 0) scored.push({ id: d.doc.id, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return limit > 0 ? scored.slice(0, limit) : scored;
}

/** 余弦排序：vectors 与 qvec 都已 L2 归一化时，点积即余弦。 */
export function cosineRank(vectors, qvec, { limit = 0, minScore = 0 } = {}) {
  const scored = [];
  for (const { id, vec } of vectors) {
    if (!vec || vec.length !== qvec.length) continue;
    let dot = 0;
    for (let i = 0; i < qvec.length; i += 1) dot += qvec[i] * vec[i];
    if (dot >= minScore) scored.push({ id, score: dot });
  }
  scored.sort((x, y) => y.score - x.score);
  return limit > 0 ? scored.slice(0, limit) : scored;
}

/**
 * Reciprocal Rank Fusion。
 * lists: [[{id, score}], ...]，返回 [{ id, score, ranks:[...] }]。
 * 只看名次，不看分数——两家分数量纲不可比，融分必须先抹掉量纲。
 */
export function rrfFuse(lists, { k = 60, limit = 0 } = {}) {
  const acc = new Map();
  lists.forEach((list, li) => {
    list.forEach((item, rank) => {
      const cur = acc.get(item.id) || { id: item.id, score: 0, ranks: [] };
      cur.score += 1 / (k + rank + 1);
      cur.ranks[li] = { rank: rank + 1, score: item.score };
      acc.set(item.id, cur);
    });
  });
  const out = [...acc.values()].sort((x, y) => y.score - x.score);
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 把一条记忆压成一行摘要（给检索结果用，别把正文倒给模型）。 */
export function oneLineSummary(text, max = 80) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}
