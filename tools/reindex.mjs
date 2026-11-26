#!/usr/bin/env node
/**
 * 建索引的 CLI（阶段二交付物）。
 *
 *   node tools/reindex.mjs                     # 全量增量重建（只算变了的段）
 *   node tools/reindex.mjs --names a,b         # 强制重算这两个文件，其余复用
 *   node tools/reindex.mjs --full              # 丢掉旧向量，全部重算
 *   node tools/reindex.mjs --out /tmp/x        # 写到别的目录（演练用，不动真库）
 *   node tools/reindex.mjs --dry               # 只算不写
 *
 * Key 来源：DSH_MEMORY_EMBED_KEY，或本机 ~/.bailian/config.json 的 api_key。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, embedTexts, readIndex, resolveEmbedConfig, stripFrontmatter, writeIndex } from '../indexer.js';

const argv = process.argv.slice(2);
const arg = (flag, dflt = '') => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (flag) => argv.includes(flag);

const DSH_HOME = arg('--home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const MEM = path.join(DSH_HOME, 'memory');
const OUT = arg('--out', MEM);
const names = arg('--names')
  .split(/[、,;\s]+/)
  .filter(Boolean)
  .map((n) => n.replace(/\.md$/, ''));
const only = names.length ? new Set(names) : null;

function readEntries() {
  const indexPath = path.join(MEM, 'MEMORY.md');
  const text = fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 8) continue;
    const file = cells[1].replace(/`/g, '');
    if (!/\.md$/.test(file) || file === 'MEMORY.md') continue;
    const enabled = cells[3].replace(/`/g, '') !== '否';
    rows.push({ file, keywords: cells[2].replace(/`/g, ''), enabled });
  }
  return rows;
}

const CATS = ['资料', '教训', '说明书', '项目记忆', '其它'];
const files = [];
for (const row of readEntries()) {
  if (only && !only.has(row.file.replace(/\.md$/, ''))) continue;
  // 与宿主 ensureIndex() 用同一份正文（去 YAML 头），否则哈希永远对不上、每次重建都全量
  const body = stripFrontmatter(fs.readFileSync(path.join(MEM, row.file), 'utf8'));
  const head = String(row.keywords || '').split('/')[0].trim();
  files.push({
    name: row.file.replace(/\.md$/, ''),
    file: row.file,
    body,
    summary: row.keywords,
    keywords: row.keywords,
    category: CATS.includes(head) ? head : '其它',
  });
}
if (!files.length) {
  console.error('没有要索引的文件');
  process.exit(1);
}

const cfg = resolveEmbedConfig();
if (!cfg.apiKey) {
  console.error('没有 embedding Key：设 DSH_MEMORY_EMBED_KEY，或让 ~/.bailian/config.json 里有 api_key');
  process.exit(1);
}

const chars = files.reduce((n, f) => n + Array.from(f.body).length, 0);
console.log(`参与：${files.length} 条 / ${chars} 字；模型 ${cfg.model}（${cfg.dim} 维），key ${cfg.masked}`);
const built = await buildIndex(files, readIndex(OUT), {
  full: has('--full'),
  force: names,
  model: cfg.model,
  dim: cfg.dim,
  embed: (texts) => embedTexts(texts, cfg),
});
const s = built.stats;
console.log(`切段 ${s.segments}｜新嵌入 ${s.embedded}｜复用 ${s.reused}｜耗时 ${s.ms}ms`);
if (has('--dry')) {
  console.log('--dry：没有写盘');
} else {
  const layout = writeIndex(OUT, built);
  console.log(`已写入 ${layout.root}`);
}
