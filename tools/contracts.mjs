#!/usr/bin/env node
/**
 * 冻结契约的自检与速查表。
 *
 *   node tools/contracts.mjs          # 校验并打印工具/路由契约
 *   node tools/contracts.mjs --json   # 机器可读输出
 *
 * 阶段一交付物：这里通过 = 仓库骨架与工具契约没走形。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.dirname(HERE);
const S = await import(pathToFileURL(path.join(PKG, 'store.js')).href);

const { errors } = S.validateContracts();
const layout = S.storeLayout('/mem');
const manifest = S.emptyManifest({ model: 'text-embedding-v4', dim: 1024 });
const man = S.validateManifest(manifest);
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
const segCheck = S.validateSegment(seg);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ errors, tools: S.TOOL_CONTRACTS, routes: S.ROUTE_CONTRACTS, layout, manifestOk: man.ok, segmentOk: segCheck.ok }, null, 2));
} else {
  console.log(`dsh-memory 2.0 仓库骨架 v${S.STORE_VERSION}`);
  console.log('\n目录布局（记忆根目录下）:');
  for (const [k, v] of Object.entries(layout)) console.log(`  ${k.padEnd(9)} ${v}`);
  console.log('\n切分口径:', JSON.stringify(S.SEGMENT_RULES));
  console.log(`\n工具契约 ${S.TOOL_CONTRACTS.length} 个:`);
  for (const t of S.TOOL_CONTRACTS) {
    const req = Object.entries(t.params).filter(([, p]) => p.required).map(([k]) => k);
    console.log(`  ${t.name.padEnd(16)} 阶段 ${t.phase}  必填 ${req.join(',') || '—'}  · ${t.purpose}`);
  }
  console.log(`\n路由契约 ${S.ROUTE_CONTRACTS.length} 条:`);
  for (const r of S.ROUTE_CONTRACTS) console.log(`  ${r.method.padEnd(5)} ${r.path.padEnd(26)} 阶段 ${r.phase} · ${r.purpose}`);
  console.log('\n校验:');
  console.log(`  工具/路由契约   ${errors.length ? `✗ ${errors.length} 处问题` : '✓'}`);
  console.log(`  空清单形状     ${man.ok ? '✓' : `✗ ${man.errors.join('; ')}`}`);
  console.log(`  段记录形状     ${segCheck.ok ? '✓' : `✗ ${segCheck.errors.join('; ')}`}`);
  console.log(`  段 id 示例     ${seg.id}`);
  for (const e of errors) console.log(`  - ${e}`);
}

if (errors.length || !man.ok || !segCheck.ok) process.exitCode = 1;
