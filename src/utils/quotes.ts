import type { Holding, MarketSession, QuoteSession, QuoteViewSession } from '../types';

type YahooQuote = {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketPreviousClose?: number;
  postMarketPrice?: number;
  preMarketPrice?: number;
  longName?: string;
  shortName?: string;
};

export type QuoteSnapshot = {
  price: number;
  change?: number;
  previousClose?: number;
  name?: string;
  session?: QuoteSession;
  updatedAt?: string;
};

type ExtendedQuote = {
  symbol: string;
  price: number;
  previousClose?: number;
  session: QuoteSession;
  updatedAt?: string;
};

type ExtendedQuotesResponse = {
  quotes: Map<string, ExtendedQuote>;
  marketSession: MarketSession;
};

const marketClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function getUsMarketSession(now = new Date()): MarketSession {
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

/** Outside pre / regular / post windows, default to the day's regular-session PnL. */
export function defaultQuoteViewSession(now = new Date()): QuoteViewSession {
  const session = getUsMarketSession(now);
  if (session === 'pre' || session === 'post') return session;
  return 'regular';
}

export function quoteViewSessionLabel(view: QuoteViewSession) {
  return view === 'pre' ? '盘前' : view === 'post' ? '盘后' : '盘中';
}

export async function fetchLatestQuotes(
  holdings: Holding[],
  signal?: AbortSignal,
  viewSession: QuoteViewSession = 'regular',
): Promise<{ quotes: Map<string, QuoteSnapshot>; marketSession: MarketSession }> {
  const localMarketSession = getUsMarketSession();
  const needsSessionQuotes = viewSession === 'pre'
    || viewSession === 'post'
    || (viewSession === 'regular' && (localMarketSession === 'post' || localMarketSession === 'closed'));

  const [regularResult, sessionResult] = await Promise.allSettled([
    fetchTencentQuotes(holdings, signal),
    needsSessionQuotes
      ? fetchSessionUsQuotes(holdings, viewSession, signal)
      : Promise.resolve({ quotes: new Map<string, ExtendedQuote>(), marketSession: localMarketSession }),
  ]);

  const quotes = regularResult.status === 'fulfilled' ? regularResult.value : new Map<string, QuoteSnapshot>();
  const marketSession = sessionResult.status === 'fulfilled'
    ? sessionResult.value.marketSession
    : localMarketSession;

  if (sessionResult.status === 'fulfilled') {
    for (const [symbol, sessionQuote] of sessionResult.value.quotes) {
      const regular = quotes.get(symbol);
      const previousClose = resolveSessionPreviousClose(viewSession, sessionQuote, regular);
      quotes.set(symbol, {
        ...regular,
        price: sessionQuote.price,
        previousClose,
        change: previousClose ? sessionQuote.price - previousClose : undefined,
        session: viewSession,
        updatedAt: sessionQuote.updatedAt,
      });
    }
  }

  // Keep a consistent session tag on US quotes so the UI can show 盘前/盘中/盘后.
  for (const [symbol, quote] of quotes) {
    if (/\.US$/i.test(symbol) && !quote.session) {
      quotes.set(symbol, { ...quote, session: viewSession });
    }
  }

  if (quotes.size === 0) {
    const fallback = await fetchYahooQuotes(holdings, signal, viewSession);
    return { quotes: fallback, marketSession };
  }

  return { quotes, marketSession };
}

function resolveSessionPreviousClose(
  viewSession: QuoteViewSession,
  sessionQuote: ExtendedQuote,
  regular?: QuoteSnapshot,
) {
  if (viewSession === 'pre') {
    return sessionQuote.previousClose ?? regular?.price ?? regular?.previousClose;
  }
  return regular?.previousClose ?? sessionQuote.previousClose;
}

async function fetchTencentQuotes(holdings: Holding[], signal?: AbortSignal): Promise<Map<string, QuoteSnapshot>> {
  const symbols = holdings
    .flatMap((holding) => tencentQuoteSymbols(holding.symbol))
    .filter(Boolean)
    .join(',');
  const url = `/api/quotes?q=${encodeURIComponent(symbols)}`;
  const response = await fetch(url, { signal, cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`quote request failed: ${response.status}`);
  }

  const text = await response.text();
  return parseTencentQuotes(text, holdings);
}

async function fetchSessionUsQuotes(
  holdings: Holding[],
  viewSession: QuoteViewSession,
  signal?: AbortSignal,
): Promise<ExtendedQuotesResponse> {
  const usHoldings = holdings.filter(
    (holding) => holding.market === 'US' && /^[A-Z][A-Z0-9.-]{0,9}\.US$/i.test(holding.symbol),
  );
  if (!usHoldings.length) {
    return { quotes: new Map(), marketSession: getUsMarketSession() };
  }

  const symbols = Array.from(new Set(usHoldings.map((holding) => holding.symbol.toUpperCase())));
  const etfs = Array.from(new Set(
    usHoldings.filter((holding) => holding.type !== '个股').map((holding) => holding.symbol.toUpperCase()),
  ));
  const params = new URLSearchParams({
    symbols: symbols.join(','),
    session: viewSession,
  });
  if (etfs.length) params.set('etfs', etfs.join(','));

  const response = await fetch(`/api/extended-quotes?${params.toString()}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`extended quote request failed: ${response.status}`);
  const payload = (await response.json()) as {
    code?: number;
    data?: {
      quotes?: ExtendedQuote[];
      marketSession?: MarketSession;
      session?: MarketSession | QuoteSession | null;
    };
  };
  const marketSession = payload.data?.marketSession
    ?? (payload.data?.session === 'pre' || payload.data?.session === 'regular' || payload.data?.session === 'post' || payload.data?.session === 'closed'
      ? payload.data.session
      : getUsMarketSession());

  return {
    marketSession,
    quotes: new Map((payload.data?.quotes ?? []).map((quote) => [quote.symbol, quote])),
  };
}

function parseTencentQuotes(text: string, holdings: Holding[]): Map<string, QuoteSnapshot> {
  const quotes = new Map<string, QuoteSnapshot>();

  for (const holding of holdings) {
    const match = tencentQuoteSymbols(holding.symbol)
      .map((remoteSymbol) => text.match(new RegExp(`v_${remoteSymbol}="([^"]+)"`)))
      .find(Boolean);
    if (!match) continue;

    const fields = match[1].split('~');
    const price = Number(fields[3]);
    const previousClose = Number(fields[4]);
    const change = Number(fields[31]);
    if (Number.isFinite(price) && price > 0) {
      quotes.set(holding.symbol, {
        price,
        name: fields[1] || undefined,
        change: Number.isFinite(change) ? change : undefined,
        previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : undefined,
      });
    }
  }

  return quotes;
}

