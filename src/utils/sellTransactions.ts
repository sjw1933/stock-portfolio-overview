import type { Holding, SavedSnapshot, SellInput, SellRecord } from '../types';

const quantityEpsilon = 0.0000001;

export function applySell(snapshot: SavedSnapshot, liveHolding: Holding, input: SellInput): SavedSnapshot {
  const index = snapshot.holdings.findIndex((holding) => holdingKey(holding) === holdingKey(liveHolding));
  if (index < 0) throw new Error('该账户持仓已变化，请刷新后重新登记');

  const holding = snapshot.holdings[index];
  const qty = roundQuantity(input.qty);
  const price = Number(input.price);
  const costAtSell = Number(input.costAtSell);
  const fees = Number(input.fees || 0);
  const tradedAt = normalizeTradeTime(input.tradedAt);

  if (qty <= 0) throw new Error('卖出数量必须大于 0');
  if (qty - holding.qty > quantityEpsilon) throw new Error(`卖出数量不能超过当前持仓 ${formatQty(holding.qty)}`);
  if (!Number.isFinite(price) || price <= 0) throw new Error('成交价格必须大于 0');
  if (!Number.isFinite(costAtSell) || costAtSell <= 0) throw new Error('卖出时成本价必须大于 0');
  if (!Number.isFinite(fees) || fees < 0) throw new Error('手续费不能小于 0');
  if (!tradedAt) throw new Error('成交日期时间无效');

  const afterQty = Math.max(0, roundQuantity(holding.qty - qty));
  const now = new Date().toISOString();
  const record: SellRecord = {
    id: createId(),
    type: 'sell',
    status: 'active',
    broker: holding.broker,
    account: holding.account,
    market: holding.market,
    holdingType: holding.type,
    name: holding.name,
    symbol: holding.symbol,
    currency: holding.currency,
    qty,
    price,
    costAtSell,
    holdingCost: holding.cost,
    positionPriceAtSell: liveHolding.price,
    fees,
    realizedPnl: (price - costAtSell) * qty - fees,
    beforeQty: holding.qty,
    afterQty,
    tradedAt,
    note: input.note.trim().slice(0, 240),
    createdAt: now,
  };

  const holdings = [...snapshot.holdings];
  if (afterQty <= quantityEpsilon) {
    holdings.splice(index, 1);
  } else {
    holdings[index] = {
      ...holding,
      qty: afterQty,
      todayPnl: holding.qty > 0 ? holding.todayPnl * (afterQty / holding.qty) : 0,
      totalPnl: (holding.price - holding.cost) * afterQty,
    };
  }

  return {
    ...snapshot,
    savedAt: now,
    holdings,
    sellRecords: [record, ...snapshot.sellRecords],
  };
}

export function reverseSell(snapshot: SavedSnapshot, recordId: string): SavedSnapshot {
  const record = snapshot.sellRecords.find((item) => item.id === recordId);
  if (!record || record.status !== 'active') throw new Error('该卖出记录已经撤销或不存在');
  const accountUpdatedAt = snapshot.accountPositionsUpdatedAt[accountKey(record)] || snapshot.positionsUpdatedAt;
  if (accountUpdatedAt > record.createdAt) {
    throw new Error('最新 OCR 持仓已经晚于这笔卖出，不能自动恢复数量；请通过新截图校准持仓');
  }

  const index = snapshot.holdings.findIndex((holding) => holdingKey(holding) === holdingKey(record));
  const holdings = [...snapshot.holdings];
  if (index < 0) {
    holdings.push({
      broker: record.broker,
      account: record.account,
      market: record.market,
      type: record.holdingType,
      name: record.name,
      symbol: record.symbol,
      currency: record.currency,
      qty: record.qty,
      price: record.positionPriceAtSell,
      cost: record.holdingCost,
      todayPnl: 0,
      totalPnl: (record.positionPriceAtSell - record.holdingCost) * record.qty,
    });
  } else {
    const holding = holdings[index];
    const qty = roundQuantity(holding.qty + record.qty);
    const cost = ((holding.cost * holding.qty) + (record.holdingCost * record.qty)) / qty;
    holdings[index] = {
      ...holding,
      qty,
      cost,
      totalPnl: (holding.price - cost) * qty,
    };
  }

  const now = new Date().toISOString();
  return {
    ...snapshot,
    savedAt: now,
    holdings,
    sellRecords: snapshot.sellRecords.map((item) => item.id === recordId ? { ...item, status: 'reversed', reversedAt: now } : item),
  };
}

export function holdingKey(holding: Pick<Holding, 'broker' | 'account' | 'market' | 'symbol'>) {
  return `${holding.broker}::${holding.account}::${holding.market}::${holding.symbol.toUpperCase()}`;
}

function accountKey(holding: Pick<Holding, 'broker' | 'account' | 'market'>) {
  return `${holding.broker}::${holding.account}::${holding.market}`;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `sell-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function roundQuantity(value: number) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function normalizeTradeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (date.getTime() > Date.now() + 5 * 60 * 1000) throw new Error('成交时间不能晚于当前时间');
  return date.toISOString();
}

function formatQty(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}
