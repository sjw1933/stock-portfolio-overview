import http from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchExtendedQuotes } from './extended-quotes.mjs';

const port = Number(process.env.PORT || process.env.RISK_API_PORT || 8791);
const provider = process.env.RISK_LLM_PROVIDER || 'openai';
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const openaiBaseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const openaiModel = process.env.RISK_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropicBaseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')
  .replace(/\/$/, '')
  .replace(/\/v1$/i, '');
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const requestTimeoutMs = Number(process.env.RISK_LLM_TIMEOUT_MS || 45000);
const ocrTimeoutMs = Number(process.env.OCR_LLM_TIMEOUT_MS || 90000);
const snapshotFile = process.env.SNAPSHOT_FILE || '/app/data/snapshot.json';
const fearGreedCacheFile = process.env.FEAR_GREED_CACHE_FILE || `${dirname(snapshotFile)}/fear-greed-cache.json`;
const fearGreedCacheTtlMs = Number(process.env.FEAR_GREED_CACHE_TTL_MS || 15 * 60 * 1000);
const fearGreedUrl = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const supportedBrokers = ['盈立证券', '致富证券', '星财富', 'Schwab', 'US Bancorp Advisors'];
const supportedBrokerText = supportedBrokers.join('、');
const supportedBrokerJsonText = supportedBrokers.join('|');

