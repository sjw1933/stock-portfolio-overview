import type { Holding, QuoteSession } from '../types';

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

export async function fetchLatestQuotes(holdings: Holding[], signal?: AbortSignal): Promise<Map<string, QuoteSnapshot>> {
  const [regularResult, extendedResult] = await Promise.allSettled([
    fetchTencentQuotes(holdings, signal),
    fetchExtendedUsQuotes(holdings, signal),
  ]);
  const quotes = regularResult.status === 'fulfilled' ? regularResult.value : new Map<string, QuoteSnapshot>();

  if (extendedResult.status === 'fulfilled') {
    for (const [symbol, extended] of extendedResult.value) {
      const regular = quotes.get(symbol);
      const previousClose = regular?.previousClose ?? extended.previousClose;
      quotes.set(symbol, {
        ...regular,
        price: extended.price,
        previousClose,
        change: previousClose ? extended.price - previousClose : undefined,
        session: extended.session,
        updatedAt: extended.updatedAt,
      });
    }
  }

  if (quotes.size === 0) return fetchYahooQuotes(holdings, signal);
  return quotes;
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

async function fetchExtendedUsQuotes(holdings: Holding[], signal?: AbortSignal): Promise<Map<string, ExtendedQuote>> {
  const usHoldings = holdings.filter(
    (holding) => holding.market === 'US' && /^[A-Z][A-Z0-9.-]{0,9}\.US$/i.test(holding.symbol),
  );
  if (!usHoldings.length) return new Map();

  const symbols = Array.from(new Set(usHoldings.map((holding) => holding.symbol.toUpperCase())));
  const etfs = Array.from(new Set(
    usHoldings.filter((holding) => holding.type !== '个股').map((holding) => holding.symbol.toUpperCase()),
  ));
  const params = new URLSearchParams({ symbols: symbols.join(',') });
  if (etfs.length) params.set('etfs', etfs.join(','));

  const response = await fetch(`/api/extended-quotes?${params.toString()}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`extended quote request failed: ${response.status}`);
  const payload = (await response.json()) as { code?: number; data?: { quotes?: ExtendedQuote[] } };
  return new Map((payload.data?.quotes ?? []).map((quote) => [quote.symbol, quote]));
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

async function fetchYahooQuotes(holdings: Holding[], signal?: AbortSignal): Promise<Map<string, QuoteSnapshot>> {
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
    const price = item?.regularMarketPrice ?? item?.postMarketPrice ?? item?.preMarketPrice;
    if (typeof price === 'number' && Number.isFinite(price)) {
      quotes.set(localSymbol, {
        price,
        name: item?.longName || item?.shortName,
        change: item?.regularMarketChange,
        previousClose: item?.regularMarketPreviousClose,
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
  const quotes = await fetchLatestQuotes([holding], signal);
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
