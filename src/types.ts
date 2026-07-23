import type React from 'react';

export type Currency = 'HKD' | 'USD' | 'CNY';
export type Tab = 'overview' | 'holdings' | 'trends' | 'ask' | 'import';
export type Broker = '盈立证券' | '致富证券' | '星财富' | 'Schwab' | 'US Bancorp Advisors';

export type AiProvider = 'openai' | 'anthropic';

export type AiApiConfig = {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type Holding = {
  broker: Broker;
  account: string;
  market: 'US' | 'HK';
  type: '个股' | 'ETF' | '杠杆ETF';
  name: string;
  symbol: string;
  currency: 'USD' | 'HKD';
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
  source: 'ocr' | 'default';
  savedAt: string;
  positionsUpdatedAt: string;
  accountPositionsUpdatedAt: Record<string, string>;
  originalFileNames: string[];
  warnings: string[];
  holdings: Holding[];
  accountSnapshots: AccountSnapshot[];
  sellRecords: SellRecord[];
};

export type AccountSnapshot = {
  broker: string;
  account: string;
  market: 'US' | 'HK';
  currency: 'USD' | 'HKD';
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
  source: 'investing' | 'fallback';
  fetchedAt: string;
  summary: string;
  items: HoldingNewsItem[];
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
  totalReturn: number;
  sellFees: number;
};

export type QuoteStatus = 'idle' | 'refreshing' | 'live' | 'fallback' | 'error';
