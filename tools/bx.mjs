/**
 * BingX USDⓈ-M perpetual futures — public data layer.
 * No API keys: quote/ticker/klines/contracts are public endpoints.
 */

const BASE = 'https://open-api.bingx.com';
const cache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function call(path, { retries = 3, timeout = 20000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(timeout) });
      const json = await res.json();
      if (json.code !== 0) throw new Error(`bingx ${path}: code=${json.code} ${json.msg}`);
      return json;
    } catch (error) {
      lastError = error;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError;
}

/** All tradable USDT-margined perpetual contracts with fee rates. */
export async function contracts() {
  if (cache.has('contracts')) return cache.get('contracts');
  const json = await call('/openApi/swap/v2/quote/contracts');
  const list = json.data
    .filter((c) => c.symbol.endsWith('-USDT') && c.status === 1)
    .map((c) => ({
      symbol: c.symbol,
      asset: c.asset,
      pricePrecision: Number(c.pricePrecision),
      quantityPrecision: Number(c.quantityPrecision),
      minQuantity: Number(c.tradeMinQuantity),
      minNotional: Number(c.tradeMinUSDT),
      makerFee: Number(c.makerFeeRate),
      takerFee: Number(c.takerFeeRate),
    }));
  cache.set('contracts', list);
  return list;
}

/** One symbol's 24h stats, including quoteVolume. */
export async function ticker(symbol) {
  const json = await call(`/openApi/swap/v2/quote/ticker?symbol=${symbol}`);
  const d = json.data;
  return {
    symbol,
    price: Number(d.lastPrice),
    priceChangePercent: Number(d.priceChangePercent),
    high: Number(d.highPrice),
    low: Number(d.lowPrice),
    volume: Number(d.volume),
    quoteVolume: Number(d.quoteVolume),
  };
}

/** Klines, ascending by time. symbol like BTC-USDT, interval like 5m/15m/1h/4h/1d. */
export async function klines(symbol, interval, { limit = 1000, startTime, endTime } = {}) {
  let path = `/openApi/swap/v2/quote/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) path += `&startTime=${startTime}`;
  if (endTime) path += `&endTime=${endTime}`;
  const json = await call(path);
  return (json.data ?? [])
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    }))
    .sort((a, b) => a.time - b.time);
}

/** Paginated history: returns `days` worth of candles ending now. */
export async function history(symbol, interval, days, { onProgress } = {}) {
  const stepMs = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
    '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000,
  }[interval];
  if (!stepMs) throw new Error(`unsupported interval ${interval}`);
  const end = Date.now();
  let start = end - days * 86_400_000;
  const out = [];
  while (start < end) {
    const batch = await klines(symbol, interval, { limit: 1000, startTime: start });
    if (batch.length === 0) break;
    out.push(...batch);
    start = batch[batch.length - 1].time + stepMs;
    if (onProgress) onProgress(out.length);
    if (batch.length < 1000) break;
    await sleep(120);
  }
  const seen = new Set();
  return out.filter((k) => (seen.has(k.time) ? false : (seen.add(k.time), true)));
}

/** Rank the universe by 24h quote volume, keeping the top N USDT perps. */
export async function topByVolume(n = 100, { concurrency = 5, onProgress } = {}) {
  const list = await contracts();
  const results = [];
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < list.length) {
      const contract = list[index++];
      try {
        const t = await ticker(contract.symbol);
        results.push({ ...contract, ...t });
      } catch { /* skip symbols that cannot be read */ }
      if (onProgress) onProgress(results.length, list.length);
      await sleep(40);
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return results.slice(0, n);
}
