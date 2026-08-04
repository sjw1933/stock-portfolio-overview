import type { BuyRecord, Holding, ImportAuditRecord, SellRecord } from '../types';
import { convert } from './currency';
import { fetchMarketHistory, type TrendPoint } from './marketHistory';

export type ReturnGranularity = 'day' | 'week' | 'month' | 'year';
export type ReturnUnit = 'usd' | 'pct';

export type ReturnDetailRow = {
  symbol: string;
  name: string;
  pnlUsd: number;
  baseUsd: number;
  percent: number | null;
  qtySod: number;
  qtyEod: number;
};

export type DailyReturnPoint = {
  date: string;
  pnlUsd: number;
  baseUsd: number;
  percent: number | null;
  details: ReturnDetailRow[];
};

export type AggregatedReturnPoint = {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  pnlUsd: number;
  baseUsd: number;
  percent: number | null;
  dayCount: number;
  winDays: number;
  details: ReturnDetailRow[];
};

type SymbolMeta = {
  symbol: string;
  name: string;
  currency: Holding['currency'];
  currentQty: number;
  /** First date we have any evidence this symbol was held (trade or snapshot). */
  knownFrom: string;
};

type DayTradeCash = {
  buyCostUsd: number;
  sellProceedsUsd: number;
};

/**
 * Economic day P&L in USD:
 * qtyEod * close - qtySod * prevClose - buyCost + sellProceeds
 *
 * Important: without a full trade ledger we must NOT backfill current qty onto
 * the entire market history. Only days on/after each symbol's knownFrom count.
 */
export async function buildDailyReturns(input: {
  holdings: Holding[];
  buyRecords: BuyRecord[];
  sellRecords: SellRecord[];
  importLogs?: ImportAuditRecord[];
  positionsUpdatedAt?: string;
  savedAt?: string;
  signal?: AbortSignal;
  /** Prefer live mark-to-market for today when available. */
  liveToday?: { date: string; details: ReturnDetailRow[] } | null;
}): Promise<DailyReturnPoint[]> {
  const activeBuys = input.buyRecords.filter((item) => item.status === 'active');
  const activeSells = input.sellRecords.filter((item) => item.status === 'active');
  // Snapshot floor excludes trades: OCR/manual holdings must not inherit another ticker's first buy date.
  const snapshotKnownFrom = resolveSnapshotKnownFrom({
    importLogs: input.importLogs ?? [],
    positionsUpdatedAt: input.positionsUpdatedAt ?? '',
    savedAt: input.savedAt ?? '',
  });
  const metas = collectSymbolMetas(input.holdings, activeBuys, activeSells, snapshotKnownFrom);
  const portfolioStart = earliestDate(metas.map((item) => item.knownFrom).filter(Boolean)) || localDateKey();

  const seriesBySymbol = new Map<string, TrendPoint[]>();
  await Promise.all(metas.map(async (meta) => {
    try {
      const series = await fetchMarketHistory(meta.symbol, 'day', input.signal);
      seriesBySymbol.set(meta.symbol, series.points.filter((point) => point.date || point.key));
    } catch (error) {
      console.warn(`returns history failed for ${meta.symbol}`, error);
    }
  }));

  const allDates = new Set<string>();
  for (const points of seriesBySymbol.values()) {
    for (const point of points) {
      const date = point.date || point.key;
      // Never invent portfolio P&L before any known holding evidence.
      if (date && date >= portfolioStart) allDates.add(date);
    }
  }

  const sortedDates = Array.from(allDates).sort();
  const daily: DailyReturnPoint[] = [];

  for (const date of sortedDates) {
    if (input.liveToday && date === input.liveToday.date) {
      const details = input.liveToday.details;
      const pnlUsd = details.reduce((sum, row) => sum + row.pnlUsd, 0);
      const baseUsd = details.reduce((sum, row) => sum + row.baseUsd, 0);
      daily.push({
        date,
        pnlUsd,
        baseUsd,
        percent: baseUsd > 0.000001 ? (pnlUsd / baseUsd) * 100 : null,
        details: details.filter((row) => Math.abs(row.pnlUsd) > 0.000001 || row.qtyEod > 0 || row.qtySod > 0),
      });
      continue;
    }

    const details: ReturnDetailRow[] = [];
    for (const meta of metas) {
      // No position evidence yet for this ticker on this day.
      if (date < meta.knownFrom) continue;

      const points = seriesBySymbol.get(meta.symbol);
      if (!points?.length) continue;
      const index = points.findIndex((point) => (point.date || point.key) === date);
      if (index <= 0) continue;

      const close = points[index].close ?? points[index].price;
      const prevClose = points[index - 1].close ?? points[index - 1].price;
      if (!(close > 0) || !(prevClose > 0)) continue;

      const qtySod = qtyAtBoundary(meta.symbol, meta.currentQty, activeBuys, activeSells, date, 'sod', meta.knownFrom);
      const qtyEod = qtyAtBoundary(meta.symbol, meta.currentQty, activeBuys, activeSells, date, 'eod', meta.knownFrom);
      const cash = dayTradeCash(meta.symbol, meta.currency, activeBuys, activeSells, date);

      // Convert local currency marks to USD.
      const closeUsd = convert(close, meta.currency, 'USD');
      const prevCloseUsd = convert(prevClose, meta.currency, 'USD');
      const pnlUsd = qtyEod * closeUsd - qtySod * prevCloseUsd - cash.buyCostUsd + cash.sellProceedsUsd;
      const baseUsd = qtySod * prevCloseUsd + cash.buyCostUsd;

      if (Math.abs(pnlUsd) < 0.000001 && qtySod <= 0 && qtyEod <= 0 && cash.buyCostUsd <= 0 && cash.sellProceedsUsd <= 0) {
        continue;
      }

      details.push({
        symbol: meta.symbol,
        name: meta.name,
        pnlUsd,
        baseUsd,
        percent: baseUsd > 0.000001 ? (pnlUsd / baseUsd) * 100 : null,
        qtySod,
        qtyEod,
      });
    }

    if (!details.length) continue;
    details.sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd));
    const pnlUsd = details.reduce((sum, row) => sum + row.pnlUsd, 0);
    const baseUsd = details.reduce((sum, row) => sum + row.baseUsd, 0);
    daily.push({
      date,
      pnlUsd,
      baseUsd,
      percent: baseUsd > 0.000001 ? (pnlUsd / baseUsd) * 100 : null,
      details,
    });
  }

  return daily;
}

