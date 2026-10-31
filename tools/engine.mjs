/** Backtest engine: candles cache, indicator prep, strategy registry, trade simulation. */
import fs from 'node:fs';
import path from 'node:path';
import { history } from './bx.mjs';
import { ema, rsi, atr, sma } from './indicators.mjs';

export const CACHE = path.join(process.cwd(), 'data', 'klines');

export async function loadCandles(symbol, interval, days) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${symbol}-${interval}-${days}d.json`);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 2 * 60 * 60 * 1000) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const candles = await history(symbol, interval, days);
  fs.writeFileSync(file, JSON.stringify(candles));
  return candles;
}

export function rollingExtreme(values, period, mode) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let best = mode === 'max' ? -Infinity : Infinity;
    for (let j = i - period; j < i; j++) best = mode === 'max' ? Math.max(best, values[j]) : Math.min(best, values[j]);
    out[i] = best;
  }
  return out;
}

export function prepare(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const atr14 = atr(candles, 14);
  return {
    close: closes,
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    rsi2: rsi(closes, 2),
    atr14,
    atrPct: atrPercentile(candles, atr14),
    volSma20: sma(volumes, 20),
    high20: rollingExtreme(highs, 20, 'max'),
    low20: rollingExtreme(lows, 20, 'min'),
    high10: rollingExtreme(highs, 10, 'max'),
    low10: rollingExtreme(lows, 10, 'min'),
  };
}

/** Rank of the current ATR% inside the last `window` bars, 0..1. */
export function atrPercentile(candles, atrValues, window = 400) {
  const out = new Array(candles.length).fill(null);
  const values = [];
  for (let i = 0; i < candles.length; i++) {
    if (!atrValues[i]) continue;
    const pct = atrValues[i] / candles[i].close;
    values.push(pct);
    if (values.length > window) values.shift();
    if (values.length < 100) continue;
    const sorted = [...values].sort((a, b) => a - b);
    let below = 0;
    while (below < sorted.length && sorted[below] < pct) below++;
    out[i] = below / (sorted.length - 1);
  }
  return out;
}

const get = (ind, key, i) => (ind[key] ? ind[key][i] : null);

export const strategies = {
  /** v1: trend pullback with RSI recross. */
  pullback: {
    warmup: 210,
    exit: { stopAtr: 1.2, targetR: 2, maxBars: 24 },
    signal(candles, ind, i) {
      const c = candles[i];
      const p = candles[i - 1];
      const values = ['ema9', 'ema21', 'ema50', 'rsi14', 'atr14', 'volSma20'].map((k) => get(ind, k, i));
      if (values.some((v) => v === null)) return null;
      if (!(c.volume > ind.volSma20[i] * 1.2)) return null;
      const long = ind.ema9[i] > ind.ema21[i] && ind.ema21[i] > ind.ema50[i]
        && ind.rsi14[i - 1] < 45 && ind.rsi14[i] >= 45 && c.close > ind.ema21[i];
      const short = ind.ema9[i] < ind.ema21[i] && ind.ema21[i] < ind.ema50[i]
        && ind.rsi14[i - 1] > 55 && ind.rsi14[i] <= 55 && c.close < ind.ema21[i];
      if (long) return 'long';
      if (short) return 'short';
      return null;
    },
  },

  /** v2: Donchian breakout in the direction of the slow trend. */
  breakout: {
    warmup: 210,
    exit: { stopAtr: 1.5, targetR: 3, maxBars: 36 },
    signal(candles, ind, i) {
      const c = candles[i];
      if (ind.ema200[i] === null || ind.high20[i] === null || ind.volSma20[i] === null) return null;
      if (!(c.volume > ind.volSma20[i] * 1.3)) return null;
      if (c.close > ind.high20[i] && c.close > ind.ema200[i]) return 'long';
      if (c.close < ind.low20[i] && c.close < ind.ema200[i]) return 'short';
      return null;
    },
  },

  /** v3: short-term mean reversion, trading back toward the mean. */
  reversion: {
    warmup: 210,
    exit: { stopAtr: 2, targetR: 1, maxBars: 12 },
    signal(candles, ind, i) {
      const c = candles[i];
      if (ind.rsi2[i] === null || ind.ema200[i] === null) return null;
      if (ind.rsi2[i] < 5 && c.close > ind.ema200[i]) return 'long';
      if (ind.rsi2[i] > 95 && c.close < ind.ema200[i]) return 'short';
      return null;
    },
  },

  /** v4: momentum continuation on a fresh 10-bar high inside an EMA stack. */
  momentum: {
    warmup: 210,
    exit: { stopAtr: 1, targetR: 2, maxBars: 30 },
    signal(candles, ind, i) {
      const c = candles[i];
      if (ind.ema50[i] === null || ind.high10[i] === null) return null;
      if (!(ind.ema9[i] > ind.ema21[i] && ind.ema21[i] > ind.ema50[i])) return null;
      if (c.close > ind.high10[i] && c.volume > ind.volSma20[i] * 1.1) return 'long';
      return null;
    },
  },
};

export function simulate(candles, strategy, { feeRate = 0.0005, slippage = 0.0003 } = {}) {
  const ind = prepare(candles);
  const { signal, exit, warmup } = strategy;
  const trades = [];
  let open = null;
  const offset = candles[0]?.time ?? 0;

  for (let i = warmup; i < candles.length - 1; i++) {
    const bar = candles[i];

    if (open) {
      const hitStop = open.side === 'long' ? bar.low <= open.stop : bar.high >= open.stop;
      const hitTarget = open.side === 'long' ? bar.high >= open.target : bar.low <= open.target;
      const timedOut = i - open.entryIndex >= exit.maxBars;
      let exitPrice = null;
      let reason = null;
      if (hitStop) { exitPrice = open.stop; reason = 'stop'; }
      else if (hitTarget) { exitPrice = open.target; reason = 'target'; }
      else if (timedOut) { exitPrice = bar.close; reason = 'time'; }
      if (exitPrice !== null) {
        const gross = open.side === 'long' ? exitPrice - open.entryPrice : open.entryPrice - exitPrice;
        const fees = (open.entryPrice + exitPrice) * feeRate;
        const riskPerUnit = Math.abs(open.entryPrice - open.stop);
        trades.push({
          side: open.side,
          entryTime: open.entryTime,
          exitTime: bar.time - offset,
          r: (gross - fees) / riskPerUnit,
          reason,
          bars: i - open.entryIndex,
        });
        open = null;
      }
      if (open) continue;
    }

    const side = signal(candles, ind, i);
    if (!side) continue;
    const next = candles[i + 1];
    const atrValue = ind.atr14[i];
    if (!atrValue) continue;
    const entryPrice = next.open * (1 + (side === 'long' ? slippage : -slippage));
    const stopDistance = atrValue * exit.stopAtr;
    open = {
      side,
      entryPrice,
      stop: side === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance,
      target: side === 'long' ? entryPrice + stopDistance * exit.targetR : entryPrice - stopDistance * exit.targetR,
      entryIndex: i + 1,
      entryTime: next.time - offset,
    };
  }
  return trades;
}

export function stats(trades, days) {
  if (!trades.length) return { trades: 0, perDay: 0, winRate: 0, avgR: 0, totalR: 0, profitFactor: 0, maxDrawdownR: 0, avgBars: 0 };
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  return {
    trades: trades.length,
    perDay: trades.length / days,
    winRate: wins.length / trades.length,
    avgR: cum / trades.length,
    totalR: cum,
    profitFactor: grossLoss === 0 ? Infinity : grossWin / grossLoss,
    maxDrawdownR: maxDd,
    avgBars: trades.reduce((s, t) => s + t.bars, 0) / trades.length,
  };
}