function normalizeAiConfig(payload) {
  const raw = payload?.aiConfig && typeof payload.aiConfig === 'object' ? payload.aiConfig : null;
  if (!raw) return null;
  const apiKey = String(raw.apiKey || '').trim();
  if (!apiKey) return null;
  const provider = raw.provider === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = String(raw.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'))
    .trim()
    .replace(/\/$/, '')
    .replace(provider === 'anthropic' ? /\/v1$/i : /\/$/, '');
  const model = String(raw.model || (provider === 'anthropic' ? anthropicModel : openaiModel)).trim();
  return { provider, apiKey, baseUrl, model };
}

function activeProvider(config) {
  return config?.provider || provider;
}

function activeOpenAi(config) {
  return {
    apiKey: config?.provider === 'openai' ? config.apiKey : openaiApiKey,
    baseUrl: config?.provider === 'openai' ? config.baseUrl.replace(/\/$/, '') : openaiBaseUrl,
    model: config?.provider === 'openai' ? config.model : openaiModel,
  };
}

function activeAnthropic(config) {
  return {
    apiKey: config?.provider === 'anthropic' ? config.apiKey : anthropicApiKey,
    baseUrl: (config?.provider === 'anthropic' ? config.baseUrl : anthropicBaseUrl).replace(/\/$/, '').replace(/\/v1$/i, ''),
    model: config?.provider === 'anthropic' ? config.model : anthropicModel,
  };
}

const nasdaqSymbols = {
  'AAPL.US': { symbol: 'AAPL', assetClass: 'stocks' },
  'QQQ.US': { symbol: 'QQQ', assetClass: 'etf' },
  'VOO.US': { symbol: 'VOO', assetClass: 'etf' },
};

// Investing.com has no public API (official support). Public HTML/API is Cloudflare-blocked (403).
// What works without login: RSS on www/cn. Optional Pro session cookie enables pair-level news.
const investingSessionCookie = String(process.env.INVESTING_SESSION_COOKIE || '').trim();
const investingNewsFeeds = [
  // English site
  'https://www.investing.com/rss/news.rss',
  'https://www.investing.com/rss/news_25.rss',
  'https://www.investing.com/rss/news_14.rss',
  'https://www.investing.com/rss/stock.rss',
  'https://www.investing.com/rss/news_301.rss',
  'https://www.investing.com/rss/market_overview.rss',
  'https://www.investing.com/rss/news_285.rss',
  // Chinese site
  'https://cn.investing.com/rss/news_25.rss',
  'https://cn.investing.com/rss/market_overview.rss',
  'https://cn.investing.com/rss/news_301.rss',
  'https://cn.investing.com/rss/stock.rss',
  'https://cn.investing.com/rss/news_14.rss',
];

/** Local symbol -> Investing pair metadata for instrument news (when session cookie is set). */
const investingPairMap = {
  'AAPL.US': { pairId: 6408, slug: 'apple-computer-inc', title: 'Apple' },
  'QQQ.US': { pairId: 15114, slug: 'powershares-qqqq', title: 'Invesco QQQ' },
  'VOO.US': { pairId: 38272, slug: 'vanguard-s-p-500-etf', title: 'Vanguard S&P 500' },
  'SPY.US': { pairId: 525, slug: 'spdr-s-p-500', title: 'SPDR S&P 500' },
  'SMCI.US': { pairId: 20324, slug: 'super-micro-computer', title: 'Super Micro' },
  'RBLX.US': { pairId: 1176950, slug: 'roblox', title: 'Roblox' },
  'LAES.US': { pairId: 1202474, slug: 'sealsq', title: 'SEALSQ' },
  'TSLA.US': { pairId: 13994, slug: 'tesla-motors', title: 'Tesla' },
  'NVDA.US': { pairId: 6497, slug: 'nvidia-corp', title: 'NVIDIA' },
  'MSFT.US': { pairId: 10124, slug: 'microsoft-corp', title: 'Microsoft' },
  'AMZN.US': { pairId: 6435, slug: 'amazon-com-inc', title: 'Amazon' },
  'META.US': { pairId: 26490, slug: 'facebook-inc', title: 'Meta' },
  'GOOGL.US': { pairId: 6369, slug: 'google-inc', title: 'Alphabet' },
};

// Weighted aliases only — avoid broad market terms like 美股 / 科技股 / Wall St.
// weight: 10 = ticker-class, 8 = company name, 5 = product/brand, 3 = weak alias (needs extra support).
const symbolKeywordMap = {
  'AAPL.US': [
    { keyword: 'AAPL', weight: 10 },
    { keyword: 'Apple', weight: 8 },
    { keyword: '苹果公司', weight: 8 },
    { keyword: '苹果', weight: 8 },
    { keyword: 'iPhone', weight: 5 },
    { keyword: 'iPad', weight: 5 },
    { keyword: 'MacBook', weight: 5 },
    { keyword: 'Cook', weight: 3 },
    { keyword: '库克', weight: 3 },
  ],
  'QQQ.US': [
    { keyword: 'QQQ', weight: 10 },
    { keyword: 'Invesco QQQ', weight: 10 },
    { keyword: 'Nasdaq-100', weight: 8 },
    { keyword: 'Nasdaq 100', weight: 8 },
    { keyword: '纳斯达克100', weight: 8 },
    { keyword: '纳指100', weight: 8 },
    { keyword: '纳指ETF', weight: 8 },
  ],
  'VOO.US': [
    { keyword: 'VOO', weight: 10 },
    { keyword: 'Vanguard S&P', weight: 8 },
    { keyword: 'S&P 500', weight: 8 },
    { keyword: 'S&P500', weight: 8 },
    { keyword: '标普500', weight: 8 },
    { keyword: '标普 500', weight: 8 },
  ],
  'SPY.US': [
    { keyword: 'SPY', weight: 10 },
    { keyword: 'SPDR S&P', weight: 8 },
    { keyword: 'S&P 500', weight: 5 },
    { keyword: '标普500', weight: 5 },
  ],
  'SMCI.US': [
    { keyword: 'SMCI', weight: 10 },
    { keyword: 'Super Micro', weight: 10 },
    { keyword: 'Supermicro', weight: 10 },
    { keyword: 'Super Micro Computer', weight: 10 },
    { keyword: '超微电脑', weight: 10 },
    { keyword: '超微', weight: 8 },
  ],
  'LAES.US': [
    { keyword: 'LAES', weight: 10 },
    { keyword: 'SEALSQ', weight: 10 },
    { keyword: 'SealSQ', weight: 10 },
  ],
  'RBLX.US': [
    { keyword: 'RBLX', weight: 10 },
    { keyword: 'Roblox', weight: 10 },
    { keyword: '罗布乐思', weight: 10 },
  ],
  'SPCX.US': [
    { keyword: 'SPCX', weight: 10 },
    { keyword: 'SpaceX', weight: 8 },
    { keyword: '太空探索技术', weight: 8 },
  ],
};

/** Minimum weighted score to attach a story to a holding (blocks loose theme matches). */
const newsMinMatchScore = 8;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

async function readSharedSnapshot() {
  try {
    const text = await readFile(snapshotFile, 'utf8');
    const snapshot = JSON.parse(text);
    return normalizeSharedSnapshot(snapshot);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

let snapshotWriteQueue = Promise.resolve();

function queueSharedSnapshotWrite(snapshot, expectedRevision) {
  const operation = snapshotWriteQueue.then(() => writeSharedSnapshot(snapshot, expectedRevision));
  snapshotWriteQueue = operation.catch(() => undefined);
  return operation;
}

async function writeSharedSnapshot(snapshot, expectedRevision) {
  const current = await readSharedSnapshot();
  const currentRevision = current?.revision ?? 0;
  if (current && expectedRevision === undefined) {
    const error = new Error('页面版本过旧，请刷新页面后再修改持仓');
    error.statusCode = 409;
    throw error;
  }
  if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
    const error = new Error('共享持仓已在其他设备更新，请刷新后重试');
    error.statusCode = 409;
    throw error;
  }
  const normalized = normalizeSharedSnapshot({ ...snapshot, revision: currentRevision + 1 });
  await mkdir(dirname(snapshotFile), { recursive: true });
  const tempFile = `${snapshotFile}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await rename(tempFile, snapshotFile);
  return normalized;
}

async function deleteSharedSnapshot() {
  await rm(snapshotFile, { force: true });
}

function normalizeSharedSnapshot(snapshot) {
  const holdings = Array.isArray(snapshot?.holdings) ? snapshot.holdings.map(normalizeSharedHolding).filter(Boolean) : [];
  const accountSnapshots = Array.isArray(snapshot?.accountSnapshots) ? snapshot.accountSnapshots.map(normalizeSharedAccount).filter(Boolean) : [];
  const buyRecords = Array.isArray(snapshot?.buyRecords) ? snapshot.buyRecords.map(normalizeBuyRecord).filter(Boolean) : [];
  const sellRecords = Array.isArray(snapshot?.sellRecords) ? snapshot.sellRecords.map(normalizeSellRecord).filter(Boolean) : [];
  const importLogs = Array.isArray(snapshot?.importLogs) ? snapshot.importLogs.map(normalizeImportLog).filter(Boolean).slice(0, 80) : [];
  if (!holdings.length && !accountSnapshots.length && !buyRecords.length && !sellRecords.length) throw new Error('snapshot is empty');
  const savedAt = normalizeIsoDateTime(snapshot?.savedAt) || new Date().toISOString();
  const positionsUpdatedAt = normalizeIsoDateTime(snapshot?.positionsUpdatedAt) || savedAt;
  const accountPositionsUpdatedAt = normalizeAccountPositionTimes(snapshot?.accountPositionsUpdatedAt);
  for (const item of [...holdings, ...accountSnapshots]) {
    const key = accountPositionKey(item);
    if (!accountPositionsUpdatedAt[key]) accountPositionsUpdatedAt[key] = positionsUpdatedAt;
  }
  return {
    revision: Math.max(0, Math.floor(Number(snapshot?.revision) || 0)),
    source: snapshot?.source === 'default' ? 'default' : snapshot?.source === 'manual' ? 'manual' : 'ocr',
    savedAt,
    positionsUpdatedAt,
    accountPositionsUpdatedAt,
    originalFileNames: Array.isArray(snapshot?.originalFileNames) ? snapshot.originalFileNames.map((item) => String(item).slice(0, 160)) : [],
    warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings.map((item) => String(item).slice(0, 240)) : [],
    holdings,
    accountSnapshots,
    buyRecords,
    sellRecords,
    importLogs,
  };
}

function normalizeSharedHolding(item) {
  const symbol = String(item?.symbol || '').trim().toUpperCase();
  const qty = Number(item?.qty);
  const price = Number(item?.price);
  const cost = Number(item?.cost);
  if (!symbol || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(cost) || cost <= 0) return null;
  return {
    broker: sanitizeEnum(item?.broker, supportedBrokers, '盈立证券'),
    account: String(item?.account || '未命名账户').trim().slice(0, 80),
    market: sanitizeEnum(item?.market, ['US', 'HK', 'CN'], symbol.endsWith('.HK') ? 'HK' : (/\.(SH|SS|SZ)$/.test(symbol) ? 'CN' : 'US')),
    type: sanitizeEnum(item?.type, ['个股', 'ETF', '杠杆ETF'], '个股'),
    name: String(item?.name || symbol).trim().slice(0, 80),
    symbol,
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD', 'CNY'], symbol.endsWith('.US') ? 'USD' : (symbol.endsWith('.HK') ? 'HKD' : (/\.(SH|SS|SZ)$/.test(symbol) ? 'CNY' : 'HKD'))),
    qty,
    price,
    cost,
    todayPnl: Number.isFinite(Number(item?.todayPnl)) ? Number(item.todayPnl) : 0,
    totalPnl: Number.isFinite(Number(item?.totalPnl)) ? Number(item.totalPnl) : (price - cost) * qty,
  };
}

function normalizeSharedAccount(item) {
  const account = String(item?.account || '').trim();
  const netAsset = Number(item?.netAsset);
  if (!account || !Number.isFinite(netAsset) || netAsset < 0) return null;
  return {
    broker: String(item?.broker || '盈立证券').trim().slice(0, 40),
    account: account.slice(0, 80),
    market: sanitizeEnum(item?.market, ['US', 'HK', 'CN'], 'US'),
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD', 'CNY'], 'HKD'),
    netAsset,
  };
}

function normalizeSellRecord(item) {
  const symbol = String(item?.symbol || '').trim().toUpperCase();
  const qty = Number(item?.qty);
  const price = Number(item?.price);
  const costAtSell = Number(item?.costAtSell);
  const holdingCost = Number(item?.holdingCost ?? costAtSell);
  const positionPriceAtSell = Number(item?.positionPriceAtSell ?? price);
  const fees = Number(item?.fees ?? 0);
  const todayRealizedPnl = Number(item?.todayRealizedPnl ?? 0);
  const beforeQty = Number(item?.beforeQty);
  const afterQty = Number(item?.afterQty);
  const tradedAt = normalizeIsoDateTime(item?.tradedAt);
  const createdAt = normalizeIsoDateTime(item?.createdAt);
  if (!symbol || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(costAtSell) || costAtSell <= 0) return null;
  if (!Number.isFinite(holdingCost) || holdingCost <= 0 || !Number.isFinite(positionPriceAtSell) || positionPriceAtSell <= 0) return null;
  if (!Number.isFinite(fees) || fees < 0 || !Number.isFinite(todayRealizedPnl) || !tradedAt || !createdAt) return null;
  return {
    id: String(item?.id || `${symbol}-${createdAt}`).slice(0, 100),
    type: 'sell',
    status: item?.status === 'reversed' ? 'reversed' : 'active',
    broker: sanitizeEnum(item?.broker, supportedBrokers, '盈立证券'),
    account: String(item?.account || '未命名账户').trim().slice(0, 80),
    market: sanitizeEnum(item?.market, ['US', 'HK', 'CN'], symbol.endsWith('.HK') ? 'HK' : (/\.(SH|SS|SZ)$/.test(symbol) ? 'CN' : 'US')),
    holdingType: sanitizeEnum(item?.holdingType, ['个股', 'ETF', '杠杆ETF'], '个股'),
    name: String(item?.name || symbol).trim().slice(0, 80),
    symbol,
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD', 'CNY'], symbol.endsWith('.US') ? 'USD' : (symbol.endsWith('.HK') ? 'HKD' : (/\.(SH|SS|SZ)$/.test(symbol) ? 'CNY' : 'HKD'))),
    qty,
    price,
    costAtSell,
    holdingCost,
    positionPriceAtSell,
    fees,
    realizedPnl: (price - costAtSell) * qty - fees,
    todayRealizedPnl,
    beforeQty: Number.isFinite(beforeQty) && beforeQty >= qty ? beforeQty : qty,
    afterQty: Number.isFinite(afterQty) && afterQty >= 0 ? afterQty : 0,
    tradedAt,
    note: String(item?.note || '').trim().slice(0, 240),
    createdAt,
    ...(item?.status === 'reversed' && normalizeIsoDateTime(item?.reversedAt) ? { reversedAt: normalizeIsoDateTime(item.reversedAt) } : {}),
  };
}

function normalizeBuyRecord(item) {
  const symbol = String(item?.symbol || '').trim().toUpperCase();
  const qty = Number(item?.qty);
  const price = Number(item?.price);
  const fees = Number(item?.fees ?? 0);
  const totalCost = Number(item?.totalCost ?? (price * qty + fees));
  const beforeQty = Number(item?.beforeQty ?? 0);
  const afterQty = Number(item?.afterQty);
  const beforeCost = Number(item?.beforeCost ?? 0);
  const afterCost = Number(item?.afterCost);
  const positionPriceAtBuy = Number(item?.positionPriceAtBuy ?? price);
  const tradedAt = normalizeIsoDateTime(item?.tradedAt);
  const createdAt = normalizeIsoDateTime(item?.createdAt);
  if (!symbol || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(fees) || fees < 0 || !Number.isFinite(totalCost) || totalCost <= 0) return null;
  if (!Number.isFinite(beforeQty) || beforeQty < 0 || !Number.isFinite(afterQty) || afterQty < qty) return null;
  if (!Number.isFinite(beforeCost) || beforeCost < 0 || !Number.isFinite(afterCost) || afterCost <= 0) return null;
  if (!Number.isFinite(positionPriceAtBuy) || positionPriceAtBuy <= 0 || !tradedAt || !createdAt) return null;
  const reversedAt = item?.status === 'reversed' ? normalizeIsoDateTime(item?.reversedAt) : '';
  return {
    id: String(item?.id || `${symbol}-${createdAt}`).slice(0, 100),
    type: 'buy',
    status: item?.status === 'reversed' ? 'reversed' : 'active',
    broker: sanitizeEnum(item?.broker, supportedBrokers, '盈立证券'),
    account: String(item?.account || '未命名账户').trim().slice(0, 80),
    market: sanitizeEnum(item?.market, ['US', 'HK', 'CN'], symbol.endsWith('.HK') ? 'HK' : (/\.(SH|SS|SZ)$/.test(symbol) ? 'CN' : 'US')),
    holdingType: sanitizeEnum(item?.holdingType, ['个股', 'ETF', '杠杆ETF'], '个股'),
    name: String(item?.name || symbol).trim().slice(0, 80),
    symbol,
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD', 'CNY'], symbol.endsWith('.US') ? 'USD' : (symbol.endsWith('.HK') ? 'HKD' : (/\.(SH|SS|SZ)$/.test(symbol) ? 'CNY' : 'HKD'))),
    qty,
    price,
    fees,
    totalCost,
    beforeQty,
    afterQty,
    beforeCost,
    afterCost,
    positionPriceAtBuy,
    tradedAt,
    note: String(item?.note || '').trim().slice(0, 240),
    createdAt,
    ...(reversedAt ? { reversedAt } : {}),
    ...(item?.status === 'reversed' ? {
      reversalEffect: item?.reversalEffect === 'position-adjusted' ? 'position-adjusted' : 'history-only',
    } : {}),
  };
}

function normalizeImportLog(item) {
  const savedAt = normalizeIsoDateTime(item?.savedAt);
  if (!savedAt) return null;
  return {
    id: String(item?.id || `import-${savedAt}`).slice(0, 100),
    source: item?.source === 'manual' ? 'manual' : 'ocr',
    savedAt,
    summary: String(item?.summary || '').trim().slice(0, 160),
    holdingCount: Math.max(0, Math.floor(Number(item?.holdingCount) || 0)),
    accountCount: Math.max(0, Math.floor(Number(item?.accountCount) || 0)),
    accounts: Array.isArray(item?.accounts) ? item.accounts.map((account) => String(account).trim().slice(0, 120)).filter(Boolean).slice(0, 20) : [],
    warningCount: Math.max(0, Math.floor(Number(item?.warningCount) || 0)),
  };
}

function normalizeIsoDateTime(value) {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeAccountPositionTimes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 200).flatMap(([key, date]) => {
    const normalizedDate = normalizeIsoDateTime(date);
    return normalizedDate ? [[String(key).slice(0, 240), normalizedDate]] : [];
  }));
}

function accountPositionKey(item) {
  return `${item.broker}::${item.account}::${item.market}`;
}

function sanitizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function formatIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function readMarketHistoryQuery(req) {
  const url = new URL(req.url, 'http://localhost');
  const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
  const period = String(url.searchParams.get('period') || 'day');
  return { symbol, period };
}

function readExtendedQuoteQuery(req) {
  const url = new URL(req.url, 'http://localhost');
  const etfs = new Set(String(url.searchParams.get('etfs') || '').split(',').map((item) => item.trim().toUpperCase()));
  const sessionParam = String(url.searchParams.get('session') || 'auto').toLowerCase();
  const session = ['pre', 'regular', 'post', 'auto', 'all'].includes(sessionParam) ? sessionParam : 'auto';
  const entries = String(url.searchParams.get('symbols') || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}\.US$/.test(symbol))
    .slice(0, 30)
    .map((symbol) => ({
      symbol,
      assetClass: etfs.has(symbol) ? 'etf' : guessUsAssetClass(symbol.replace(/\.US$/, '')),
    }));
  return { entries, session };
}

let fearGreedMemoryCache = null;
let fearGreedRefreshPromise = null;

async function getFearGreed(forceRefresh = false) {
  const cached = await readFearGreedCache();
  const cacheAge = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Number.POSITIVE_INFINITY;
  if (!forceRefresh && cached && cacheAge < fearGreedCacheTtlMs) {
    return { ...cached, cacheStatus: 'live' };
  }

  try {
    const fresh = await refreshFearGreed();
    return { ...fresh, cacheStatus: 'live' };
  } catch (error) {
    if (cached) return { ...cached, cacheStatus: 'cached' };
    throw error;
  }
}

async function refreshFearGreed() {
  if (fearGreedRefreshPromise) return fearGreedRefreshPromise;
  fearGreedRefreshPromise = fetchFearGreedFromCnn()
    .then(async (data) => {
      fearGreedMemoryCache = data;
      await writeFearGreedCache(data);
      return data;
    })
    .finally(() => {
      fearGreedRefreshPromise = null;
    });
  return fearGreedRefreshPromise;
}

async function fetchFearGreedFromCnn() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(fearGreedUrl, {
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://www.cnn.com',
        referer: 'https://www.cnn.com/markets/fear-and-greed',
        'sec-fetch-site': 'same-site',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) throw new Error(`CNN Fear & Greed HTTP ${response.status}`);
    return normalizeFearGreedResponse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFearGreedResponse(payload) {
  const current = payload?.fear_and_greed;
  const timestamp = normalizeIsoDateTime(current?.timestamp);
  if (!timestamp) throw new Error('CNN Fear & Greed timestamp is invalid');
  return {
    score: normalizeFearGreedScore(current?.score),
    rating: normalizeFearGreedRating(current?.rating),
    timestamp,
    previousClose: normalizeFearGreedScore(current?.previous_close),
    previousWeek: normalizeFearGreedScore(current?.previous_1_week),
    previousMonth: normalizeFearGreedScore(current?.previous_1_month),
    previousYear: normalizeFearGreedScore(current?.previous_1_year),
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeFearGreedCache(payload) {
  const timestamp = normalizeIsoDateTime(payload?.timestamp);
  const fetchedAt = normalizeIsoDateTime(payload?.fetchedAt);
  if (!timestamp || !fetchedAt) throw new Error('Fear & Greed cache timestamp is invalid');
  return {
    score: normalizeFearGreedScore(payload?.score),
    rating: normalizeFearGreedRating(payload?.rating),
    timestamp,
    previousClose: normalizeFearGreedScore(payload?.previousClose),
    previousWeek: normalizeFearGreedScore(payload?.previousWeek),
    previousMonth: normalizeFearGreedScore(payload?.previousMonth),
    previousYear: normalizeFearGreedScore(payload?.previousYear),
    fetchedAt,
  };
}

function normalizeFearGreedScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) throw new Error('CNN Fear & Greed score is invalid');
  return Math.min(100, Math.max(0, score));
}

function normalizeFearGreedRating(value) {
  const rating = String(value || '').trim().toLowerCase();
  if (['extreme fear', 'fear', 'neutral', 'greed', 'extreme greed'].includes(rating)) return rating;
  throw new Error('CNN Fear & Greed rating is invalid');
}

async function readFearGreedCache() {
  if (fearGreedMemoryCache) return fearGreedMemoryCache;
  try {
    const cached = normalizeFearGreedCache(JSON.parse(await readFile(fearGreedCacheFile, 'utf8')));
    fearGreedMemoryCache = cached;
    return cached;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    console.warn(`Fear & Greed cache ignored: ${error instanceof Error ? error.message : 'invalid cache'}`);
    return null;
  }
}

async function writeFearGreedCache(data) {
  await mkdir(dirname(fearGreedCacheFile), { recursive: true });
  const tempFile = `${fearGreedCacheFile}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tempFile, fearGreedCacheFile);
}

function investingRequestHeaders(extra = {}) {
  const headers = {
    accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, application/json;q=0.8, */*;q=0.5',
    'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    referer: 'https://www.investing.com/',
    origin: 'https://www.investing.com',
    ...extra,
  };
  if (investingSessionCookie) headers.cookie = investingSessionCookie;
  return headers;
}

async function fetchText(url, signal, headers) {
  const response = await fetch(url, {
    signal,
    headers: headers || {
      accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
      'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`news feed HTTP ${response.status}`);
  return response.text();
}

function parseInvestingHtmlNews(html, holding, pairMeta) {
  const items = [];
  const seen = new Set();
  // Article cards / list anchors on instrument news pages.
  const patterns = [
    /<a[^>]+href="(https?:\/\/(?:www|cn)\.investing\.com\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(html);
    while (match) {
      const href = match[1].startsWith('http') ? match[1] : `https://www.investing.com${match[1]}`;
      const title = decodeXml(String(match[2] || '').replace(/<[^>]+>/g, ' ')).trim();
      if (
        title.length >= 12
        && !seen.has(href)
        && !/pro\/pricing|sign-up|login|register/i.test(href)
      ) {
        seen.add(href);
        items.push({
          title: title.slice(0, 180),
          url: href,
          source: 'Investing.com',
          description: '',
          publishedAt: new Date().toISOString(),
          feed: 'investing-pair',
          boundHolding: holding,
          pairId: pairMeta?.pairId,
        });
      }
      if (items.length >= 8) break;
      match = pattern.exec(html);
    }
    if (items.length >= 8) break;
  }
  return items;
}

function parseInvestingJsonNews(payload, holding) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.news)
        ? payload.news
        : Array.isArray(payload?.data?.news)
          ? payload.data.news
          : [];
  return rows.slice(0, 8).flatMap((row) => {
    const title = String(row?.title || row?.headline || row?.name || '').trim();
    const path = String(row?.link || row?.url || row?.news_link || row?.href || '').trim();
    if (!title || !path) return [];
    const url = path.startsWith('http') ? path : `https://www.investing.com${path.startsWith('/') ? '' : '/'}${path}`;
    const publishedAt = normalizeNewsDate(row?.date || row?.published || row?.created || row?.timestamp);
    return [{
      title: title.slice(0, 180),
      url,
      source: 'Investing.com',
      description: String(row?.body || row?.summary || '').slice(0, 400),
      publishedAt,
      feed: 'investing-pair',
      boundHolding: holding,
    }];
  });
}

async function fetchInvestingPairNewsForHolding(holding, signal) {
  const pairMeta = investingPairMap[holding.symbol];
  if (!pairMeta || !investingSessionCookie) return [];

  const attempts = [
    async () => {
      // Common internal endpoint used by instrument news tabs.
      const url = `https://www.investing.com/equities/Service/MoreNews`;
      const body = new URLSearchParams({
        pairID: String(pairMeta.pairId),
        page: '1',
      });
      const response = await fetch(url, {
        method: 'POST',
        signal,
        headers: investingRequestHeaders({
          'content-type': 'application/x-www-form-urlencoded',
          'x-requested-with': 'XMLHttpRequest',
        }),
        body,
      });
      if (!response.ok) throw new Error(`MoreNews HTTP ${response.status}`);
      const text = await response.text();
      try {
        return parseInvestingJsonNews(JSON.parse(text), holding);
      } catch {
        return parseInvestingHtmlNews(text, holding, pairMeta);
      }
    },
    async () => {
      const url = `https://api.investing.com/api/news/v2/get-news-by-pair?pair-ID=${pairMeta.pairId}&page=0&rows=10`;
      const response = await fetch(url, {
        signal,
        headers: investingRequestHeaders({ accept: 'application/json' }),
      });
      if (!response.ok) throw new Error(`pair-news HTTP ${response.status}`);
      return parseInvestingJsonNews(await response.json(), holding);
    },
    async () => {
      const url = `https://www.investing.com/equities/${pairMeta.slug}-news`;
      const html = await fetchText(url, signal, investingRequestHeaders());
      return parseInvestingHtmlNews(html, holding, pairMeta);
    },
  ];

  for (const attempt of attempts) {
    try {
      const items = await attempt();
      if (items.length) return items;
    } catch {
      // Try next strategy.
    }
  }
  return [];
}

async function fetchInvestingBoundNews(holdings, signal) {
  if (!investingSessionCookie) return [];
  const targets = holdings.filter((holding) => investingPairMap[holding.symbol]).slice(0, 10);
  const bound = [];
  for (let index = 0; index < targets.length; index += 2) {
    if (signal?.aborted) break;
    const chunk = targets.slice(index, index + 2);
    const results = await Promise.allSettled(chunk.map((holding) => fetchInvestingPairNewsForHolding(holding, signal)));
    for (const result of results) {
      if (result.status === 'fulfilled') bound.push(...result.value);
    }
  }
  return bound;
}

function attachInvestingPairItem(item) {
  const holding = item.boundHolding;
  if (!holding?.symbol) return null;
  const base = yahooNewsTicker(holding.symbol) || holding.symbol.replace(/\.(US|HK)$/i, '');
  return {
    title: item.title,
    url: item.url,
    source: item.source || 'Investing.com',
    publishedAt: item.publishedAt,
    description: item.description || '',
    symbol: holding.symbol,
    matchedBy: [base, 'investing-pair', holding.symbol],
    score: 18,
    feed: 'investing-pair',
  };
}

function decodeXml(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return decodeXml(match?.[1] || '');
}

function parseRssItems(xml, defaults = {}) {
  return Array.from(String(xml || '').matchAll(/<item[\s\S]*?<\/item>/gi)).map((match) => {
    const block = match[0];
    const title = extractTag(block, 'title');
    const url = extractTag(block, 'link');
    const source = extractTag(block, 'source')
      || extractTag(block, 'author')
      || extractTag(block, 'dc:creator')
      || defaults.source
      || 'RSS';
    const description = extractTag(block, 'description');
    return {
      title,
      url,
      source: String(source).slice(0, 40),
      description: description.slice(0, 400),
      publishedAt: normalizeNewsDate(extractTag(block, 'pubDate')),
      feed: defaults.feed || 'rss',
    };
  }).filter((item) => item.title && item.url);
}

/** Map local symbols (AAPL.US / 00700.HK) to Yahoo Finance RSS tickers. */
function yahooNewsTicker(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.endsWith('.US')) return normalized.replace(/\.US$/, '');
  if (normalized.endsWith('.HK')) {
    const digits = normalized.replace(/\.HK$/, '').replace(/\D/g, '');
    if (!digits) return '';
    return `${digits.padStart(4, '0')}.HK`;
  }
  if (/\.(SH|SS|SZ)$/.test(normalized)) return normalized.replace(/\.(SH|SS|SZ)$/, '');
  return normalized.replace(/\.(US|HK|SH|SS|SZ)$/, '');
}

/** Map local symbol to Tencent finance code: usAAPL / hk00700 / sh601208 / sz000001 */
function tencentNewsSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.endsWith('.US')) return `us${normalized.replace(/\.US$/, '')}`;
  if (normalized.endsWith('.HK')) {
    const digits = normalized.replace(/\.HK$/, '').replace(/\D/g, '');
    if (!digits) return '';
    return `hk${digits.padStart(5, '0')}`;
  }
  if (normalized.endsWith('.SH') || normalized.endsWith('.SS')) {
    return `sh${normalized.replace(/\.(SH|SS)$/, '')}`;
  }
  if (normalized.endsWith('.SZ')) return `sz${normalized.replace(/\.SZ$/, '')}`;
  return '';
}

