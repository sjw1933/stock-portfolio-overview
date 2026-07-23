import type { BuyInput, BuyRecord, Holding, SavedSnapshot, SellRecord } from '../types';
import { holdingKey } from './sellTransactions';

const quantityEpsilon = 0.0000001;

export function applyBuy(snapshot: SavedSnapshot, input: BuyInput): SavedSnapshot {
  const normalizedInput = normalizeInput(input);
  const index = snapshot.holdings.findIndex((holding) => holdingKey(holding) === holdingKey(normalizedInput));
  const existing = index >= 0 ? snapshot.holdings[index] : null;
  const beforeQty = existing?.qty ?? 0;
  const beforeCost = existing?.cost ?? 0;
  const afterQty = roundQuantity(beforeQty + normalizedInput.qty);
  const totalCost = normalizedInput.price * normalizedInput.qty + normalizedInput.fees;
  const afterCost = roundPrice(((beforeCost * beforeQty) + totalCost) / afterQty);
  const positionPriceAtBuy = normalizedInput.currentPrice || existing?.price || normalizedInput.price;
  const now = new Date().toISOString();

  const record: BuyRecord = {
    id: createId(),
    type: 'buy',
    status: 'active',
    broker: normalizedInput.broker,
    account: normalizedInput.account,
    market: normalizedInput.market,
    holdingType: existing?.type ?? normalizedInput.holdingType,
    name: existing?.name ?? normalizedInput.name,
    symbol: normalizedInput.symbol,
    currency: normalizedInput.currency,
    qty: normalizedInput.qty,
    price: normalizedInput.price,
    fees: normalizedInput.fees,
    totalCost,
    beforeQty,
    afterQty,
    beforeCost,
    afterCost,
    positionPriceAtBuy,
    tradedAt: normalizedInput.tradedAt,
    note: normalizedInput.note,
    createdAt: now,
  };

  const holding: Holding = {
    broker: normalizedInput.broker,
    account: normalizedInput.account,
    market: normalizedInput.market,
    type: existing?.type ?? normalizedInput.holdingType,
    name: existing?.name ?? normalizedInput.name,
    symbol: normalizedInput.symbol,
    currency: normalizedInput.currency,
    qty: afterQty,
    price: positionPriceAtBuy,
    cost: afterCost,
    todayPnl: existing?.todayPnl ?? 0,
    totalPnl: (positionPriceAtBuy - afterCost) * afterQty,
  };
  const holdings = [...snapshot.holdings];
  if (index >= 0) holdings[index] = holding;
  else holdings.push(holding);

  return {
    ...snapshot,
    savedAt: now,
    holdings,
    buyRecords: [record, ...snapshot.buyRecords],
  };
}

export function reverseBuy(snapshot: SavedSnapshot, recordId: string): SavedSnapshot {
  const record = snapshot.buyRecords.find((item) => item.id === recordId);
  if (!record || record.status !== 'active') throw new Error('该买入记录已经撤销或不存在');

  const accountUpdatedAt = snapshot.accountPositionsUpdatedAt[accountKey(record)] || snapshot.positionsUpdatedAt;
  const hasLaterSnapshot = accountUpdatedAt > record.createdAt;
  const hasLaterTrade = hasLaterActiveTrade(snapshot.buyRecords, snapshot.sellRecords, record);
  const index = snapshot.holdings.findIndex((holding) => holdingKey(holding) === holdingKey(record));
  const current = index >= 0 ? snapshot.holdings[index] : null;
  const positionStillMatches = Boolean(current && Math.abs(current.qty - record.afterQty) <= quantityEpsilon);
  const historyOnly = hasLaterSnapshot || hasLaterTrade || !positionStillMatches;
  const holdings = [...snapshot.holdings];

  if (!historyOnly && index >= 0) {
    if (record.beforeQty <= quantityEpsilon) {
      holdings.splice(index, 1);
    } else {
      const restored = holdings[index];
      holdings[index] = {
        ...restored,
        qty: record.beforeQty,
        cost: record.beforeCost,
        totalPnl: (restored.price - record.beforeCost) * record.beforeQty,
      };
    }
  }

  const now = new Date().toISOString();
  return {
    ...snapshot,
    savedAt: now,
    holdings,
    buyRecords: snapshot.buyRecords.map((item) => item.id === recordId ? {
      ...item,
      status: 'reversed',
      reversedAt: now,
      reversalEffect: historyOnly ? 'history-only' : 'position-adjusted',
    } : item),
  };
}

function normalizeInput(input: BuyInput): BuyInput {
  const qty = roundQuantity(input.qty);
  const price = roundPrice(input.price);
  const fees = roundMoney(input.fees || 0);
  const currentPrice = roundPrice(input.currentPrice || input.price);
  const tradedAt = normalizeTradeTime(input.tradedAt);
  const symbol = normalizeSymbol(input.symbol, input.market);
  const account = input.account.trim();
  const name = input.name.trim();

  if (!account) throw new Error('请选择或填写券商账户');
  if (!symbol) throw new Error('股票代码不能为空');
  if (!name) throw new Error('股票名称不能为空');
  if (qty <= 0) throw new Error('买入数量必须大于 0');
  if (!Number.isFinite(price) || price <= 0) throw new Error('成交价格必须大于 0');
  if (!Number.isFinite(fees) || fees < 0) throw new Error('手续费不能小于 0');
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error('当前价格必须大于 0');
  if (!tradedAt) throw new Error('成交日期时间无效');

  return {
    ...input,
    account: account.slice(0, 80),
    name: name.slice(0, 80),
    symbol,
    qty,
    price,
    fees,
    currentPrice,
    tradedAt,
    note: input.note.trim().slice(0, 240),
  };
}

function hasLaterActiveTrade(buys: BuyRecord[], sells: SellRecord[], record: BuyRecord) {
  return [...buys, ...sells].some((item) => (
    item.id !== record.id
    && item.status === 'active'
    && holdingKey(item) === holdingKey(record)
    && item.createdAt > record.createdAt
  ));
}

function normalizeSymbol(value: string, market: Holding['market']) {
  const raw = value.trim().toUpperCase();
  if (!raw) return '';
  if (/\.(US|HK)$/.test(raw)) return raw;
  if (market === 'HK' && /^\d{1,5}$/.test(raw)) return `${raw.padStart(5, '0')}.HK`;
  return `${raw}.US`;
}

function accountKey(holding: Pick<Holding, 'broker' | 'account' | 'market'>) {
  return `${holding.broker}::${holding.account}::${holding.market}`;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `buy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function roundQuantity(value: number) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function roundPrice(value: number) {
  return Math.round(Number(value) * 10000) / 10000;
}

function roundMoney(value: number) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeTradeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (date.getTime() > Date.now() + 5 * 60 * 1000) throw new Error('成交时间不能晚于当前时间');
  return date.toISOString();
}
