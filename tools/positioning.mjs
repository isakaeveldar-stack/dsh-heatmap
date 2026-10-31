/**
 * Free positioning data from Binance USDⓈ-M futures (no API key).
 * Returns the crowd's lean and whether new money is entering.
 */

const BASE = 'https://fapi.binance.com';
const cache = new Map();

async function get(path, ttlMs = 60_000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`binance ${path}: ${res.status}`);
  const value = await res.json();
  cache.set(path, { at: Date.now(), value });
  return value;
}

/** BingX-style symbol (BTC-USDT) -> Binance symbol (BTCUSDT). */
export function toBinance(symbol) {
  return symbol.replace('-', '');
}

export async function positioning(symbol) {
  try {
    return await fromBinance(symbol);
  } catch {
    return await fromBybit(symbol);
  }
}

async function fromBinance(symbol) {
  const s = toBinance(symbol);
  const [oiHist, lsr, taker, premium] = await Promise.all([
    get(`/futures/data/openInterestHist?symbol=${s}&period=1h&limit=6`),
    get(`/futures/data/globalLongShortAccountRatio?symbol=${s}&period=1h&limit=2`),
    get(`/futures/data/takerlongshortRatio?symbol=${s}&period=1h&limit=3`),
    get(`/fapi/v1/premiumIndex?symbol=${s}`),
  ]);

  const oiNow = Number(oiHist.at(-1)?.sumOpenInterestValue ?? 0);
  const oi4h = Number(oiHist.at(-5)?.sumOpenInterestValue ?? oiNow);
  const oiChange4h = oi4h > 0 ? oiNow / oi4h - 1 : 0;

  const longAccount = Number(lsr.at(-1)?.longAccount ?? 0.5);
  const buy = Number(taker.at(-1)?.buyVol ?? 0);
  const sell = Number(taker.at(-1)?.sellVol ?? 0);
  const takerImb = buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;
  const funding = Number(premium.lastFundingRate ?? 0);

  return { longAccount, crowd: (longAccount - 0.5) * 2, takerImb, oiChange4h, funding, source: 'binance' };
}

/** Fallback used when Binance is unreachable (for example from GitHub runners). */
async function fromBybit(symbol) {
  const s = toBinance(symbol);
  const base = 'https://api.bybit.com/v5/market';
  const [oi, ratio, ticker] = await Promise.all([
    fetch(`${base}/open-interest?category=linear&symbol=${s}&intervalTime=1h&limit=6`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(`${base}/account-ratio?category=linear&symbol=${s}&period=1h&limit=2`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(`${base}/tickers?category=linear&symbol=${s}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
  ]);

  const list = oi?.result?.list ?? [];
  const oiNow = Number(list.at(-1)?.openInterest ?? 0);
  const oi4h = Number(list.at(-5)?.openInterest ?? oiNow);
  const oiChange4h = oi4h > 0 ? oiNow / oi4h - 1 : 0;

  const row = ratio?.result?.list?.at(-1);
  const buyRatio = Number(row?.buyRatio ?? 0.5);
  const longAccount = buyRatio > 1 ? buyRatio / (1 + buyRatio) : 0.5;

  const t = ticker?.result?.list?.[0];
  const funding = Number(t?.fundingRate ?? 0);

  return { longAccount, crowd: (longAccount - 0.5) * 2, takerImb: 0, oiChange4h, funding, source: 'bybit' };
}

/**
 * Which side is the crowded one, and is the crowd adding?
 * Returns a text label plus an agreement score in [-1, 1]:
 *   > 0 means the crowd is short (short squeeze fuel above),
 *   < 0 means the crowd is long (long squeeze fuel below).
 */
export function crowdRead(p) {
  if (!p) return { lean: 0, note: '' };
  const lean = -p.crowd; // crowd long -> negative
  const adding = Math.abs(p.oiChange4h) > 0.01;
  const note = [
    p.longAccount >= 0.6 ? 'толпа в лонгах' : p.longAccount <= 0.4 ? 'толпа в шортах' : 'толпа сбалансирована',
    adding ? `OI ${p.oiChange4h > 0 ? '+' : ''}${(p.oiChange4h * 100).toFixed(1)}% за 4ч` : 'OI без изменений',
    Math.abs(p.takerImb) > 0.15 ? `тейкеры ${p.takerImb > 0 ? 'в покупку' : 'в продажу'}` : '',
    Math.abs(p.funding) > 0.0003 ? `funding ${(p.funding * 100).toFixed(4)}%` : '',
  ].filter(Boolean).join(' · ');
  return { lean, note };
}