function googleNewsQuery(holding) {
  const base = String(holding.symbol || '').replace(/\.(US|HK|SH|SS|SZ)$/i, '');
  const name = cleanHoldingName(holding.name);
  const parts = [base];
  if (name && name.toLowerCase() !== base.toLowerCase()) parts.push(`"${name}"`);
  // Prefer recent company/ticker stories over broad market noise.
  return `${parts.join(' OR ')} when:14d`;
}

function tickerNewsUrls(holding, enabledSources = { yahoo: true, google: true }) {
  const yahooTicker = yahooNewsTicker(holding.symbol);
  const urls = [];
  if (enabledSources.yahoo && yahooTicker) {
    urls.push({
      feed: 'yahoo-ticker',
      source: 'Yahoo Finance',
      url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooTicker)}&region=US&lang=en-US`,
    });
  }
  const query = googleNewsQuery(holding);
  if (enabledSources.google && query) {
    const isCn = holding.market === 'CN' || /\.(SH|SS|SZ)$/i.test(holding.symbol || '');
    const locale = isCn
      ? { hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans' }
      : { hl: 'en-US', gl: 'US', ceid: 'US:en' };
    urls.push({
      feed: 'google-ticker',
      source: 'Google News',
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${locale.hl}&gl=${locale.gl}&ceid=${encodeURIComponent(locale.ceid)}`,
    });
  }
  return urls;
}

