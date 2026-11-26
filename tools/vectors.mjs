#!/usr/bin/env node
/**
 * 向量夹角查看器：人工查询「哪条记忆跟哪条记忆像」。
 *
 *   node tools/vectors.mjs --list                 # 列出所有相似对（默认 ≥0.55）
 *   node tools/vectors.mjs --top noahs-ark -k 5   # 这条记忆最像的 5 条
 *   node tools/vectors.mjs --pair a,b             # 两条记忆的夹角
 *   node tools/vectors.mjs --out /tmp/x --list    # 看演练目录里的索引
 *
 * 余弦相似度 = 夹角余弦；向量在入库时已做 L2 归一化，所以点积就是余弦。
 * 角度换算：cos 0.90≈25.8°、0.80≈36.9°、0.70≈45.6°、0.55≈56.6°、0.50≈60°。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readIndex } from '../indexer.js';

const argv = process.argv.slice(2);
const arg = (flag, dflt = '') => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (flag) => argv.includes(flag);

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const MEM = arg('--mem', path.join(HOME, 'memory'));
const OUT = arg('--out', MEM);
const minScore = Number(arg('--min', '0.55'));
const k = Math.max(1, Number(arg('--k', arg('-k', '5'))) || 5);

const idx = readIndex(OUT);
if (!idx.manifest || !idx.segments.length) {
  console.error(`没有索引：${OUT}/.index —— 先跑 node tools/reindex.mjs`);
  process.exit(1);
}

/** 按文件聚合：一条记忆可能有多段（只有超长遗留条目才会），取该条所有段向量的平均。 */
const byFile = new Map();
idx.segments.forEach((seg, i) => {
  const vec = idx.vectors[i];
  if (!vec) return;
  const cur = byFile.get(seg.file) || { file: seg.file, sum: new Float64Array(vec.length), n: 0, chars: 0, split: false };
  for (let d = 0; d < vec.length; d += 1) cur.sum[d] += vec[d];
  cur.n += 1;
  cur.chars += seg.chars;
  cur.split = cur.split || Boolean(seg.split);
  byFile.set(seg.file, cur);
});
const entries = [...byFile.values()].map((e) => {
  const vec = Float32Array.from(e.sum, (v) => v / (e.n || 1));
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return { file: e.file, vec: Float32Array.from(vec, (v) => v / norm), n: e.n, chars: e.chars, split: e.split };
});
const byName = new Map(entries.map((e) => [path.basename(e.file, '.md'), e]));

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}
const deg = (cos) => (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
const f3 = (x) => x.toFixed(3);

function label(file) {
  return path.basename(file, '.md');
}

const pairArg = arg('--pair');
if (pairArg) {
  const [x, y] = pairArg.split(/[,，]/).map((s) => s.trim().replace(/\.md$/, ''));
  const a = byName.get(x);
  const b = byName.get(y);
  if (!a || !b) {
    console.error(`找不到：${[!a ? x : '', !b ? y : ''].filter(Boolean).join(', ')}`);
    process.exit(1);
  }
  const cos = cosine(a.vec, b.vec);
  console.log(`${x}  ↔  ${y}`);
  console.log(`余弦 ${f3(cos)}   夹角 ${deg(cos).toFixed(1)}°   （0° 完全同向，90° 完全无关）`);
  process.exit(0);
}

const topArg = arg('--top');
if (topArg) {
  const name = topArg.replace(/\.md$/, '');
  const me = byName.get(name);
  if (!me) {
    console.error(`找不到：${name}`);
    process.exit(1);
  }
  const rows = entries
    .filter((e) => e.file !== me.file)
    .map((e) => ({ file: e.file, cos: cosine(me.vec, e.vec) }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, k);
  console.log(`${name}（${me.chars} 字，${me.n} 段）最像的 ${rows.length} 条：`);
  for (const r of rows) console.log(`  ${f3(r.cos)}  ${deg(r.cos).toFixed(1).padStart(5)}°  ${label(r.file)}`);
  process.exit(0);
}

// 默认 / --list：列出所有高分对，顺便给出「可以考虑并成一条」的候选
const pairs = [];
for (let i = 0; i < entries.length; i += 1) {
  for (let j = i + 1; j < entries.length; j += 1) {
    const cos = cosine(entries[i].vec, entries[j].vec);
    if (cos >= minScore) pairs.push({ a: entries[i], b: entries[j], cos });
  }
}
pairs.sort((x, y) => y.cos - x.cos);
console.log(
  `索引：${idx.manifest.model} / ${idx.manifest.dim} 维 / ${entries.length} 条记忆（${idx.segments.length} 段）｜阈值 cos ≥ ${minScore}`,
);
if (!pairs.length) {
  console.log('没有超过阈值的记忆对——这个库分得挺开。');
} else {
  console.log(`\n相似记忆对（${pairs.length} 对，从高到低）：`);
  for (const p of pairs) {
    console.log(`  ${f3(p.cos)}  ${deg(p.cos).toFixed(1).padStart(5)}°  ${label(p.a.file)}  ↔  ${label(p.b.file)}`);
  }
  console.log('\n参考：≥0.75 值得人工看一眼要不要合并；0.55~0.75 多半只是同主题不同侧面。');
}
if (entries.some((e) => e.split)) {
  console.log(`\n注意：${entries.filter((e) => e.split).length} 条超过 2000 字上限，索引里仍是分段模式。`);
}