async function fetchYahooQuotes(
  holdings: Holding[],
  signal?: AbortSignal,
  viewSession: QuoteViewSession = 'regular',
): Promise<Map<string, QuoteSnapshot>> {
  const yahooSymbols = new Map(holdings.map((holding) => [holding.symbol, yahooSymbol(holding.symbol)]));
  const symbols = Array.from(yahooSymbols.values()).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
  const response = await fetch(url, { signal, cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`fallback quote request failed: ${response.status}`);
  }

  const payload = (await response.json()) as { quoteResponse?: { result?: YahooQuote[] } };
  const quotes = new Map<string, QuoteSnapshot>();

  for (const [localSymbol, remoteSymbol] of yahooSymbols) {
    const item = payload.quoteResponse?.result?.find((quote) => quote.symbol === remoteSymbol);
    if (!item) continue;

    const previousClose = item.regularMarketPreviousClose;
    let price: number | undefined;
    let session: QuoteSession | undefined;

    if (viewSession === 'pre' && typeof item.preMarketPrice === 'number') {
      price = item.preMarketPrice;
      session = 'pre';
    } else if (viewSession === 'post' && typeof item.postMarketPrice === 'number') {
      price = item.postMarketPrice;
      session = 'post';
    } else {
      price = item.regularMarketPrice;
      session = viewSession === 'regular' ? 'regular' : undefined;
    }

    if (typeof price === 'number' && Number.isFinite(price)) {
      const change = previousClose && previousClose > 0
        ? price - previousClose
        : (session === 'regular' || !session ? item.regularMarketChange : undefined);
      quotes.set(localSymbol, {
        price,
        name: item.longName || item.shortName,
        change: Number.isFinite(change) ? change : undefined,
        previousClose: previousClose && previousClose > 0 ? previousClose : undefined,
        session,
      });
    }
  }

  if (quotes.size === 0) {
    throw new Error('no usable quotes returned');
  }

  return quotes;
}

