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
      chunk.map((entry) => fetchNasdaqExtendedQuote(entry, session, marketDate)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) quotes.push(result.value);
    }
  }

  return { session, fetchedAt, quotes };
}

async function fetchNasdaqExtendedQuote(entry, session, marketDate) {
  const cacheKey = `${marketDate}:${session}:${entry.symbol}:${entry.assetClass}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;

  const ticker = entry.symbol.replace(/\.US$/i, '');
  const url = `${nasdaqBaseUrl}/${encodeURIComponent(ticker)}/extended-trading?assetclass=${entry.assetClass}&markettype=${session}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        referer: 'https://www.nasdaq.com/',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) throw new Error(`Nasdaq extended quote HTTP ${response.status}`);
    const quote = parseNasdaqExtendedPayload(await response.json(), entry.symbol, session, marketDate);
    quoteCache.set(cacheKey, { quote, expiresAt: Date.now() + cacheTtlMs });
    return quote;
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

function parsePrice(value) {
  const match = String(value || '').replace(/,/g, '').match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  const price = Number(match?.[1]);
  return Number.isFinite(price) ? price : null;
}
