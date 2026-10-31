/**
 * Refresh data/universe.json: the top USDT perpetuals by 24h quote volume on BingX.
 * Used by the scheduled GitHub workflow, so the scanner does not rank 300 symbols
 * on every run.
 *
 * Usage: node tools/update-universe.mjs [--limit 100]
 */
import fs from 'node:fs';
import path from 'node:path';
import { topByVolume } from './bx.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
const LIMIT = Number(args.limit ?? 100);

console.log(`ranking top ${LIMIT} by 24h volume…`);
const top = await topByVolume(LIMIT, { concurrency: 6, onProgress: (done, total) => {
  if (done % 50 === 0) console.log(`  ${done}/${total}`);
} });

const dir = path.join(process.cwd(), 'data');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'universe.json'), JSON.stringify(top, null, 1));
console.log(`saved ${top.length} symbols to data/universe.json`);
console.log(`top 5: ${top.slice(0, 5).map((c) => `${c.symbol} $${Math.round(c.quoteVolume / 1e6)}M`).join(', ')}`);