export async function fetchSecurityQuote(symbol: string, market: Holding['market'], signal?: AbortSignal): Promise<QuoteSnapshot> {
  const normalized = normalizeSecuritySymbol(symbol, market);
  const currency = market === 'HK' ? 'HKD' : 'USD';
  const holding: Holding = {
    broker: '盈立证券',
    account: '行情查询',
    market,
    type: '个股',
    name: normalized,
    symbol: normalized,
    currency,
    qty: 1,
    price: 1,
    cost: 1,
    todayPnl: 0,
    totalPnl: 0,
  };
  const { quotes } = await fetchLatestQuotes([holding], signal, defaultQuoteViewSession());
  const quote = quotes.get(normalized);
  if (!quote) throw new Error('暂未查询到该股票行情');
  return quote;
}

export function normalizeSecuritySymbol(symbol: string, market: Holding['market']) {
  const raw = symbol.trim().toUpperCase();
  if (!raw) return '';
  if (/\.(US|HK)$/.test(raw)) return raw;
  if (market === 'HK' && /^\d{1,5}$/.test(raw)) return `${raw.padStart(5, '0')}.HK`;
  return `${raw}.US`;
}

function tencentQuoteSymbols(symbol: string) {
  const normalized = symbol.toUpperCase();
  const hk = normalized.match(/^(\d{1,5})\.HK$/);
  if (hk) {
    const code = hk[1].padStart(5, '0');
    return [`r_hk${code}`, `hk${code}`];
  }
  const sz = normalized.match(/^(\d{6})\.SZ$/);
  if (sz) return [`sz${sz[1]}`];
  const sh = normalized.match(/^(\d{6})\.(SS|SH)$/);
  if (sh) return [`sh${sh[1]}`];
  const us = normalized.match(/^([A-Z][A-Z0-9.-]{0,9})\.US$/);
  if (us) return [`us${us[1]}`];
  return [symbol];
}

function yahooSymbol(symbol: string) {
  const normalized = symbol.toUpperCase();
  const hk = normalized.match(/^(\d{1,5})\.HK$/);
  if (hk) return `${hk[1].padStart(4, '0')}.HK`;
  const sz = normalized.match(/^(\d{6})\.SZ$/);
  if (sz) return `${sz[1]}.SZ`;
  const sh = normalized.match(/^(\d{6})\.(SS|SH)$/);
  if (sh) return `${sh[1]}.SS`;
  const us = normalized.match(/^([A-Z][A-Z0-9.-]{0,9})\.US$/);
  return us?.[1] ?? symbol;
}

export function applyQuotes(holdings: Holding[], quotes: Map<string, QuoteSnapshot>): Holding[] {
  return holdings.map((holding) => {
    const quote = quotes.get(holding.symbol);
    if (!quote) return holding;

    const price = quote.price;
    const change = quote.change ?? (quote.previousClose ? price - quote.previousClose : undefined);
    const todayPnl = (change ?? 0) * holding.qty;
    const totalPnl = (price - holding.cost) * holding.qty;

    return {
      ...holding,
      price,
      todayPnl,
      totalPnl,
    };
  });
}