function normalizeNewsSources(raw) {
  const allowed = new Set(['tencent', 'investing', 'yahoo', 'google']);
  const list = Array.isArray(raw) ? raw.map((item) => String(item || '').toLowerCase().trim()) : [];
  const selected = list.filter((item) => allowed.has(item));
  // Default: Tencent + Investing (friendlier for CN networks).
  return selected.length ? Array.from(new Set(selected)) : ['tencent', 'investing'];
}

async function fetchTencentNewsForHolding(holding, signal) {
  const code = tencentNewsSymbol(holding.symbol);
  if (!code) return [];
  const rows = [];
  // type=2 news articles (have urls), type=1 research notes (have urls)
  for (const type of [2, 1]) {
    try {
      const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/news/info/search?symbol=${encodeURIComponent(code)}&page=1&n=6&type=${type}`;
      const response = await fetch(url, {
        signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
          referer: 'https://gu.qq.com/',
        },
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const list = Array.isArray(payload?.data?.data) ? payload.data.data : [];
      for (const row of list) {
        const title = String(row?.title || row?.chineseTitle || '').replace(/\s+/g, ' ').trim();
        const link = String(row?.url || row?.app_detail_link || '').trim();
        if (!title || !link || !/^https?:\/\//i.test(link)) continue;
        rows.push({
          title,
          url: link,
          source: String(row?.src || '腾讯财经').slice(0, 40) || '腾讯财经',
          description: String(row?.summary || row?.typeStr || '').slice(0, 400),
          publishedAt: normalizeNewsDate(row?.time || row?.create_time || row?.update_time),
          feed: 'tencent-ticker',
          boundHolding: holding,
        });
      }
    } catch {
      // Ignore single-type failures; other types / holdings may still work.
    }
  }
  return rows;
}

async function fetchTencentBoundNews(holdings, signal) {
  const targets = holdings.slice(0, 12);
  const bound = [];
  for (let index = 0; index < targets.length; index += 3) {
    if (signal?.aborted) break;
    const chunk = targets.slice(index, index + 3);
    const results = await Promise.allSettled(chunk.map((holding) => fetchTencentNewsForHolding(holding, signal)));
    for (const result of results) {
      if (result.status === 'fulfilled') bound.push(...result.value);
    }
  }
  return bound;
}

function attachTencentFeedItem(item) {
  const holding = item.boundHolding;
  if (!holding?.symbol) return null;
  const base = yahooNewsTicker(holding.symbol) || holding.symbol.replace(/\.(US|HK|SH|SS|SZ)$/i, '');
  return {
    title: item.title,
    url: item.url,
    source: item.source || '腾讯财经',
    publishedAt: item.publishedAt,
    description: item.description || '',
    symbol: holding.symbol,
    matchedBy: [base, 'tencent-ticker', holding.symbol],
    score: 16,
    feed: 'tencent-ticker',
  };
}

function normalizeNewsDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function cleanHoldingName(name) {
  return String(name || '')
    .replace(/ETF.*$/i, '')
    .replace(/[-–—|].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordsForHolding(holding) {
  const symbol = String(holding.symbol || '').toUpperCase();
  const baseSymbol = symbol.replace(/\.(US|HK|SH|SS|SZ)$/i, '');
  const cleanedName = cleanHoldingName(holding.name);
  const mapped = Array.isArray(symbolKeywordMap[symbol]) ? symbolKeywordMap[symbol] : [];

  /** @type {Array<{ keyword: string, weight: number }>} */
  const entries = [
    { keyword: symbol, weight: 10 },
    { keyword: baseSymbol, weight: 10 },
    ...(cleanedName.length >= 2 ? [{ keyword: cleanedName, weight: 8 }] : []),
    ...mapped.map((item) => (
      typeof item === 'string'
        ? { keyword: item, weight: 5 }
        : { keyword: String(item?.keyword || ''), weight: Number(item?.weight) || 5 }
    )),
  ];

  const seen = new Set();
  return entries.filter((entry) => {
    const keyword = String(entry.keyword || '').trim();
    if (keyword.length < 2) return false;
    const key = keyword.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** English tickers use token boundaries; CJK / multi-word phrases use plain includes. */
function haystackMatchesKeyword(haystack, keyword) {
  const needle = String(keyword || '').trim().toLowerCase();
  if (needle.length < 2) return false;
  if (/[\u4e00-\u9fff]/.test(needle) || /\s/.test(needle) || needle.length >= 6) {
    return haystack.includes(needle);
  }
  // Short Latin tokens (tickers): avoid matching inside longer words.
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`, 'i');
  return pattern.test(haystack);
}

function scoreNewsItem(item, holding) {
  const haystack = `${item.title || ''} ${item.description || ''} ${item.url || ''}`.toLowerCase();
  const matchedBy = [];
  let score = 0;
  let strongHits = 0;

  for (const entry of keywordsForHolding(holding)) {
    if (!haystackMatchesKeyword(haystack, entry.keyword)) continue;
    score += entry.weight;
    matchedBy.push(entry.keyword);
    if (entry.weight >= 8) strongHits += 1;
  }

  // Weak-only aliases (products / vague brand hits) must not alone bind a story.
  if (strongHits === 0 && score < newsMinMatchScore) {
    return { score: 0, matchedBy: [] };
  }

  return { score, matchedBy };
}

function normalizeNewsHolding(item) {
  return {
    symbol: String(item?.symbol || '').trim().toUpperCase().slice(0, 24),
    name: String(item?.name || '').slice(0, 40),
    market: String(item?.market || '').slice(0, 8),
    type: String(item?.type || '').slice(0, 16),
  };
}

async function fetchTickerBoundNews(holdings, signal, enabledSources = { yahoo: true, google: true }) {
  // Cap fan-out: each holding may hit Yahoo + Google.
  const targets = holdings.slice(0, 12);
  const jobs = targets.flatMap((holding) => tickerNewsUrls(holding, enabledSources).map((feed) => ({ holding, ...feed })));
  const bound = [];

  for (let index = 0; index < jobs.length; index += 4) {
    if (signal?.aborted) break;
    const chunk = jobs.slice(index, index + 4);
    const results = await Promise.allSettled(
      chunk.map(async (job) => {
        const xml = await fetchText(job.url, signal);
        const items = parseRssItems(xml, { source: job.source, feed: job.feed }).slice(0, 8);
        return items.map((item) => ({ ...item, boundHolding: job.holding, feed: job.feed }));
      }),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') bound.push(...result.value);
    }
  }

  return bound;
}

function attachTickerFeedItem(item) {
  const holding = item.boundHolding;
  if (!holding?.symbol) return null;

  const scored = scoreNewsItem(item, holding);
  const base = yahooNewsTicker(holding.symbol) || holding.symbol.replace(/\.(US|HK|SH|SS|SZ)$/i, '');
  const haystack = `${item.title || ''} ${item.description || ''} ${item.url || ''}`.toLowerCase();
  const tickerHit = haystackMatchesKeyword(haystack, base)
    || haystackMatchesKeyword(haystack, holding.symbol)
    || (cleanHoldingName(holding.name).length >= 2 && haystack.includes(cleanHoldingName(holding.name).toLowerCase()));

  // Yahoo/Google ticker feeds still mix in market roundups — keep only items that look related.
  const minScore = item.feed === 'yahoo-ticker' ? 5 : newsMinMatchScore;
  if (!tickerHit && scored.score < minScore) return null;

  const matchedBy = Array.from(new Set([
    ...scored.matchedBy,
    base,
    item.feed === 'yahoo-ticker' ? 'yahoo-ticker' : 'google-ticker',
  ].filter(Boolean))).slice(0, 6);

  return {
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    description: item.description,
    symbol: holding.symbol,
    matchedBy,
    score: Math.max(scored.score, tickerHit ? 12 : 0) + (item.feed === 'yahoo-ticker' ? 4 : 2),
    feed: item.feed,
  };
}

function matchGeneralFeedItem(item, holdings) {
  let best = null;
  for (const holding of holdings) {
    const scored = scoreNewsItem(item, holding);
    if (scored.score < newsMinMatchScore) continue;
    if (!best || scored.score > best.score) best = { holding, ...scored };
  }
  if (!best) return null;
  return {
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt,
    description: item.description,
    symbol: best.holding.symbol,
    matchedBy: best.matchedBy,
    score: best.score,
    feed: item.feed || 'investing',
  };
}

async function fetchHoldingNews(payload) {
  const holdings = Array.isArray(payload?.holdings) ? payload.holdings.slice(0, 20).map(normalizeNewsHolding).filter((item) => item.symbol) : [];
  if (!holdings.length) throw new Error('holdings is empty');
  const sources = normalizeNewsSources(payload?.sources);
  const useInvesting = sources.includes('investing');
  const useYahoo = sources.includes('yahoo');
  const useGoogle = sources.includes('google');
  const useTencent = sources.includes('tencent');

  // De-dupe multi-account same symbol so scoring is per ticker.
  const uniqueHoldings = Array.from(new Map(holdings.map((item) => [item.symbol, item])).values());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 26000);
  try {
    const [investingBound, tickerBound, tencentBound, generalResults] = await Promise.all([
      useInvesting ? fetchInvestingBoundNews(uniqueHoldings, controller.signal).catch(() => []) : Promise.resolve([]),
      (useYahoo || useGoogle)
        ? fetchTickerBoundNews(uniqueHoldings, controller.signal, { yahoo: useYahoo, google: useGoogle }).catch(() => [])
        : Promise.resolve([]),
      useTencent ? fetchTencentBoundNews(uniqueHoldings, controller.signal).catch(() => []) : Promise.resolve([]),
      useInvesting
        ? Promise.allSettled(investingNewsFeeds.map((url) => fetchText(url, controller.signal, investingRequestHeaders({
          accept: 'application/rss+xml, application/xml, text/xml, */*',
        }))))
        : Promise.resolve([]),
    ]);

    const generalItems = (Array.isArray(generalResults) ? generalResults : []).flatMap((result) => (
      result.status === 'fulfilled'
        ? parseRssItems(result.value, { source: 'Investing.com', feed: 'investing' })
        : []
    ));

    const matched = [];
    const seenUrls = new Set();

    // 1) Tencent finance (CN-friendly).
    for (const item of tencentBound) {
      const attached = attachTencentFeedItem(item);
      if (!attached || seenUrls.has(attached.url)) continue;
      seenUrls.add(attached.url);
      matched.push(attached);
    }

    // 2) Investing.com instrument news (Pro/session cookie unlocks pair pages).
    for (const item of investingBound) {
      const attached = attachInvestingPairItem(item);
      if (!attached || seenUrls.has(attached.url)) continue;
      seenUrls.add(attached.url);
      matched.push(attached);
    }

    // 3) Ticker-bound Yahoo / Google feeds.
    for (const item of tickerBound) {
      const attached = attachTickerFeedItem(item);
      if (!attached || seenUrls.has(attached.url)) continue;
      seenUrls.add(attached.url);
      matched.push(attached);
    }

    // 4) Investing EN/CN RSS with strict keyword match.
    for (const item of generalItems) {
      if (seenUrls.has(item.url)) continue;
      const attached = matchGeneralFeedItem(item, uniqueHoldings);
      if (!attached) continue;
      seenUrls.add(attached.url);
      matched.push({
        ...attached,
        score: attached.score + 2, // slight preference for Investing RSS hits
        matchedBy: Array.from(new Set([...(attached.matchedBy || []), 'investing-rss'])).slice(0, 6),
      });
    }

    // Fallback is explicitly market-level — never pin random stories onto holdings[0].
    const fallbackItems = generalItems.slice(0, 8).map((item) => ({
      ...item,
      symbol: 'MARKET',
      matchedBy: ['market', 'investing-rss'],
      score: 0,
      feed: 'investing',
    }));

    // If only Tencent is selected and matched is empty, keep empty rather than inventing Investing fallback.
    const ranked = (matched.length ? matched : (useInvesting ? fallbackItems : []))
      .sort((a, b) => b.score - a.score || new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    // Fair mix: up to 3 stories per ticker first, then fill remaining slots by score.
    const selectedRaw = [];
    const perSymbol = new Map();
    for (const item of ranked) {
      const count = perSymbol.get(item.symbol) || 0;
      if (count >= 3) continue;
      selectedRaw.push(item);
      perSymbol.set(item.symbol, count + 1);
      if (selectedRaw.length >= 18) break;
    }
    if (selectedRaw.length < 18) {
      const used = new Set(selectedRaw.map((item) => item.url));
      for (const item of ranked) {
        if (used.has(item.url)) continue;
        selectedRaw.push(item);
        used.add(item.url);
        if (selectedRaw.length >= 18) break;
      }
    }
    const selected = selectedRaw.map((item, index) => ({
      id: `${item.symbol}-${index}-${hashText(item.url)}`,
      symbol: item.symbol,
      title: item.title.slice(0, 180),
      source: item.source.slice(0, 40),
      url: item.url,
      publishedAt: item.publishedAt,
      matchedBy: (item.matchedBy || []).slice(0, 6),
      analysis: analyzeNewsItem(item),
    }));

    const matchedSymbols = new Set(selected.map((item) => item.symbol).filter((symbol) => symbol !== 'MARKET'));
    const investingPairHits = selected.filter((item) => (item.matchedBy || []).includes('investing-pair')).length;
    const investingRssHits = selected.filter((item) => (item.matchedBy || []).includes('investing-rss') || String(item.source || '').includes('Investing')).length;
    const tickerHits = selected.filter((item) => (item.matchedBy || []).some((value) => value === 'yahoo-ticker' || value === 'google-ticker')).length;
    const tencentHits = selected.filter((item) => (item.matchedBy || []).includes('tencent-ticker') || String(item.source || '').includes('腾讯')).length;
    const activeCount = [investingPairHits + investingRssHits > 0, tickerHits > 0, tencentHits > 0].filter(Boolean).length;
    const source = !matched.length
      ? 'fallback'
      : activeCount > 1
        ? 'mixed'
        : tencentHits > 0
          ? 'tencent'
          : investingPairHits + investingRssHits > 0
            ? 'investing'
            : tickerHits > 0
              ? 'ticker'
              : 'mixed';

    const sourceLabels = sources.map((id) => (
      id === 'tencent' ? '腾讯财经'
        : id === 'investing' ? 'Investing'
          : id === 'yahoo' ? 'Yahoo'
            : id === 'google' ? 'Google'
              : id
    )).join(' + ');

    const cookieHint = !useInvesting
      ? '未启用 Investing'
      : investingSessionCookie
        ? (investingPairHits ? `Investing 标的新闻 ${investingPairHits} 条` : '已配置 Investing Cookie，但标的页暂未取到文章')
        : '未配置 INVESTING_SESSION_COOKIE，Investing 仅用公开 RSS';

    return {
      source,
      sources,
      fetchedAt: new Date().toISOString(),
      summary: matched.length
        ? `已选源：${sourceLabels}。${uniqueHoldings.length} 只标的中 ${matchedSymbols.size} 只命中，展示 ${selected.length} 条（腾讯 ${tencentHits} / Investing ${investingPairHits + investingRssHits} / Yahoo·Google ${tickerHits}；${cookieHint}）。`
        : `已选源：${sourceLabels}。未命中具体持仓新闻。${cookieHint}。`,
      items: selected,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function analyzeNewsItem(item) {
  const text = `${item.title || ''} ${item.source || ''}`.toLowerCase();
  const positiveWords = ['record', 'fresh high', 'upside', 'rally', 'beats', 'beat ', 'upgrade', 'raises', 'buy', 'outperform', 'surge', 'jumps', 'gain', 'strong', 'growth', '利好', '上涨', '新高', '上调', '买入', '增长'];
  const negativeWords = ['falling', 'falls', 'drop', 'drops', 'downside', 'sell', 'downgrade', 'miss', 'lawsuit', 'probe', 'risk', 'warning', 'slump', 'cuts', 'weak', 'bearish', '利空', '下跌', '下调', '卖出', '风险'];
  const mediumWords = ['fed', 'inflation', 'rates', 'earnings', 'valuation', 'hindenburg', 'tariff', 'regulation', 'yield', '估值', '财报', '利率', '通胀', '监管'];
  const positiveScore = positiveWords.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
  const negativeScore = negativeWords.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
  const macroScore = mediumWords.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
  const stance = negativeScore > positiveScore ? '利空' : positiveScore > negativeScore ? '利好' : '中性';
  const impact = Math.max(positiveScore, negativeScore) >= 2 || item.score >= 3 ? '中影响' : macroScore || item.score >= 2 ? '中影响' : '低影响';
  const target = item.symbol && item.symbol !== 'MARKET' ? item.symbol : '市场';
  const summary = buildNewsSummary(target, stance, item.title || '相关新闻');
  return { summary, stance, impact };
}

function buildNewsSummary(target, stance, title) {
  const cleanedTitle = title.replace(/\s+/g, ' ').replace(/\s-\s[^-]{2,40}$/g, '').trim();
  if (stance === '利好') return `这条新闻对 ${target} 偏正面，核心关注点是：${cleanedTitle.slice(0, 54)}。`;
  if (stance === '利空') return `这条新闻对 ${target} 偏负面，需要关注：${cleanedTitle.slice(0, 54)}。`;
  return `这条新闻对 ${target} 影响偏中性，主要提供背景信息：${cleanedTitle.slice(0, 54)}。`;
}

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

async function fetchNasdaqHistory(symbol, period) {
  const remote = nasdaqSymbols[symbol] || buildUsRemoteSymbol(symbol);
  if (!remote) throw new Error(`${symbol} is not supported`);
  if (!['day', 'week', 'month'].includes(period)) {
    throw new Error('Unsupported Nasdaq historical period');
  }

  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (period === 'day' ? 420 : period === 'week' ? 900 : 2200));
  const url = `https://api.nasdaq.com/api/quote/${remote.symbol}/historical?assetclass=${remote.assetClass}&fromdate=${formatIsoDate(start)}&todate=${formatIsoDate(end)}&limit=9999`;

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`Nasdaq HTTP ${response.status}`);
  return response.json();
}

async function fetchNasdaqChart(symbol) {
  const remote = nasdaqSymbols[symbol] || buildUsRemoteSymbol(symbol);
  if (!remote) throw new Error(`${symbol} is not supported`);
  const url = `https://api.nasdaq.com/api/quote/${remote.symbol}/chart?assetclass=${remote.assetClass}`;

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`Nasdaq chart HTTP ${response.status}`);
  return response.json();
}

async function fetchUsMarketHistory(symbol, period) {
  if (period === 'minute') return fetchNasdaqChart(symbol);
  if (period === 'fiveDay') return fetchNasdaqHistory(symbol, 'day');
  return fetchNasdaqHistory(symbol, period);
}

function buildUsRemoteSymbol(symbol) {
  const match = String(symbol || '').toUpperCase().match(/^([A-Z][A-Z0-9.-]{0,9})\.US$/);
  if (!match) return null;
  const ticker = match[1];
  return { symbol: ticker, assetClass: guessUsAssetClass(ticker) };
}

function guessUsAssetClass(ticker) {
  if (ticker.endsWith('Q') || ['QQQ', 'VOO', 'SPY', 'DIA', 'IWM', 'VTI'].includes(ticker)) return 'etf';
  return 'stocks';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 60_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function readLargeBody(req, maxBytes = 50_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeHolding(item) {
  return {
    name: String(item?.name || '').slice(0, 40),
    symbol: String(item?.symbol || '').slice(0, 24),
    market: String(item?.market || '').slice(0, 8),
    type: String(item?.type || '').slice(0, 16),
    currency: String(item?.currency || '').slice(0, 8),
    qty: asNumber(item?.qty),
    price: asNumber(item?.price),
    cost: asNumber(item?.cost),
    todayPnl: asNumber(item?.todayPnl),
    totalPnl: asNumber(item?.totalPnl),
  };
}

function normalizeOcrDraft(result) {
  const holdings = Array.isArray(result?.holdings) ? result.holdings.slice(0, 50).map((item) => ({
    broker: normalizeEnum(item?.broker, supportedBrokers, '盈立证券'),
    account: String(item?.account || '').slice(0, 40),
    market: normalizeEnum(item?.market, ['US', 'HK', 'CN'], 'HK'),
    type: normalizeEnum(item?.type, ['个股', 'ETF', '杠杆ETF'], 'ETF'),
    name: String(item?.name || '').slice(0, 40),
    symbol: normalizeSymbol(item?.symbol),
    currency: normalizeEnum(item?.currency, ['USD', 'HKD', 'CNY'], 'HKD'),
    qty: asNumber(item?.qty),
    price: asNumber(item?.price),
    cost: asNumber(item?.cost),
    sourceImage: String(item?.sourceImage || '').slice(0, 120),
    warnings: normalizeStringArray(item?.warnings, 5, 80),
  })).filter((item) => item.symbol || item.name) : [];

  const accountSnapshots = Array.isArray(result?.accountSnapshots) ? result.accountSnapshots.slice(0, 20).map((item) => ({
    broker: normalizeEnum(item?.broker, supportedBrokers, '盈立证券'),
    account: String(item?.account || '').slice(0, 40),
    market: normalizeEnum(item?.market, ['US', 'HK', 'CN'], 'HK'),
    currency: normalizeEnum(item?.currency, ['USD', 'HKD', 'CNY'], 'HKD'),
    netAsset: asNumber(item?.netAsset),
    sourceImage: String(item?.sourceImage || '').slice(0, 120),
    warnings: normalizeStringArray(item?.warnings, 5, 80),
  })).filter((item) => item.account || item.netAsset > 0) : [];

  return {
    source: 'ai-ocr',
    model: openaiModel,
    summary: String(result?.summary || '已生成 OCR 持仓快照草稿。').replace(/\s+/g, ' ').trim().slice(0, 180),
    holdings,
    accountSnapshots,
    warnings: normalizeStringArray(result?.warnings, 12, 120),
  };
}

function normalizeEnum(value, allowed, fallback) {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : fallback;
}

function normalizeSymbol(value) {
  const text = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{1,5}\.HK$/.test(text)) {
    const code = text.replace(/\.HK$/, '').padStart(5, '0');
    return `${code}.HK`;
  }
  if (/^\d{1,5}$/.test(text) && text.length <= 5 && !/^\d{6}$/.test(text)) return `${text.padStart(5, '0')}.HK`;
  if (/^\d{6}\.SS$/.test(text)) return text.replace(/\.SS$/, '.SH');
  if (/^\d{6}\.(SH|SZ)$/.test(text)) return text;
  if (/^\d{6}$/.test(text)) {
    if (text.startsWith('6') || text.startsWith('5') || text.startsWith('9')) return `${text}.SH`;
    return `${text}.SZ`;
  }
  if (/^[A-Z.\-]{1,10}\.US$/.test(text)) return text;
  if (/^[A-Z.\-]{1,10}$/.test(text)) return `${text}.US`;
  return text.slice(0, 24);
}

function normalizeStringArray(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizePayload(payload) {
  const holdings = Array.isArray(payload?.holdings) ? payload.holdings.slice(0, 20).map(normalizeHolding) : [];
  const summary = payload?.summary && typeof payload.summary === 'object' ? {
    total: asNumber(payload.summary.total),
    gross: asNumber(payload.summary.gross),
    cash: asNumber(payload.summary.cash),
    todayPnl: asNumber(payload.summary.todayPnl),
    todayRealizedPnl: asNumber(payload.summary.todayRealizedPnl),
    todayReturn: asNumber(payload.summary.todayReturn),
    realizedPnl: asNumber(payload.summary.realizedPnl),
    totalReturn: asNumber(payload.summary.totalReturn),
    totalPnl: asNumber(payload.summary.totalPnl),
  } : null;

  return {
    currency: String(payload?.currency || 'HKD').slice(0, 8),
    quoteStatus: String(payload?.quoteStatus || 'unknown').slice(0, 24),
    lastRefresh: String(payload?.lastRefresh || '').slice(0, 32),
    summary,
    holdings,
  };
}

function normalizeAskPayload(payload) {
  const base = normalizePayload(payload);
  return {
    ...base,
    question: String(payload?.question || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    riskSummary: String(payload?.riskSummary || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    risks: Array.isArray(payload?.risks) ? payload.risks.slice(0, 8).map((item) => ({
      level: normalizeEnum(item?.level, ['高', '中', '低'], '中'),
      title: String(item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 36),
      text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    })).filter((item) => item.title || item.text) : [],
    newsSummary: String(payload?.newsSummary || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    newsItems: Array.isArray(payload?.newsItems) ? payload.newsItems.slice(0, 8).map((item) => ({
      symbol: String(item?.symbol || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      title: String(item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      source: String(item?.source || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      publishedAt: String(item?.publishedAt || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      matchedBy: normalizeStringArray(item?.matchedBy, 4, 32),
      url: String(item?.url || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    })).filter((item) => item.title) : [],
  };
}

function fallbackAnalysis(input, reason = '模型分析暂不可用') {
  const leveraged = input.holdings.find((holding) => holding.type.includes('杠杆'));
  const loss = input.holdings.find((holding) => holding.totalPnl < 0);
  const alerts = [];

  if (leveraged) {
    const drawdown = leveraged.cost ? ((leveraged.price - leveraged.cost) / leveraged.cost) * 100 : 0;
    alerts.push({
      level: '高',
      title: '杠杆仓位优先复核',
      text: `${leveraged.symbol} 当前较成本${drawdown.toFixed(2)}%，先确认是否继续承受双倍波动和隔夜跳空风险。`,
    });
  }

  if (loss && loss !== leveraged) {
    alerts.push({
      level: '中',
      title: '亏损标的需要止损线',
      text: `${loss.symbol} 仍处浮亏，建议写清楚补仓、减仓或继续持有的触发条件。`,
    });
  }

  alerts.push({
    level: '低',
    title: 'AI 预警回退到规则',
    text: reason,
  });

  return {
    source: 'fallback',
    model: 'local-rules',
    summary: '模型接口暂未返回可用结果，当前展示本地规则兜底风险。',
    alerts: alerts.slice(0, 3),
  };
}

function fallbackAsk(input, reason = '模型问询暂不可用') {
  const total = input.summary?.total ?? 0;
  const totalPnl = input.summary?.totalPnl ?? 0;
  const largest = [...input.holdings].sort((a, b) => (b.price * b.qty) - (a.price * a.qty))[0];
  const loss = [...input.holdings].sort((a, b) => a.totalPnl - b.totalPnl)[0];
  const riskText = input.risks?.[0] ? `当前最高优先级预警是：${input.risks[0].title}，${input.risks[0].text}` : '当前没有读取到高优先级预警。';
  const newsText = input.newsItems?.length ? `当前 Investing 市场新闻包括：${input.newsItems.slice(0, 2).map((item) => `${item.source}《${item.title}》`).join('；')}。` : '当前没有可用 Investing 新闻上下文。';
  const answer = `AI 接口暂时不可用，已回退到本地规则。基于当前数据：总资产净值约 ${formatAmount(total, input.currency)}，持仓盈亏约 ${formatAmount(totalPnl, input.currency)}。${largest ? `最大持仓是 ${largest.symbol}（${largest.name}）。` : ''}${loss ? `最大亏损线索是 ${loss.symbol}，累计盈亏约 ${formatAmount(loss.totalPnl, loss.currency)}。` : ''}${riskText}${newsText} 建议先核对券商 App 的账户净值、成本价和数量，再结合相关新闻判断风险来源。原因：${reason}`;

  return {
    source: 'fallback',
    model: 'local-rules',
    answer,
  };
}

function formatAmount(amount, currency) {
  const mark = currency === 'USD' ? 'US$' : currency === 'CNY' ? '¥' : 'HK$';
  return `${mark} ${Number(amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('model did not return json');
    return JSON.parse(match[0]);
  }
}

function normalizeModelResult(result, model = anthropicModel) {
  const rawAlerts = Array.isArray(result?.alerts) ? result.alerts : [];
  const alerts = rawAlerts.slice(0, 4).map((item) => {
    const level = item?.level === '高' || item?.level === '中' || item?.level === '低' ? item.level : '中';
    return {
      level,
      title: String(item?.title || '持仓风险提示').slice(0, 28),
      text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  }).filter((item) => item.text);

  if (!alerts.length) throw new Error('model returned no alerts');

  return {
    source: 'ai',
    model,
    summary: String(result?.summary || '已生成持仓风险分析。').replace(/\s+/g, ' ').trim().slice(0, 160),
    alerts,
  };
}

async function callAnthropic(input, aiConfig) {
  const config = activeAnthropic(aiConfig);
  if (!config.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const prompt = `请分析这个个人投资组合的持仓风险。只输出 JSON，不要 Markdown。\n\n要求：\n- 使用中文。\n- 不提供买卖指令，不承诺收益。\n- 重点识别杠杆 ETF、亏损幅度、集中度、货币/市场风险、行情刷新异常。\n- 输出格式：{"summary":"一句总览","alerts":[{"level":"高|中|低","title":"短标题","text":"具体风险与观察动作"}]}。\n- alerts 最多 4 条。\n\n组合数据：\n${JSON.stringify(input)}`;

  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 900,
        temperature: 0.2,
        system: '你是谨慎的个人持仓风险分析助手。你只能基于用户给出的持仓数据做风险提示，不能给确定性投资建议。',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const text = payload?.content?.map((part) => part?.text || '').join('\n') || '';
    return normalizeModelResult(extractJson(text), config.model);
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropicAsk(input, aiConfig) {
  const config = activeAnthropic(aiConfig);
  if (!config.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const prompt = `用户正在询问自己的股票持仓看板。请只基于给出的结构化数据回答。

用户问题：${input.question}

回答要求：
- 使用中文，语气像谨慎的个人投资复盘助手。
- 必须引用当前数据里的具体事实，例如账户净值、盈亏、标的、风险预警、刷新状态。
- 必须结合 newsItems 中的 Investing/英为财情市场新闻回答；引用新闻时写出来源或标题。
- 如果 newsItems 为空，只能说明“当前没有可用 Investing 新闻上下文”，不要编造新闻。
- 区分“持仓事实”和“市场新闻”：新闻只能作为外部背景，不等同于该持仓已经发生的事实。
- 不提供确定性买卖指令，不承诺收益，不说“必涨/必跌”。
- 优先分析仓位结构和持仓风险，其次分析收益表现。
- 如果数据不足，直接说明缺哪个字段。
- 输出 JSON：{"answer":"一段可直接展示给用户的回答"}。

当前看板数据：
${JSON.stringify(input)}`;

  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 900,
        temperature: 0.2,
        system: '你是谨慎的个人持仓问询助手。你只能基于用户给出的看板数据和 Investing 新闻上下文做复盘分析，不能给确定性投资建议。',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const text = payload?.content?.map((part) => part?.text || '').join('\n') || '';
    return normalizeAskResult(extractJson(text), config.model);
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAICompatible(input, aiConfig) {
  const config = activeOpenAi(aiConfig);
  if (!config.apiKey.trim()) throw new Error('OPENAI_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const prompt = `请分析这个个人投资组合的持仓风险。只输出 JSON，不要 Markdown。\n\n要求：\n- 使用中文。\n- 不提供买卖指令，不承诺收益。\n- 重点识别杠杆 ETF、亏损幅度、集中度、货币/市场风险、行情刷新异常。\n- 输出格式：{"summary":"一句总览","alerts":[{"level":"高|中|低","title":"短标题","text":"具体风险与观察动作"}]}。\n- alerts 最多 4 条。\n\n组合数据：\n${JSON.stringify(input)}`;

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: 'system', content: '你是谨慎的个人持仓风险分析助手。你只能基于用户给出的持仓数据做风险提示，不能给确定性投资建议。' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content || '';
    return normalizeModelResult(extractJson(text), config.model);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAskResult(result, model) {
  const answer = String(result?.answer || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
  if (!answer) throw new Error('model returned no answer');
  return { source: 'ai', model, answer };
}

async function callOpenAICompatibleAsk(input, aiConfig) {
  const config = activeOpenAi(aiConfig);
  if (!config.apiKey.trim()) throw new Error('OPENAI_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const prompt = `用户正在询问自己的股票持仓看板。请只基于给出的结构化数据回答。

用户问题：${input.question}

回答要求：
- 使用中文，语气像谨慎的个人投资复盘助手。
- 必须引用当前数据里的具体事实，例如账户净值、盈亏、标的、风险预警、刷新状态。
- 必须结合 newsItems 中的 Investing/英为财情市场新闻回答；引用新闻时写出来源或标题。
- 如果 newsItems 为空，只能说明“当前没有可用 Investing 新闻上下文”，不要编造新闻。
- 区分“持仓事实”和“市场新闻”：新闻只能作为外部背景，不等同于该持仓已经发生的事实。
- 不提供确定性买卖指令，不承诺收益，不说“必涨/必跌”。
- 优先分析仓位结构和持仓风险，其次分析收益表现。
- 如果数据不足，直接说明缺哪个字段。
- 输出 JSON：{"answer":"一段可直接展示给用户的回答"}。

当前看板数据：
${JSON.stringify(input)}`;

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: 'system', content: '你是谨慎的个人持仓问询助手。你只能基于用户给出的看板数据和 Investing 新闻上下文做复盘分析，不能给确定性投资建议。' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content || '';
    return normalizeAskResult(extractJson(text), config.model);
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAIOcr(images, aiConfig) {
  const config = activeOpenAi(aiConfig);
  if (!Array.isArray(images) || images.length === 0) throw new Error('images is empty');
  if (images.length > 6) throw new Error('最多一次上传 6 张截图');

  const normalizedImages = images.map((image, index) => {
    const name = String(image?.name || `image-${index + 1}`).slice(0, 120);
    const type = String(image?.type || '').toLowerCase();
    const dataBase64 = String(image?.dataBase64 || '');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error(`${name} 文件类型不支持`);
    if (!dataBase64 || dataBase64.length > 8_400_000) throw new Error(`${name} 超过 6MB 或内容为空`);
    return { name, type, dataBase64 };
  });

  if (!config.apiKey.trim()) throw new Error('OPENAI_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ocrTimeoutMs);
  const prompt = `请从这些券商截图中识别个人持仓快照。只输出 JSON，不要 Markdown。\n\n支持券商：${supportedBrokerText}。\n\n识别要求：\n- 合并多张截图的信息，去重明显重复的持仓。\n- 只基于截图内容，不要猜测截图中没有的字段。\n- 数字必须保留小数，注意数量、现价、成本价、账户净值不要串列。\n- 港股代码输出为 00936.HK；A股输出 601208.SH、000001.SZ；美股输出 AAPL.US、QQQ.US 这种格式。\n- broker 只能是 ${supportedBrokerText}。\n- market 只能是 US、HK 或 CN（大A）；currency 只能是 USD、HKD 或 CNY。\n- type 只能是 个股、ETF、杠杆ETF。\n- 对不确定字段写入该行 warnings。\n\n输出格式：\n{\n  "summary":"一句话说明识别结果",\n  "holdings":[{"broker":"${supportedBrokerJsonText}","account":"账户名","market":"US|HK|CN","type":"个股|ETF|杠杆ETF","name":"名称","symbol":"代码","currency":"USD|HKD|CNY","qty":0,"price":0,"cost":0,"sourceImage":"文件名","warnings":["可疑字段"]}],\n  "accountSnapshots":[{"broker":"${supportedBrokerJsonText}","account":"账户名","market":"US|HK|CN","currency":"USD|HKD|CNY","netAsset":0,"sourceImage":"文件名","warnings":["可疑字段"]}],\n  "warnings":["整体注意事项"]\n}`;

  try {
    const content = [
      { type: 'text', text: prompt },
      ...normalizedImages.map((image) => ({
        type: 'image_url',
        image_url: { url: `data:${image.type};base64,${image.dataBase64}` },
      })),
    ];
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_tokens: 2500,
        messages: [
          { role: 'system', content: '你是谨慎的券商截图 OCR 结构化助手。你只抽取截图可见信息，必须返回 JSON。' },
          { role: 'user', content },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OCR LLM HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content || '';
    return normalizeOcrDraft(extractJson(text));
  } finally {
    clearTimeout(timeout);
  }
}

async function callLlm(input, aiConfig) {
  if (activeProvider(aiConfig) === 'anthropic') return callAnthropic(input, aiConfig);
  return callOpenAICompatible(input, aiConfig);
}

async function callAskLlm(input, aiConfig) {
  if (activeProvider(aiConfig) === 'anthropic') return callAnthropicAsk(input, aiConfig);
  return callOpenAICompatibleAsk(input, aiConfig);
}

function normalizeOutlookBias(value) {
  if (value === 'bullish' || value === 'bearish' || value === 'neutral') return value;
  if (value === '偏多') return 'bullish';
  if (value === '偏空') return 'bearish';
  if (value === '震荡' || value === '中性') return 'neutral';
  return null;
}

function normalizeOutlookConfidence(value) {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  if (value === '高') return 'high';
  if (value === '中') return 'medium';
  if (value === '低') return 'low';
  return null;
}

function normalizeHoldingOutlookResult(result, ruleOutlook, model) {
  const base = ruleOutlook && typeof ruleOutlook === 'object' ? ruleOutlook : {};
  const baseItems = Array.isArray(base.items) ? base.items : [];
  const aiItems = Array.isArray(result?.items) ? result.items : [];
  const bySymbol = new Map(aiItems.map((item) => [String(item?.symbol || '').toUpperCase(), item]));

  const items = baseItems.slice(0, 8).map((item) => {
    const patch = bySymbol.get(String(item?.symbol || '').toUpperCase()) || {};
    const bias = normalizeOutlookBias(patch.bias) || normalizeOutlookBias(item.bias) || 'neutral';
    const confidence = normalizeOutlookConfidence(patch.confidence) || normalizeOutlookConfidence(item.confidence) || 'low';
    const reasons = Array.isArray(patch.reasons)
      ? patch.reasons.map((reason) => String(reason || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3)
      : Array.isArray(item.reasons) ? item.reasons.slice(0, 3) : [];
    return {
      symbol: String(item.symbol || '').slice(0, 24),
      name: String(item.name || item.symbol || '').slice(0, 40),
      type: String(item.type || '个股').slice(0, 16),
      bias,
      confidence,
      score: Number.isFinite(Number(patch.score)) ? Number(patch.score) : Number(item.score) || 0,
      todayRate: item.todayRate == null ? null : Number(item.todayRate),
      weight: Number(item.weight) || 0,
      reasons: reasons.length ? reasons : ['模型未给出理由，保留规则信号'],
    };
  });

  const bullishCount = items.filter((item) => item.bias === 'bullish').length;
  const bearishCount = items.filter((item) => item.bias === 'bearish').length;
  const neutralCount = items.filter((item) => item.bias === 'neutral').length;
  const bias = normalizeOutlookBias(result?.bias) || normalizeOutlookBias(base.bias) || 'neutral';
  const confidence = normalizeOutlookConfidence(result?.confidence) || normalizeOutlookConfidence(base.confidence) || 'low';
  const summary = String(result?.summary || base.summary || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);

  return {
    bias,
    confidence,
    score: Number.isFinite(Number(result?.score)) ? Number(result.score) : Number(base.score) || 0,
    summary: summary || '模型已完成持仓短线复盘，请结合盘口自行判断。',
    sessionLabel: String(base.sessionLabel || '盘中'),
    items,
    bullishCount,
    bearishCount,
    neutralCount,
    source: 'ai',
    model: String(model || openaiModel).slice(0, 80),
  };
}

function buildOutlookPrompt(payload) {
  const ruleOutlook = payload?.ruleOutlook || {};
  const compact = {
    quoteViewSession: payload?.quoteViewSession || 'regular',
    marketSession: payload?.marketSession || 'closed',
    currency: payload?.currency || 'USD',
    sessionLabel: ruleOutlook.sessionLabel,
    ruleBias: ruleOutlook.bias,
    ruleConfidence: ruleOutlook.confidence,
    ruleSummary: ruleOutlook.summary,
    holdings: (Array.isArray(ruleOutlook.items) ? ruleOutlook.items : []).slice(0, 8).map((item) => ({
      symbol: item.symbol,
      name: item.name,
      type: item.type,
      weight: item.weight,
      todayRate: item.todayRate,
      ruleBias: item.bias,
      ruleConfidence: item.confidence,
      ruleReasons: item.reasons,
    })),
  };

  return `你是谨慎的个人持仓短线复盘助手，不是荐股机器人。请基于结构化持仓数据，对「今日/当前时段」走势做方向预判。

硬性要求：
- 只输出 JSON，不要 Markdown。
- 使用中文。
- 不得给出确定性买卖指令，不得承诺收益，不要说必涨/必跌。
- 只能基于提供的数据做解释性预判；信息不足就降低信心。
- 可参考 ruleBias/ruleReasons，但可以修正不合理规则结果并说明原因。
- bias 只能是 bullish|bearish|neutral。
- confidence 只能是 high|medium|low。
- items 必须覆盖输入里的每个 symbol，reasons 每项 1-3 条，每条不超过 40 字。

输出格式：
{
  "bias":"bullish|bearish|neutral",
  "confidence":"high|medium|low",
  "score":0,
  "summary":"一句话组合预判",
  "items":[{"symbol":"AAPL.US","bias":"bullish","confidence":"medium","score":1.2,"reasons":["理由1","理由2"]}]
}

输入数据：
${JSON.stringify(compact)}`;
}

async function callOpenAICompatibleOutlook(payload, aiConfig) {
  const config = activeOpenAi(aiConfig);
  if (!config.apiKey.trim()) throw new Error('OPENAI_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: 'system', content: '你是谨慎的个人持仓短线复盘助手。只基于用户数据输出 JSON 预判，不给确定性投资建议。' },
          { role: 'user', content: buildOutlookPrompt(payload) },
        ],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 280)}`);
    }
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content || '';
    return normalizeHoldingOutlookResult(extractJson(text), payload?.ruleOutlook, config.model);
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropicOutlook(payload, aiConfig) {
  const config = activeAnthropic(aiConfig);
  if (!config.apiKey.trim()) throw new Error('ANTHROPIC_API_KEY is not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 700,
        temperature: 0.2,
        messages: [{ role: 'user', content: buildOutlookPrompt(payload) }],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 280)}`);
    }
    const body = await response.json();
    const text = body?.content?.map((part) => part?.text || '').join('\n') || '';
    return normalizeHoldingOutlookResult(extractJson(text), payload?.ruleOutlook, config.model);
  } finally {
    clearTimeout(timeout);
  }
}

async function callOutlookLlm(payload, aiConfig) {
  if (activeProvider(aiConfig) === 'anthropic') return callAnthropicOutlook(payload, aiConfig);
  return callOpenAICompatibleOutlook(payload, aiConfig);
}

/** Map upstream gateway failures into short Chinese copy for the dashboard. */
function friendlyLlmError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/insufficient_user_quota|额度不足/i.test(message)) {
    return 'AI 额度不足，请到网关充值，或在页面右上角填写自己的 API Key';
  }
  if (/circuit breaker|skip candidate|raw request middlewares/i.test(message)) {
    return 'AI 网关线路熔断或节点跳过，请稍后再试，或更换模型';
  }
  if (/aborted|AbortError|timeout/i.test(message)) {
    return 'AI 请求超时，请稍后重试';
  }
  if (/401|unauthorized|invalid.*key|incorrect api key/i.test(message)) {
    return 'AI Key 无效或未授权，请检查服务器或页面 API 配置';
  }
  if (/429|rate limit/i.test(message)) {
    return 'AI 请求过于频繁，请稍后再试';
  }
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 140) || 'AI 服务暂时不可用';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { code: 0, data: { status: 'ok', service: 'gup-risk-analysis', model: anthropicModel } });
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/fear-greed')) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const data = await getFearGreed(url.searchParams.get('refresh') === '1');
      return sendJson(res, 200, { code: 0, data });
    } catch (error) {
      return sendJson(res, 502, { code: 502, message: error instanceof Error ? error.message : 'fear and greed fetch failed', data: null });
    }
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/market-history')) {
    try {
      const { symbol, period } = readMarketHistoryQuery(req);
      const data = await fetchUsMarketHistory(symbol, period);
      return sendJson(res, 200, { code: 0, data });
    } catch (error) {
      return sendJson(res, 400, { code: 400, message: error instanceof Error ? error.message : 'market history failed', data: null });
    }
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/extended-quotes')) {
    try {
      const { entries, session } = readExtendedQuoteQuery(req);
      const data = await fetchExtendedQuotes(entries, { session });
      return sendJson(res, 200, { code: 0, data });
    } catch (error) {
      return sendJson(res, 502, { code: 502, message: error instanceof Error ? error.message : 'extended quote fetch failed', data: null });
    }
  }
  if (req.url === '/api/snapshot') {
    try {
      if (req.method === 'GET') {
        const snapshot = await readSharedSnapshot();
        return sendJson(res, 200, { code: 0, data: snapshot });
      }
      if (req.method === 'POST') {
        const payload = JSON.parse(await readLargeBody(req) || '{}');
        const snapshot = await queueSharedSnapshotWrite(payload.snapshot || payload, payload.expectedRevision);
        return sendJson(res, 200, { code: 0, data: snapshot });
      }
      if (req.method === 'DELETE') {
        await deleteSharedSnapshot();
        return sendJson(res, 200, { code: 0, data: null });
      }
    } catch (error) {
      const status = Number(error?.statusCode) || 400;
      return sendJson(res, status, { code: status, message: error instanceof Error ? error.message : 'snapshot failed', data: null });
    }
  }
  if (req.method === 'POST' && req.url === '/api/ocr-snapshot') {
    try {
      const payload = JSON.parse(await readLargeBody(req) || '{}');
      const aiConfig = normalizeAiConfig(payload);
      const result = await callOpenAIOcr(payload.images, aiConfig);
      return sendJson(res, 200, { code: 0, data: result });
    } catch (error) {
      return sendJson(res, 400, { code: 400, message: error instanceof Error ? error.message : 'ocr failed', data: null });
    }
  }
  if (req.method === 'POST' && req.url === '/api/holding-news') {
    try {
      const payload = JSON.parse(await readBody(req) || '{}');
      const result = await fetchHoldingNews(payload);
      return sendJson(res, 200, { code: 0, data: result });
    } catch (error) {
      return sendJson(res, 400, { code: 400, message: error instanceof Error ? error.message : 'holding news failed', data: null });
    }
  }
  if (req.method === 'POST' && req.url === '/api/holding-outlook') {
    try {
      const payload = JSON.parse(await readBody(req) || '{}');
      const ruleOutlook = payload?.ruleOutlook;
      if (!ruleOutlook || !Array.isArray(ruleOutlook.items) || !ruleOutlook.items.length) {
        return sendJson(res, 400, { code: 400, message: 'ruleOutlook.items is empty', data: null });
      }
      const aiConfig = normalizeAiConfig(payload);
      try {
        const result = await callOutlookLlm(payload, aiConfig);
        return sendJson(res, 200, { code: 0, data: result });
      } catch (error) {
        const raw = error instanceof Error ? error.message : 'holding outlook failed';
        const message = friendlyLlmError(error);
        console.warn(raw);
        return sendJson(res, 200, {
          code: 0,
          data: {
            ...ruleOutlook,
            source: 'fallback',
            model: '',
            summary: String(ruleOutlook.summary || '规则预判可用。'),
            error: message,
          },
        });
      }
    } catch (error) {
      return sendJson(res, 400, { code: 400, message: error instanceof Error ? error.message : 'holding outlook failed', data: null });
    }
  }
  if (req.method !== 'POST' || req.url !== '/api/risk-analysis') {
    return sendJson(res, 404, { code: 404, message: 'not found', data: null });
  }

  let rawPayload;
  try {
    rawPayload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return sendJson(res, 400, { code: 400, message: error instanceof Error ? error.message : 'bad request', data: null });
  }

  if (String(rawPayload?.question || '').trim()) {
    const aiConfig = normalizeAiConfig(rawPayload);
    const input = normalizeAskPayload(rawPayload);
    if (!input.holdings.length) {
      return sendJson(res, 400, { code: 400, message: 'holdings is empty', data: null });
    }

    try {
      const result = await callAskLlm(input, aiConfig);
      return sendJson(res, 200, { code: 0, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ask analysis failed';
      console.warn(message);
      return sendJson(res, 200, { code: 0, data: fallbackAsk(input, message) });
    }
  }

  let input;
  try {
    input = normalizePayload(rawPayload);
  } catch (error) {
    return sendJson(res, 400, { code: 400, message: error instanceof Error ? error.message : 'bad request', data: null });
  }

  if (!input.holdings.length) {
    return sendJson(res, 400, { code: 400, message: 'holdings is empty', data: null });
  }

  try {
    const aiConfig = normalizeAiConfig(rawPayload);
    const result = await callLlm(input, aiConfig);
    return sendJson(res, 200, { code: 0, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'risk analysis failed';
    console.warn(message);
    return sendJson(res, 200, { code: 0, data: fallbackAnalysis(input, message) });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`gup risk analysis server listening on ${port} using ${provider}`);
});
