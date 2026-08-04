const nasdaqBaseUrl = 'https://api.nasdaq.com/api/quote';
const successCacheTtlMs = 15_000;
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

/** @returns {'pre' | 'regular' | 'post' | 'closed'} */
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

/**
 * @param {Array<{ symbol: string, assetClass: string }>} entries
 * @param {{ now?: Date, session?: 'pre' | 'regular' | 'post' | 'auto' | 'all' }} [options]
 */
export async function fetchExtendedQuotes(entries, options = {}) {
  const now = options.now ?? new Date();
  const marketSession = getUsMarketSession(now);
  const fetchedAt = now.toISOString();
  const requested = options.session || 'auto';

  if (requested === 'all') {
    return fetchAllSessionQuotes(entries, now, marketSession, fetchedAt);
  }

  const session = resolveRequestedSession(requested, marketSession);
  if (!session) {
    return { session: marketSession, marketSession, requestedSession: null, fetchedAt, quotes: [] };
  }

  const marketDate = marketDateFormatter.format(now);
  const uniqueEntries = Array.from(new Map(entries.map((entry) => [entry.symbol, entry])).values()).slice(0, 30);
  const quotes = [];

  // Sequential chunks reduce Yahoo 429 pressure.
  for (let index = 0; index < uniqueEntries.length; index += 2) {
    const chunk = uniqueEntries.slice(index, index + 2);
    const results = await Promise.allSettled(
      chunk.map((entry) => fetchSessionQuote(entry, session, marketDate, now)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) quotes.push(result.value);
    }
    if (index + 2 < uniqueEntries.length) await sleep(120);
  }

  return { session, marketSession, requestedSession: session, fetchedAt, quotes };
}

async function fetchAllSessionQuotes(entries, now, marketSession, fetchedAt) {
  const marketDate = marketDateFormatter.format(now);
  const uniqueEntries = Array.from(new Map(entries.map((entry) => [entry.symbol, entry])).values()).slice(0, 30);
  const quotesBySession = { pre: [], regular: [], post: [] };

  for (let index = 0; index < uniqueEntries.length; index += 1) {
    const entry = uniqueEntries[index];
    try {
      const value = await fetchAllSessionsForEntry(entry, marketDate, now);
      if (!value) continue;
      for (const session of ['pre', 'regular', 'post']) {
        if (value[session]) quotesBySession[session].push(value[session]);
      }
    } catch {
      // Keep going for remaining symbols.
    }
    if (index + 1 < uniqueEntries.length) await sleep(100);
  }

  const liveSession = marketSession === 'pre' || marketSession === 'post' || marketSession === 'regular'
    ? marketSession
    : 'regular';

  return {
    session: 'all',
    marketSession,
    requestedSession: 'all',
    fetchedAt,
    quotes: quotesBySession[liveSession] || [],
    quotesBySession,
  };
}

async function fetchAllSessionsForEntry(entry, marketDate, now) {
  const cacheKey = `${marketDate}:all:${entry.symbol}:${entry.assetClass}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;

  /** @type {Record<string, any>} */
  const bySession = {};

  // Nasdaq pre/post remain available after the close (previous session tape).
  for (const session of ['pre', 'post']) {
    try {
      const nasdaqQuote = await fetchNasdaqExtendedQuote(entry, session, marketDate);
      if (nasdaqQuote) bySession[session] = nasdaqQuote;
    } catch {
      // Yahoo chart fills gaps below.
    }
  }

  // Need Yahoo for official regular-session marks (and any missing pre/post).
  // Prefer a single chart call; skip if all three sessions already filled.
  if (!bySession.pre || !bySession.regular || !bySession.post) {
    try {
      await sleep(150);
      const ticker = entry.symbol.replace(/\.US$/i, '');
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
      const payload = await fetchJson(url, {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      });
      for (const session of ['pre', 'regular', 'post']) {
        if (bySession[session]) continue;
        const quote = parseYahooExtendedPayload(payload, entry.symbol, session, now);
        if (quote) bySession[session] = quote;
      }
    } catch {
      // Leave partial map from Nasdaq; client falls back to regular tape for missing sessions.
    }
  }

  const value = Object.keys(bySession).length ? bySession : null;
  // Only cache successful maps so transient 429s do not pin empty results.
  if (value) {
    quoteCache.set(cacheKey, { quote: value, expiresAt: Date.now() + successCacheTtlMs });
  }
  return value;
}

function resolveRequestedSession(requested, marketSession) {
  if (requested === 'pre' || requested === 'regular' || requested === 'post') return requested;
  if (marketSession === 'pre' || marketSession === 'post') return marketSession;
  return null;
}

async function fetchSessionQuote(entry, session, marketDate, now) {
  const cacheKey = `${marketDate}:${session}:${entry.symbol}:${entry.assetClass}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;

  let quote = null;
  if (session === 'pre' || session === 'post') {
    try {
      quote = await fetchNasdaqExtendedQuote(entry, session, marketDate);
    } catch {
      // Yahoo minute data below is the fallback when Nasdaq is unavailable.
    }
  }
  if (!quote) {
    try {
      quote = await fetchYahooSessionQuote(entry, session, now);
    } catch {
      quote = null;
    }
  }
  if (quote) {
    quoteCache.set(cacheKey, { quote, expiresAt: Date.now() + successCacheTtlMs });
  }
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

async function fetchYahooSessionQuote(entry, session, now) {
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
  // Accept today's stamp, or the latest "Data last updated ..." line after midnight ET.
  const updatedAt = updateLines.find((line) => line.includes(marketDate))
    || updateLines.find((line) => /data last updated/i.test(line));
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
  const meta = result?.meta;
  const period = meta?.currentTradingPeriod?.[session];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = result?.indicators?.quote?.[0]?.close;
  const dayPreviousClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
  const baseline = Number.isFinite(dayPreviousClose) && dayPreviousClose > 0 ? dayPreviousClose : undefined;

  if (session === 'regular' && meta) {
    const regularPrice = Number(meta.regularMarketPrice);
    if (Number.isFinite(regularPrice) && regularPrice > 0) {
      const fromBars = pickLastBarInPeriod(timestamps, closes, period, now);
      return {
        symbol,
        price: fromBars?.price ?? regularPrice,
        previousClose: baseline,
        session,
        updatedAt: fromBars?.updatedAt ?? (meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : undefined),
        source: 'yahoo',
      };
    }
  }

  if (!period || !Array.isArray(closes)) return null;

  const fromBars = pickLastBarInPeriod(timestamps, closes, period, now);
  if (!fromBars) return null;

  return {
    symbol,
    price: fromBars.price,
    previousClose: baseline,
    session,
    updatedAt: fromBars.updatedAt,
    source: 'yahoo',
  };
}

function pickLastBarInPeriod(timestamps, closes, period, now) {
  if (!period) return null;
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
      return {
        price,
        updatedAt: new Date(timestamp * 1000).toISOString(),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
