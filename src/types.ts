import type React from 'react';

export type Currency = 'HKD' | 'USD' | 'CNY';
/** Live US market clock session. */
export type MarketSession = 'pre' | 'regular' | 'post' | 'closed';
/** User-selectable quote / PnL view. */
export type QuoteViewSession = 'pre' | 'regular' | 'post';
/** Session tag shown on a price (matches the active view when data is session-specific). */
export type QuoteSession = QuoteViewSession;
export type Tab = 'overview' | 'holdings' | 'returns' | 'trends' | 'ask' | 'import';
export type Broker = '盈立证券' | '致富证券' | '星财富' | 'Schwab' | 'US Bancorp Advisors';

export type AiProvider = 'openai' | 'anthropic';

export type AiApiConfig = {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type Market = 'US' | 'HK' | 'CN';
export type HoldingCurrency = 'USD' | 'HKD' | 'CNY';

export type Holding = {
  broker: Broker;
  account: string;
  market: Market;
  type: '个股' | 'ETF' | '杠杆ETF';
  name: string;
  symbol: string;
  currency: HoldingCurrency;
  qty: number;
  price: number;
  cost: number;
  todayPnl: number;
  totalPnl: number;
};

export type SellRecord = {
  id: string;
  type: 'sell';
  status: 'active' | 'reversed';
  broker: Broker;
  account: string;
  market: Holding['market'];
  holdingType: Holding['type'];
  name: string;
  symbol: string;
  currency: Holding['currency'];
  qty: number;
  price: number;
  costAtSell: number;
  holdingCost: number;
  positionPriceAtSell: number;
  fees: number;
  realizedPnl: number;
  todayRealizedPnl: number;
  beforeQty: number;
  afterQty: number;
  tradedAt: string;
  note: string;
  createdAt: string;
  reversedAt?: string;
};

export type SellInput = {
  qty: number;
  price: number;
  costAtSell: number;
  fees: number;
  tradedAt: string;
  note: string;
};

export type BuyRecord = {
  id: string;
  type: 'buy';
  status: 'active' | 'reversed';
  broker: Broker;
  account: string;
  market: Holding['market'];
  holdingType: Holding['type'];
  name: string;
  symbol: string;
  currency: Holding['currency'];
  qty: number;
  price: number;
  fees: number;
  totalCost: number;
  beforeQty: number;
  afterQty: number;
  beforeCost: number;
  afterCost: number;
  positionPriceAtBuy: number;
  tradedAt: string;
  note: string;
  createdAt: string;
  reversedAt?: string;
  reversalEffect?: 'position-adjusted' | 'history-only';
};

export type BuyInput = {
  broker: Broker;
  account: string;
  market: Holding['market'];
  holdingType: Holding['type'];
  name: string;
  symbol: string;
  currency: Holding['currency'];
  qty: number;
  price: number;
  fees: number;
  currentPrice: number;
  tradedAt: string;
  note: string;
};

export type SnapshotDraftHolding = Omit<Holding, 'todayPnl' | 'totalPnl'> & {
  sourceImage?: string;
  warnings?: string[];
};

export type SnapshotDraftAccount = AccountSnapshot & {
  sourceImage?: string;
  warnings?: string[];
};

export type SnapshotDraft = {
  source: 'ai-ocr' | 'manual';
  model?: string;
  summary: string;
  holdings: SnapshotDraftHolding[];
  accountSnapshots: SnapshotDraftAccount[];
  warnings: string[];
};

export type SavedSnapshot = {
  revision: number;
  source: 'ocr' | 'manual' | 'default';
  savedAt: string;
  positionsUpdatedAt: string;
  accountPositionsUpdatedAt: Record<string, string>;
  originalFileNames: string[];
  warnings: string[];
  holdings: Holding[];
  accountSnapshots: AccountSnapshot[];
  buyRecords: BuyRecord[];
  sellRecords: SellRecord[];
  importLogs: ImportAuditRecord[];
};

export type ImportAuditRecord = {
  id: string;
  source: 'ocr' | 'manual';
  savedAt: string;
  summary: string;
  holdingCount: number;
  accountCount: number;
  accounts: string[];
  warningCount: number;
};

export type AccountSnapshot = {
  broker: string;
  account: string;
  market: Market;
  currency: HoldingCurrency;
  netAsset: number;
};

export type AggregatedHolding = Holding & {
  rows: Holding[];
  marketValue: number;
};

export type RiskAlert = {
  level: '高' | '中' | '低';
  title: string;
  text: string;
  icon: React.ElementType;
};

export type RiskAnalysisStatus = 'idle' | 'loading' | 'ai' | 'fallback' | 'error';

export type RiskAnalysisResult = {
  source: 'ai' | 'fallback';
  model: string;
  summary: string;
  alerts: Array<Pick<RiskAlert, 'level' | 'title' | 'text'>>;
};

export type HoldingNewsItem = {
  id: string;
  symbol: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  matchedBy: string[];
  analysis?: {
    summary: string;
    stance: '利好' | '利空' | '中性';
    impact: '低影响' | '中影响' | '高影响';
  };
};

export type HoldingNewsStatus = 'idle' | 'loading' | 'live' | 'fallback' | 'error';

export type HoldingNewsResult = {
  source: 'ticker' | 'investing' | 'tencent' | 'mixed' | 'fallback';
  fetchedAt: string;
  summary: string;
  items: HoldingNewsItem[];
  sources?: string[];
};

export type AskAnalysisResult = {
  source: 'ai' | 'fallback';
  model: string;
  answer: string;
};

export type PortfolioSummary = {
  gross: number;
  cost: number;
  cash: number;
  total: number;
  totalPnl: number;
  todayPnl: number;
  realizedPnl: number;
  todayRealizedPnl: number;
  todayReturn: number;
  totalReturn: number;
  buyFees: number;
  sellFees: number;
  cashComplete: boolean;
  missingNetAssetAccounts: number;
};

export type QuoteStatus = 'idle' | 'refreshing' | 'live' | 'fallback' | 'error';
