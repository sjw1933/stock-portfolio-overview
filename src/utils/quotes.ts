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

type SessionQuoteMaps = {
  pre: Map<string, ExtendedQuote>;
  regular: Map<string, ExtendedQuote>;
  post: Map<string, ExtendedQuote>;
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
  const [regularResult, multiResult] = await Promise.allSettled([
    fetchTencentQuotes(holdings, signal),
    fetchAllSessionUsQuotes(holdings, signal),
  ]);

  const baseQuotes = regularResult.status === 'fulfilled' ? regularResult.value : new Map<string, QuoteSnapshot>();
  const marketSession = multiResult.status === 'fulfilled'
    ? multiResult.value.marketSession
    : localMarketSession;
  const sessionMaps = multiResult.status === 'fulfilled'
    ? multiResult.value.quotesBySession
    : emptySessionMaps();

  const quotes = buildViewQuotes(baseQuotes, sessionMaps, viewSession);

  if (quotes.size === 0) {
    const fallback = await fetchYahooQuotes(holdings, signal, viewSession);
    return { quotes: fallback, marketSession };
  }

  return { quotes, marketSession };
}

function emptySessionMaps(): SessionQuoteMaps {
  return {
    pre: new Map(),
    regular: new Map(),
    post: new Map(),
  };
}

/**
 * Build the quote map for the selected session.
 * Mark price (and therefore total PnL / market value) always follows the session price.
 * Today change is session price vs prior close when available.
 */
function buildViewQuotes(
  baseQuotes: Map<string, QuoteSnapshot>,
  sessionMaps: SessionQuoteMaps,
  viewSession: QuoteViewSession,
): Map<string, QuoteSnapshot> {
  const quotes = new Map<string, QuoteSnapshot>();

  for (const [symbol, base] of baseQuotes) {
    quotes.set(symbol, {
      ...base,
      session: /\.US$/i.test(symbol) ? viewSession : base.session,
    });
  }

  // Prefer official regular-session marks for US when available (important after hours).
  if (viewSession === 'regular') {
    for (const [symbol, regular] of sessionMaps.regular) {
      const base = quotes.get(symbol);
      const previousClose = base?.previousClose ?? regular.previousClose;
      const price = regular.price;
      quotes.set(symbol, {
        ...base,
        price,
        previousClose,
        change: previousClose ? price - previousClose : base?.change,
        session: 'regular',
        updatedAt: regular.updatedAt,
      });
    }
    return quotes;
  }

  const sessionQuotes = sessionMaps[viewSession];
  for (const [symbol, sessionQuote] of sessionQuotes) {
    const base = quotes.get(symbol);
    const regular = sessionMaps.regular.get(symbol);
    const previousClose = resolveSessionPreviousClose(viewSession, sessionQuote, base, regular);
    const price = sessionQuote.price;
    quotes.set(symbol, {
      ...base,
      price,
      previousClose,
      change: previousClose ? price - previousClose : undefined,
      session: viewSession,
      updatedAt: sessionQuote.updatedAt,
    });
  }

  // Tag remaining US names with the selected view even if only base tape is available.
  for (const [symbol, quote] of quotes) {
    if (/\.US$/i.test(symbol) && !quote.session) {
      quotes.set(symbol, { ...quote, session: viewSession });
    }
  }

  return quotes;
}

