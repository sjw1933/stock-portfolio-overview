const nasdaqBaseUrl = 'https://api.nasdaq.com/api/quote';
const cacheTtlMs = 8_000;
const quoteCache = new Map();

const marketClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const marketDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

export function getUsMarketSession(now = new Date()) {
  const parts = Object.fromEntries(
    marketClockFormatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const tradingDay = !['Sat', 'Sun'].includes(parts.weekday);

  if (!tradingDay || minutes < 4 * 60 || minutes >= 20 * 60) return 'closed';
  if (minutes < 9 * 60 + 30) return 'pre';
  if (minutes < 16 * 60) return 'regular';
  return 'post';
}

export async function fetchExtendedQuotes(entries, now = new Date()) {
  const session = getUsMarketSession(now);
  const fetchedAt = now.toISOString();
  if (session !== 'pre' && session !== 'post') return { session, fetchedAt, quotes: [] };

  const marketDate = marketDateFormatter.format(now);
  const uniqueEntries = Array.from(new Map(entries.map((entry) => [entry.symbol, entry])).values()).slice(0, 30);
  const quotes = [];

  for (let index = 0; index < uniqueEntries.length; index += 4) {
    const chunk = uniqueEntries.slice(index, index + 4);
    const results = await Promise.allSettled(
      chunk.map((entry) => fetchExtendedQuote(entry, session, marketDate, now)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) quotes.push(result.value);
    }
  }

  return { session, fetchedAt, quotes };
}

async function fetchExtendedQuote(entry, session, marketDate, now) {
  const cacheKey = `${marketDate}:${session}:${entry.symbol}:${entry.assetClass}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;

  let quote = null;
  try {
    quote = await fetchNasdaqExtendedQuote(entry, session, marketDate);
  } catch {
    // Yahoo minute data below is the fallback when Nasdaq is unavailable.
  }
  if (!quote) quote = await fetchYahooExtendedQuote(entry, session, now);
  quoteCache.set(cacheKey, { quote, expiresAt: Date.now() + cacheTtlMs });
  return quote;
}

async function fetchNasdaqExtendedQuote(entry, session, marketDate) {
  const ticker = entry.symbol.replace(/\.US$/i, '');
  const url = `${nasdaqBaseUrl}/${encodeURIComponent(ticker)}/extended-trading?assetclass=${entry.assetClass}&markettype=${session}`;
  const payload = await fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://www.nasdaq.com/',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  return parseNasdaqExtendedPayload(payload, entry.symbol, session, marketDate);
}

async function fetchYahooExtendedQuote(entry, session, now) {
  const ticker = entry.symbol.replace(/\.US$/i, '');
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
  const payload = await fetchJson(url, {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  return parseYahooExtendedPayload(payload, entry.symbol, session, now);
}

async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) throw new Error(`extended quote HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function parseNasdaqExtendedPayload(payload, symbol, session, marketDate) {
  const data = payload?.data;
  const updateLines = Array.isArray(data?.lastUpdateInfo) ? data.lastUpdateInfo.map(String) : [];
  const updatedAt = updateLines.find((line) => line.includes(marketDate));
  if (!updatedAt) return null;

  const row = data?.infoTable?.rows?.[0];
  const latestTrade = data?.tradeDetailTable?.rows?.[0];
  const price = parsePrice(row?.consolidated) ?? parsePrice(latestTrade?.price);
  if (!(price > 0)) return null;

  const previousClose = parsePrice(data?.previousInfo);
  return {
    symbol,
    price,
    previousClose: previousClose && previousClose > 0 ? previousClose : undefined,
    session,
    updatedAt,
    source: 'nasdaq',
  };
}

export function parseYahooExtendedPayload(payload, symbol, session, now = new Date()) {
  const result = payload?.chart?.result?.[0];
  const period = result?.meta?.currentTradingPeriod?.[session];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!period || !Array.isArray(closes)) return null;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  let index = Math.min(timestamps.length, closes.length) - 1;
  while (index >= 0) {
    const timestamp = Number(timestamps[index]);
    const price = Number(closes[index]);
    if (
      Number.isFinite(timestamp)
      && timestamp >= Number(period.start)
      && timestamp < Number(period.end)
      && timestamp <= nowSeconds + 120
      && Number.isFinite(price)
      && price > 0
    ) {
      const previousClose = session === 'pre'
        ? Number(result?.meta?.regularMarketPrice)
        : Number(result?.meta?.chartPreviousClose ?? result?.meta?.previousClose);
      return {
        symbol,
        price,
        previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : undefined,
        session,
        updatedAt: new Date(timestamp * 1000).toISOString(),
        source: 'yahoo',
      };
    }
    index -= 1;
  }
  return null;
}

function parsePrice(value) {
  const match = String(value || '').replace(/,/g, '').match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  const price = Number(match?.[1]);
  return Number.isFinite(price) ? price : null;
}
