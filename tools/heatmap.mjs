/**
 * Liquidation-map scanner: detects a one-sided liquidation imbalance ("перевес")
 * and alerts when it is strong enough to matter.
 *
 * Data source, in order of preference:
 *   1. Coinglass API      (CG_API_KEY in .env)
 *   2. CoinAnk API        (COINANK_API_KEY in .env)
 *   3. Free reconstruction from BingX 1h candles (no key needed)
 *
 * Usage:
 *   node tools/heatmap.mjs --once --top 30
 *   node tools/heatmap.mjs --loop 15 --top 30 --threshold 0.6
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCandles } from './engine.mjs';
import { contracts } from './bx.mjs';
import { atr } from './indicators.mjs';
import { positioning, crowdRead } from './positioning.mjs';
import { send } from './notify.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]);
  return acc;
}, []));
const TOP = Number(args.top ?? 30);
const THRESHOLD = Number(args.threshold ?? 0.6);
const DIGEST = Number(args.digest ?? 0);
const LOOP_MINUTES = args.loop ? Number(args.loop) : 0;
const QUIET = Boolean(args.quiet);

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const SNAPS = path.join(DATA, 'heatmaps');
const STATE = path.join(SNAPS, 'state.json');
const LEVERAGES = [10, 25, 50, 100];
const NEAR = 0.05; // influence radius around price, 5%

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (v && !process.env[k]) process.env[k] = v;
  }
  for (const key of ['CG_API_KEY', 'COINANK_API_KEY']) {
    const value = process.env[key];
    if (!value) continue;
    if (/[^\x20-\x7E]/.test(value)) {
      console.warn(`${key}: значение содержит не-ASCII символы — похоже, вставлен текст-заглушка. Источник переключён на реконструкцию.`);
      delete process.env[key];
    } else if (value.length < 10) {
      console.warn(`${key}: слишком короткое значение (${value.length} символов) — похоже, ключ не заполнен.`);
      delete process.env[key];
    }
  }
}

function sourceName() {
  if (process.env.CG_API_KEY) return 'coinglass';
  if (process.env.COINANK_API_KEY) return 'coinank';
  return 'reconstruction';
}

/** Fallback candles from Bybit, used when BingX is unreachable (e.g. GitHub runners). */
async function bybitCandles(symbol, limit = 200) {
  const s = symbol.replace('-', '');
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=60&limit=${limit}`;
  const json = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
  const list = json?.result?.list ?? [];
  return list
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .sort((a, b) => a.time - b.time);
}

/** Rebuild an approximate map from candles: entries by volume at leverage levels. */
async function reconstruct(symbol) {
  // the map only needs the trailing window, so 7 days of 1h candles is enough
  let candles;
  try {
    candles = await loadCandles(symbol, '1h', 7);
  } catch {
    candles = await bybitCandles(symbol, 200);
  }
  if (!candles || candles.length < 50) throw new Error('no candles');
  const window = Math.min(168, candles.length) - 1;
  const slice = candles.slice(-window);
  const price = slice[slice.length - 1].close;
  let longMass = 0;
  let shortMass = 0;
  let longNear = 0;
  let shortNear = 0;

  for (const c of slice) {
    const entry = (c.high + c.low + c.close) / 3;
    const weight = c.volume * entry;
    for (const L of LEVERAGES) {
      const longLiq = entry * (1 - 1 / L);
      const shortLiq = entry * (1 + 1 / L);
      if (longLiq > 0 && longLiq < price) {
        longMass += weight / LEVERAGES.length;
        if (longLiq >= price * (1 - NEAR)) longNear += weight / LEVERAGES.length;
      }
      if (shortLiq > price) {
        shortMass += weight / LEVERAGES.length;
        if (shortLiq <= price * (1 + NEAR)) shortNear += weight / LEVERAGES.length;
      }
    }
  }
  return {
    symbol,
    price,
    longMass,
    shortMass,
    longNear,
    shortNear,
    levels: [],
    source: 'reconstruction',
  };
}

/** Pull a heatmap from Coinglass (model2). Payload shape is adapted defensively. */
async function fromCoinglass(symbol) {
  const asset = symbol.replace('-USDT', '');
  const url = `https://open-api-v4.coinglass.com/api/futures/liquidation/heatmap/model2?exchange=BINGX&symbol=${asset}USDT&range=12h`;
  const res = await fetch(url, { headers: { 'CG-API-KEY': process.env.CG_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  if (json.code !== '0' && json.code !== 0) throw new Error(`coinglass: ${json.msg ?? 'error'}`);
  return normalize(json.data, symbol, 'coinglass');
}

async function fromCoinank(symbol) {
  const asset = symbol.replace('-USDT', '');
  const url = `https://api.coinank.com/api/liqMap/getLiqHeatMap?exchange=BingX&symbol=${asset}&interval=1h`;
  const res = await fetch(url, { headers: { apikey: process.env.COINANK_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  if (json.success === false) throw new Error(`coinank: ${json.msg ?? 'error'}`);
  return normalize(json.data ?? json, symbol, 'coinank');
}

/**
 * Turn an unknown payload into {price, longMass, shortMass, longNear, shortNear, levels}.
 * Looks for price/value pairs anywhere in the tree.
 */
function normalize(payload, symbol, source) {
  const price = Number(payload?.price ?? payload?.currentPrice ?? 0);
  const points = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'number' && node.length >= 2) points.push(node);
      else node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      const priceKey = keys.find((k) => /price|level|y$/i.test(k));
      const longKey = keys.find((k) => /long/i.test(k));
      const shortKey = keys.find((k) => /short/i.test(k));
      const valueKey = keys.find((k) => /(value|amount|liq|size|total)$/i.test(k));
      if (priceKey && (longKey || shortKey || valueKey)) {
        points.push([
          Number(node[priceKey]),
          longKey ? Number(node[longKey]) : Number(node[valueKey]) / 2,
          shortKey ? Number(node[shortKey]) : Number(node[valueKey]) / 2,
        ]);
      } else {
        keys.forEach((k) => walk(node[k]));
      }
    }
  };
  walk(payload);

  let longMass = 0;
  let shortMass = 0;
  let longNear = 0;
  let shortNear = 0;
  const levels = [];
  const ref = price || null;
  for (const [level, longValue, shortValue] of points) {
    if (!Number.isFinite(level) || !ref) continue;
    const dist = Math.abs(level / ref - 1);
    if (dist > 0.15) continue;
    if (level < ref) {
      longMass += longValue;
      if (dist <= NEAR) longNear += longValue;
    } else {
      shortMass += shortValue;
      if (dist <= NEAR) shortNear += shortValue;
    }
    levels.push({ level, long: longValue, short: shortValue, dist });
  }
  levels.sort((a, b) => b.long + b.short - (a.long + a.short));
  return { symbol, price: ref, longMass, shortMass, longNear, shortNear, levels: levels.slice(0, 3), source };
}

function imbalance(record) {
  const total = record.longNear + record.shortNear;
  if (!total) return 0;
  return (record.shortNear - record.longNear) / total;
}

const atrCache = new Map();

/** ATR(1h) for the symbol, used to place the stop and target. */
async function atrFor(symbol) {
  if (atrCache.has(symbol)) return atrCache.get(symbol);
  let candles;
  try {
    candles = await loadCandles(symbol, '1h', 7);
  } catch {
    candles = await bybitCandles(symbol, 200);
  }
  const values = atr(candles, 14);
  const value = values[values.length - 1];
  atrCache.set(symbol, value);
  return value;
}

/**
 * Trade plan for a magnet move toward the heavier liquidation side.
 * Long when shorts are stacked above, short when longs are stacked below.
 * Stop 1.5 ATR, target 3 ATR (2R).
 */
async function tradePlan(record) {
  const value = await atrFor(record.symbol);
  if (!value || !record.price) return null;
  const long = record.imb > 0;
  const stopDistance = value * 1.5;
  const targetDistance = value * 3;
  const entry = record.price;
  const stop = long ? entry - stopDistance : entry + stopDistance;
  const target = long ? entry + targetDistance : entry - targetDistance;
  return {
    side: long ? 'long' : 'short',
    entry,
    stop,
    target,
    stopPct: stopDistance / entry,
    targetPct: targetDistance / entry,
    rr: 2,
  };
}

const fmt = (value) => Number(value).toPrecision(6).replace(/\.?0+$/, '');

async function scanOnce() {
  loadEnv();
  const source = sourceName();
  const universePath = path.join(DATA, 'universe.json');
  if (!fs.existsSync(universePath)) throw new Error('нет data/universe.json — сначала запустите tools/backtest.mjs');
  let universe = JSON.parse(fs.readFileSync(universePath, 'utf8'))
    .filter((c) => !c.asset.includes('2USD') && !/^(USDC|TUSD|BUSD)/.test(c.asset))
    .slice(0, TOP);
  // BingX may be geo-blocked (GitHub runners); fall back to the saved list as-is
  try {
    const available = new Set((await contracts()).map((c) => c.symbol));
    universe = universe.filter((c) => available.has(c.symbol));
  } catch {
    if (!QUIET) console.log('BingX contracts unavailable — using the saved universe');
  }

  const records = [];
  for (const contract of universe) {
    try {
      let record;
      if (source === 'coinglass') record = await fromCoinglass(contract.symbol);
      else if (source === 'coinank') record = await fromCoinank(contract.symbol);
      else record = await reconstruct(contract.symbol);
      record.imb = imbalance(record);
      try {
        record.pos = await positioning(contract.symbol);
        record.crowd = crowdRead(record.pos);
        record.confirm = Math.sign(record.imb) === Math.sign(record.crowd.lean) && Math.abs(record.pos.oiChange4h) > 0.01;
      } catch {
        record.pos = null;
        record.crowd = { lean: 0, note: '' };
        record.confirm = false;
      }
      try { record.plan = await tradePlan(record); } catch { record.plan = null; }
      records.push(record);
    } catch (error) {
      if (!QUIET) console.log(`  ${contract.symbol}: ${error.message}`);
    }
  }

  fs.mkdirSync(SNAPS, { recursive: true });
  const stamp = new Date().toISOString();
  const file = path.join(SNAPS, `${stamp.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ stamp, source, records }, null, 1));
  fs.appendFileSync(path.join(SNAPS, 'index.jsonl'), JSON.stringify({ stamp, source, count: records.length }) + '\n');

  const sorted = [...records].sort((a, b) => Math.abs(b.imb) - Math.abs(a.imb));
  if (!QUIET) {
    console.log(`${stamp}  source=${source}  coins=${records.length}`);
    console.log('coin            price        imbalance  longNear  shortNear  толпа / OI');
    for (const r of sorted.slice(0, 10)) {
      const crowd = r.crowd?.note ?? '';
      console.log(`${r.symbol.padEnd(14)}  ${r.price.toPrecision(7).padEnd(11)}  ${r.imb.toFixed(2).padStart(8)}  ${(r.longNear / 1e6).toFixed(0).padStart(7)}M  ${(r.shortNear / 1e6).toFixed(0).padStart(8)}M  ${crowd}`);
    }
  }

  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const alerts = [];
  for (const r of sorted) {
    if (Math.abs(r.imb) < THRESHOLD) continue;
    const last = state[r.symbol] ?? 0;
    if (Date.now() - last < 2 * 3600 * 1000) continue;
    state[r.symbol] = Date.now();
    alerts.push(r);
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

  for (const r of alerts) {
    const side = r.imb > 0 ? 'шорты сверху' : 'лонги снизу';
    const level = r.levels[0] ? ` ближайший уровень ${r.levels[0].level.toPrecision(6)}` : '';
    const planLine = r.plan
      ? `\nвход ${fmt(r.plan.entry)} · стоп ${fmt(r.plan.stop)} · цель ${fmt(r.plan.target)} (1:${r.plan.rr})`
      : '';
    const crowdLine = r.crowd?.note ? `\n${r.crowd.note}` : '';
    const confirmLine = r.confirm ? '\nподтверждение: толпа и карта совпадают' : '';
    const text = `⚡ ${r.symbol} · перевес ${r.imb > 0 ? '+' : ''}${r.imb.toFixed(2)} (${side})\nцена ${r.price.toPrecision(7)}${level}${planLine}${crowdLine}${confirmLine}\nисточник: ${r.source}`;
    try { await send(text); } catch (e) { console.log(`alert failed: ${e.message}`); }
  }

  if (DIGEST > 0 && records.length) {
    // magnitude first, confirmation only as a modest bonus
    const score = (r) => Math.abs(r.imb) * (r.confirm ? 1.3 : 1) + (r.pos ? Math.min(Math.abs(r.pos.oiChange4h), 0.05) * 0.3 : 0);
    const best = [...records].sort((a, b) => score(b) - score(a)).slice(0, DIGEST);
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const strongest = Math.abs(best[0]?.imb ?? 0);
    const lines = [`📊 Топ-${best.length} перевесов · ${time} MSK`];
    if (strongest < 0.15) lines.push('рынок спокойный: сильных перевесов нет');
    best.forEach((r, i) => {
      const dir = r.imb > 0 ? '↑ шорты сверху' : '↓ лонги снизу';
      lines.push(`${i + 1}) ${r.symbol} ${dir}, ${r.imb > 0 ? '+' : ''}${r.imb.toFixed(2)}`);
      if (r.plan) {
        const p = r.plan;
        const stopSign = p.side === 'long' ? '−' : '+';
        const targetSign = p.side === 'long' ? '+' : '−';
        lines.push(`   вход ${fmt(p.entry)} · стоп ${fmt(p.stop)} (${stopSign}${(p.stopPct * 100).toFixed(1)}%) · цель ${fmt(p.target)} (${targetSign}${(p.targetPct * 100).toFixed(1)}%) · 1:${p.rr}`);
      } else {
        lines.push(`   цена ${fmt(r.price)}`);
      }
      if (r.crowd?.note) lines.push(`   ${r.crowd.note}`);
      if (r.confirm) lines.push('   ✔ толпа и карта совпадают');
    });
    lines.push('стоп 1.5×ATR(1h) · цель 3×ATR(1h)');
    lines.push(`источник: ${source}`);
    try { await send(lines.join('\n')); } catch (e) { console.log(`digest failed: ${e.message}`); }
  }
  return { source, records, alerts };
}

const main = async () => {
  if (LOOP_MINUTES > 0) {
    console.log(`loop: every ${LOOP_MINUTES} min, top ${TOP}, threshold ${THRESHOLD}`);
    for (;;) {
      try { await scanOnce(); } catch (e) { console.log(`scan failed: ${e.message}`); }
      await new Promise((r) => setTimeout(r, LOOP_MINUTES * 60 * 1000));
    }
  } else {
    await scanOnce();
  }
};

await main();
