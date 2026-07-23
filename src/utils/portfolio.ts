import type { AccountSnapshot, AggregatedHolding, Currency, Holding, PortfolioSummary, SellRecord } from '../types';
import { convert } from './currency';

export function buildSummary(
  holdings: Holding[],
  currency: Currency,
  accountSnapshots: AccountSnapshot[] = [],
  cashBaselineHoldings: Holding[] = holdings,
  sellRecords: SellRecord[] = [],
  positionsUpdatedAt = '',
  accountPositionsUpdatedAt: Record<string, string> = {},
): PortfolioSummary {
  const gross = holdings.reduce((sum, item) => sum + convert(item.price * item.qty, item.currency, currency), 0);
  const cost = holdings.reduce((sum, item) => sum + convert(item.cost * item.qty, item.currency, currency), 0);
  const accountNetAsset = accountSnapshots.reduce((sum, item) => sum + convert(item.netAsset, item.currency, currency), 0);
  const baselineGross = cashBaselineHoldings.reduce((sum, item) => sum + convert(item.price * item.qty, item.currency, currency), 0);
  const activeSales = sellRecords.filter((record) => record.status === 'active');
  const postSnapshotSales = activeSales.filter((record) => {
    const accountUpdatedAt = accountPositionsUpdatedAt[accountKey(record)] || positionsUpdatedAt;
    return !accountUpdatedAt || record.createdAt > accountUpdatedAt;
  });
  const cashAdjustment = postSnapshotSales.reduce(
    (sum, record) => sum + convert((record.price - record.positionPriceAtSell) * record.qty - record.fees, record.currency, currency),
    0,
  );
  const cash = Math.max(accountNetAsset - baselineGross + cashAdjustment, 0);
  const totalPnl = holdings.reduce((sum, item) => sum + convert(item.totalPnl, item.currency, currency), 0);
  const todayPnl = holdings.reduce((sum, item) => sum + convert(item.todayPnl, item.currency, currency), 0);
  const realizedPnl = activeSales.reduce((sum, record) => sum + convert(record.realizedPnl, record.currency, currency), 0);
  const today = localDateKey(new Date());
  const todayRealizedPnl = activeSales
    .filter((record) => localDateKey(new Date(record.tradedAt)) === today)
    .reduce((sum, record) => sum + convert(record.realizedPnl, record.currency, currency), 0);
  const sellFees = activeSales.reduce((sum, record) => sum + convert(record.fees, record.currency, currency), 0);
  return {
    gross,
    cost,
    cash,
    total: gross + cash,
    totalPnl,
    todayPnl,
    realizedPnl,
    todayRealizedPnl,
    totalReturn: totalPnl + realizedPnl,
    sellFees,
  };
}

function accountKey(item: Pick<Holding, 'broker' | 'account' | 'market'>) {
  return `${item.broker}::${item.account}::${item.market}`;
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function aggregateHoldings(holdings: Holding[], currency: Currency): AggregatedHolding[] {
  const map = new Map<string, AggregatedHolding>();

  for (const item of holdings) {
    const current = map.get(item.symbol);
    const marketValue = item.price * item.qty;

    if (!current) {
      map.set(item.symbol, { ...item, rows: [item], marketValue });
      continue;
    }

    const previousQty = current.qty;
    current.qty += item.qty;
    current.marketValue += marketValue;
    current.todayPnl += item.todayPnl;
    current.totalPnl += item.totalPnl;
    current.cost = (current.cost * previousQty + item.cost * item.qty) / current.qty;
    current.rows.push(item);
  }

  return Array.from(map.values()).sort(
    (a, b) => convert(b.marketValue, b.currency, currency) - convert(a.marketValue, a.currency, currency),
  );
}