export function buildLiveTodayDetails(holdings: Holding[]): ReturnDetailRow[] {
  const bySymbol = new Map<string, ReturnDetailRow>();
  for (const item of holdings) {
    const pnlUsd = convert(item.todayPnl, item.currency, 'USD');
    const marketValueUsd = convert(item.price * item.qty, item.currency, 'USD');
    const baseUsd = Math.max(marketValueUsd - pnlUsd, 0);
    const current = bySymbol.get(item.symbol);
    if (!current) {
      bySymbol.set(item.symbol, {
        symbol: item.symbol,
        name: item.name,
        pnlUsd,
        baseUsd,
        percent: baseUsd > 0.000001 ? (pnlUsd / baseUsd) * 100 : null,
        qtySod: item.qty,
        qtyEod: item.qty,
      });
      continue;
    }
    current.pnlUsd += pnlUsd;
    current.baseUsd += baseUsd;
    current.qtySod += item.qty;
    current.qtyEod += item.qty;
    current.percent = current.baseUsd > 0.000001 ? (current.pnlUsd / current.baseUsd) * 100 : null;
  }
  return Array.from(bySymbol.values()).sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd));
}

export function aggregateReturns(
  daily: DailyReturnPoint[],
  granularity: ReturnGranularity,
): AggregatedReturnPoint[] {
  if (granularity === 'day') {
    return daily.map((point) => ({
      key: point.date,
      label: point.date.slice(5),
      startDate: point.date,
      endDate: point.date,
      pnlUsd: point.pnlUsd,
      baseUsd: point.baseUsd,
      percent: point.percent,
      dayCount: 1,
      winDays: point.pnlUsd > 0 ? 1 : 0,
      details: point.details,
    }));
  }

  const groups = new Map<string, DailyReturnPoint[]>();
  for (const point of daily) {
    const key = granularity === 'week'
      ? weekKey(point.date)
      : granularity === 'month'
        ? point.date.slice(0, 7)
        : point.date.slice(0, 4);
    const list = groups.get(key) ?? [];
    list.push(point);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, points]) => {
      const pnlUsd = points.reduce((sum, item) => sum + item.pnlUsd, 0);
      // Use first day's base as period base for % display (common retail calendar style).
      const baseUsd = points[0]?.baseUsd ?? 0;
      const details = mergeDetails(points.flatMap((item) => item.details));
      return {
        key,
        label: formatAggregateLabel(key, granularity, points[0].date, points[points.length - 1].date),
        startDate: points[0].date,
        endDate: points[points.length - 1].date,
        pnlUsd,
        baseUsd,
        percent: baseUsd > 0.000001 ? (pnlUsd / baseUsd) * 100 : null,
        dayCount: points.length,
        winDays: points.filter((item) => item.pnlUsd > 0).length,
        details,
      };
    });
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function monthMatrix(year: number, monthIndex: number) {
  // monthIndex 0-11; weeks start Sunday (matches retail calendar UIs)
  const first = new Date(year, monthIndex, 1);
  const firstWeekday = first.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<string | null> = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const month = String(monthIndex + 1).padStart(2, '0');
    const dayText = String(day).padStart(2, '0');
    cells.push(`${year}-${month}-${dayText}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Compact cell text like +3.77% / -1.33% / 0.00% */
export function formatReturnPctCell(percent: number | null, masked: boolean) {
  if (masked) return '****';
  if (percent == null || !Number.isFinite(percent)) return '0.00%';
  if (Math.abs(percent) < 0.005) return '0.00%';
  const prefix = percent > 0 ? '+' : '';
  return `${prefix}${percent.toFixed(2)}%`;
}

/** Compact dollar cell text. */
export function formatReturnUsdCell(amount: number, masked: boolean) {
  if (masked) return '****';
  if (Math.abs(amount) < 0.005) return '$0';
  const prefix = amount > 0 ? '+' : amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 10000) return `${prefix}${(abs / 1000).toFixed(1)}k`;
  if (abs >= 1000) return amount < 0 ? `-$${(abs / 1000).toFixed(1)}k` : `+$${(abs / 1000).toFixed(1)}k`;
  const body = abs.toLocaleString('zh-CN', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
  return amount < 0 ? `-$${body}` : amount > 0 ? `+$${body}` : `$${body}`;
}

export function formatDotDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return date.replace(/-/g, '.');
}

export function formatReturnUsd(amount: number, masked: boolean) {
  if (masked) return '$ ****';
  const prefix = amount > 0 ? '+' : amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 10000) return `${prefix}${(abs / 1000).toFixed(1)}k`;
  if (abs >= 1000) return `${prefix}$${(abs / 1000).toFixed(2)}k`.replace('$-', '-$');
  const body = abs.toLocaleString('zh-CN', { maximumFractionDigits: 0, minimumFractionDigits: 0 });
  if (amount < 0) return `-$${body}`;
  if (amount > 0) return `+$${body}`;
  return `$${body}`;
}

export function formatReturnUsdFull(amount: number, masked: boolean) {
  if (masked) return '$ ****';
  const prefix = amount > 0 ? '+' : amount < 0 ? '-' : '';
  const body = Math.abs(amount).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
  if (amount < 0) return `-$${body}`;
  if (amount > 0) return `+$${body}`;
  return `$${body}`;
}

export function formatReturnPct(percent: number | null, masked: boolean) {
  if (masked) return '****';
  if (percent == null || !Number.isFinite(percent)) return '--';
  const prefix = percent > 0 ? '+' : '';
  return `${prefix}${percent.toFixed(2)}%`;
}

function collectSymbolMetas(
  holdings: Holding[],
  buys: BuyRecord[],
  sells: SellRecord[],
  snapshotKnownFrom: string,
): SymbolMeta[] {
  const map = new Map<string, SymbolMeta>();

  for (const item of holdings) {
    const current = map.get(item.symbol);
    if (!current) {
      map.set(item.symbol, {
        symbol: item.symbol,
        name: item.name,
        currency: item.currency,
        currentQty: item.qty,
        knownFrom: snapshotKnownFrom,
      });
    } else {
      current.currentQty += item.qty;
      if (!current.name) current.name = item.name;
    }
  }

  for (const item of [...buys, ...sells]) {
    const day = tradeDateKey(item.tradedAt);
    const existing = map.get(item.symbol);
    if (!existing) {
      map.set(item.symbol, {
        symbol: item.symbol,
        name: item.name,
        currency: item.currency,
        currentQty: 0,
        knownFrom: day || snapshotKnownFrom,
      });
      continue;
    }
    if (day && day < existing.knownFrom) existing.knownFrom = day;
  }

  // Pure trade-led symbols already have knownFrom from first trade.
  // Snapshot-only holdings stay at snapshotKnownFrom (do not invent earlier history).
  return Array.from(map.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Earliest date we know holdings from a snapshot/import (not trade reconstruction).
 * Used only as the floor for tickers that lack their own buy/sell history.
 */
function resolveSnapshotKnownFrom(input: {
  importLogs: ImportAuditRecord[];
  positionsUpdatedAt: string;
  savedAt: string;
}) {
  const dates: string[] = [];
  for (const log of input.importLogs) {
    const day = isoToDateKey(log.savedAt);
    if (day) dates.push(day);
  }
  for (const value of [input.positionsUpdatedAt, input.savedAt]) {
    const day = isoToDateKey(value);
    if (day) dates.push(day);
  }
  // No import/snapshot timestamp → only today is trustworthy for snapshot holdings.
  return earliestDate(dates) || localDateKey();
}

function isoToDateKey(value: string) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return localDateKey(date);
}

function earliestDate(dates: string[]) {
  const clean = dates.filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)).sort();
  return clean[0] || '';
}

function tradeDateKey(tradedAt: string) {
  if (/^\d{4}-\d{2}-\d{2}/.test(tradedAt)) return tradedAt.slice(0, 10);
  const date = new Date(tradedAt);
  if (Number.isNaN(date.getTime())) return '';
  return localDateKey(date);
}

function qtyAtBoundary(
  symbol: string,
  currentQty: number,
  buys: BuyRecord[],
  sells: SellRecord[],
  date: string,
  mode: 'sod' | 'eod',
  knownFrom: string,
) {
  // Before we know the position existed, force zero (prevents year-long backfill).
  if (date < knownFrom) return 0;

  let qty = currentQty;
  for (const buy of buys) {
    if (buy.symbol !== symbol) continue;
    const day = tradeDateKey(buy.tradedAt);
    if (!day) continue;
    const undo = mode === 'sod' ? day >= date : day > date;
    if (undo) qty -= buy.qty;
  }
  for (const sell of sells) {
    if (sell.symbol !== symbol) continue;
    const day = tradeDateKey(sell.tradedAt);
    if (!day) continue;
    const undo = mode === 'sod' ? day >= date : day > date;
    if (undo) qty += sell.qty;
  }
  return Math.max(0, qty);
}

function dayTradeCash(
  symbol: string,
  currency: Holding['currency'],
  buys: BuyRecord[],
  sells: SellRecord[],
  date: string,
): DayTradeCash {
  let buyCostUsd = 0;
  let sellProceedsUsd = 0;
  for (const buy of buys) {
    if (buy.symbol !== symbol || tradeDateKey(buy.tradedAt) !== date) continue;
    buyCostUsd += convert(buy.price * buy.qty + buy.fees, buy.currency || currency, 'USD');
  }
  for (const sell of sells) {
    if (sell.symbol !== symbol || tradeDateKey(sell.tradedAt) !== date) continue;
    sellProceedsUsd += convert(sell.price * sell.qty - sell.fees, sell.currency || currency, 'USD');
  }
  return { buyCostUsd, sellProceedsUsd };
}

function mergeDetails(rows: ReturnDetailRow[]): ReturnDetailRow[] {
  const map = new Map<string, ReturnDetailRow>();
  for (const row of rows) {
    const current = map.get(row.symbol);
    if (!current) {
      map.set(row.symbol, { ...row });
      continue;
    }
    current.pnlUsd += row.pnlUsd;
    current.baseUsd += row.baseUsd;
    current.qtySod = Math.max(current.qtySod, row.qtySod);
    current.qtyEod = Math.max(current.qtyEod, row.qtyEod);
    current.percent = current.baseUsd > 0.000001 ? (current.pnlUsd / current.baseUsd) * 100 : null;
  }
  return Array.from(map.values()).sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd));
}

function weekKey(dateValue: string) {
  const date = new Date(`${dateValue}T12:00:00`);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() + 4 - day);
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function formatAggregateLabel(
  key: string,
  granularity: ReturnGranularity,
  startDate: string,
  endDate: string,
) {
  if (granularity === 'week') {
    return `${key.replace('-W', ' 第')}周 · ${startDate.slice(5)}~${endDate.slice(5)}`;
  }
  if (granularity === 'month') {
    const [year, month] = key.split('-');
    return `${year}年${Number(month)}月`;
  }
  if (granularity === 'year') return `${key}年`;
  return key;
}