function resolveSessionPreviousClose(
  viewSession: QuoteViewSession,
  sessionQuote: ExtendedQuote,
  base?: QuoteSnapshot,
  regular?: ExtendedQuote,
) {
  // Prefer official prior close so total mark and today move share one baseline day.
  if (sessionQuote.previousClose && sessionQuote.previousClose > 0) return sessionQuote.previousClose;
  if (regular?.previousClose && regular.previousClose > 0) return regular.previousClose;
  if (base?.previousClose && base.previousClose > 0) return base.previousClose;
  // During pre, tape "price" on some feeds is still yesterday's regular close.
  if (viewSession === 'pre' && base?.price && base.price > 0) return base.price;
  return undefined;
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

async function fetchAllSessionUsQuotes(
  holdings: Holding[],
  signal?: AbortSignal,
): Promise<{ quotesBySession: SessionQuoteMaps; marketSession: MarketSession }> {
  const usHoldings = holdings.filter(
    (holding) => holding.market === 'US' && /^[A-Z][A-Z0-9.-]{0,9}\.US$/i.test(holding.symbol),
  );
  if (!usHoldings.length) {
    return { quotesBySession: emptySessionMaps(), marketSession: getUsMarketSession() };
  }

  const symbols = Array.from(new Set(usHoldings.map((holding) => holding.symbol.toUpperCase())));
  const etfs = Array.from(new Set(
    usHoldings.filter((holding) => holding.type !== '个股').map((holding) => holding.symbol.toUpperCase()),
  ));
  const params = new URLSearchParams({
    symbols: symbols.join(','),
    session: 'all',
  });
  if (etfs.length) params.set('etfs', etfs.join(','));

  const response = await fetch(`/api/extended-quotes?${params.toString()}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`extended quote request failed: ${response.status}`);
  const payload = (await response.json()) as {
    code?: number;
    data?: {
      marketSession?: MarketSession;
      session?: MarketSession | QuoteSession | 'all' | null;
      quotesBySession?: {
        pre?: ExtendedQuote[];
        regular?: ExtendedQuote[];
        post?: ExtendedQuote[];
      };
      quotes?: ExtendedQuote[];
    };
  };

  const marketSession = payload.data?.marketSession
    ?? (payload.data?.session === 'pre' || payload.data?.session === 'regular' || payload.data?.session === 'post' || payload.data?.session === 'closed'
      ? payload.data.session
      : getUsMarketSession());

  const source = payload.data?.quotesBySession;
  const quotesBySession: SessionQuoteMaps = {
    pre: new Map((source?.pre ?? []).map((quote) => [quote.symbol, quote])),
    regular: new Map((source?.regular ?? []).map((quote) => [quote.symbol, quote])),
    post: new Map((source?.post ?? []).map((quote) => [quote.symbol, quote])),
  };

  // Backward compatible: single-session payload still works.
  if (!source && payload.data?.quotes?.length) {
    for (const quote of payload.data.quotes) {
      if (quote.session === 'pre' || quote.session === 'regular' || quote.session === 'post') {
        quotesBySession[quote.session].set(quote.symbol, quote);
      }
    }
  }

  return { quotesBySession, marketSession };
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
  const currency = market === 'HK' ? 'HKD' : market === 'CN' ? 'CNY' : 'USD';
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
  const raw = symbol.trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return '';
  // Already-qualified tickers.
  if (/\.US$/.test(raw)) return raw;
  if (/\.HK$/.test(raw)) return raw.replace(/^(\d{1,5})\.HK$/, (_, code: string) => `${code.padStart(5, '0')}.HK`);
  if (/\.SS$/.test(raw)) return raw.replace(/\.SS$/, '.SH');
  if (/\.(SH|SZ)$/.test(raw)) return raw;

  if (market === 'HK' && /^\d{1,5}$/.test(raw)) return `${raw.padStart(5, '0')}.HK`;

  // A-shares: 6-digit codes → Shanghai (.SH) or Shenzhen (.SZ).
  if (market === 'CN' && /^\d{6}$/.test(raw)) {
    if (raw.startsWith('6') || raw.startsWith('5') || raw.startsWith('9')) return `${raw}.SH`;
    return `${raw}.SZ`;
  }

  if (market === 'CN') return raw.includes('.') ? raw : `${raw}.SH`;
  if (market === 'HK') return raw.includes('.') ? raw : `${raw}.HK`;
  return raw.includes('.') ? raw : `${raw}.US`;
}

export function inferMarketFromSymbol(symbol: string): Holding['market'] {
  const raw = symbol.trim().toUpperCase();
  if (/\.HK$/.test(raw)) return 'HK';
  if (/\.(SH|SS|SZ)$/.test(raw)) return 'CN';
  return 'US';
}

export function inferCurrencyFromSymbol(symbol: string): Holding['currency'] {
  const market = inferMarketFromSymbol(symbol);
  if (market === 'HK') return 'HKD';
  if (market === 'CN') return 'CNY';
  return 'USD';
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

/**
 * Reprice holdings from the selected session quotes.
 * Always recalculates both today PnL and total unrealized PnL from the session mark.
 */
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
