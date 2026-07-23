import http from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

const investingNewsFeeds = [
  'https://cn.investing.com/rss/news_25.rss',
  'https://cn.investing.com/rss/market_overview.rss',
  'https://cn.investing.com/rss/news_301.rss',
];

const symbolKeywordMap = {
  'AAPL.US': ['AAPL', 'Apple', '苹果', '苹果公司', 'iPhone', 'iPad', 'Mac'],
  'QQQ.US': ['QQQ', 'Nasdaq', 'Nasdaq 100', '纳斯达克', '纳指', '科技股', 'technology stocks', 'tech stocks'],
  'VOO.US': ['VOO', 'S&P 500', '标普500', '标普', '美股', 'Wall St', 'US stock', 'stock futures'],
  'SPCX.US': ['SPCX', 'SpaceX', '太空探索', '航天', '商业航天'],
};

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
    market: sanitizeEnum(item?.market, ['US', 'HK'], symbol.endsWith('.HK') ? 'HK' : 'US'),
    type: sanitizeEnum(item?.type, ['个股', 'ETF', '杠杆ETF'], '个股'),
    name: String(item?.name || symbol).trim().slice(0, 80),
    symbol,
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD'], symbol.endsWith('.US') ? 'USD' : 'HKD'),
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
    market: sanitizeEnum(item?.market, ['US', 'HK'], 'US'),
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD'], 'HKD'),
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
    market: sanitizeEnum(item?.market, ['US', 'HK'], symbol.endsWith('.HK') ? 'HK' : 'US'),
    holdingType: sanitizeEnum(item?.holdingType, ['个股', 'ETF', '杠杆ETF'], '个股'),
    name: String(item?.name || symbol).trim().slice(0, 80),
    symbol,
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD'], symbol.endsWith('.US') ? 'USD' : 'HKD'),
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
    market: sanitizeEnum(item?.market, ['US', 'HK'], symbol.endsWith('.HK') ? 'HK' : 'US'),
    holdingType: sanitizeEnum(item?.holdingType, ['个股', 'ETF', '杠杆ETF'], '个股'),
    name: String(item?.name || symbol).trim().slice(0, 80),
    symbol,
    currency: sanitizeEnum(item?.currency, ['USD', 'HKD'], symbol.endsWith('.US') ? 'USD' : 'HKD'),
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

async function fetchText(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
      'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`Investing HTTP ${response.status}`);
  return response.text();
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

function parseRssItems(xml) {
  return Array.from(String(xml || '').matchAll(/<item[\s\S]*?<\/item>/gi)).map((match) => {
    const block = match[0];
    return {
      title: extractTag(block, 'title'),
      url: extractTag(block, 'link'),
      source: extractTag(block, 'author') || 'Investing.com',
      publishedAt: normalizeNewsDate(extractTag(block, 'pubDate')),
    };
  }).filter((item) => item.title && item.url);
}

function normalizeNewsDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function keywordsForHolding(holding) {
  const baseSymbol = String(holding.symbol || '').replace(/\.(US|HK)$/i, '');
  return Array.from(new Set([
    holding.symbol,
    baseSymbol,
    holding.name,
    ...(symbolKeywordMap[holding.symbol] || []),
  ].map((item) => String(item || '').trim()).filter((item) => item.length >= 2)));
}

function scoreNewsItem(item, holding) {
  const haystack = `${item.title} ${item.url}`.toLowerCase();
  const matchedBy = [];
  for (const keyword of keywordsForHolding(holding)) {
    if (haystack.includes(keyword.toLowerCase())) matchedBy.push(keyword);
  }
  return { score: matchedBy.length, matchedBy };
}

function normalizeNewsHolding(item) {
  return {
    symbol: String(item?.symbol || '').slice(0, 24),
    name: String(item?.name || '').slice(0, 40),
    market: String(item?.market || '').slice(0, 8),
    type: String(item?.type || '').slice(0, 16),
  };
}

async function fetchHoldingNews(payload) {
  const holdings = Array.isArray(payload?.holdings) ? payload.holdings.slice(0, 20).map(normalizeNewsHolding).filter((item) => item.symbol) : [];
  if (!holdings.length) throw new Error('holdings is empty');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const feedResults = await Promise.allSettled(investingNewsFeeds.map((url) => fetchText(url, controller.signal)));
    const items = feedResults.flatMap((result) => result.status === 'fulfilled' ? parseRssItems(result.value) : []);
    const unique = new Map();
    for (const item of items) if (!unique.has(item.url)) unique.set(item.url, item);

    const matched = [];
    for (const item of unique.values()) {
      let best = null;
      for (const holding of holdings) {
        const scored = scoreNewsItem(item, holding);
        if (!best || scored.score > best.score) best = { holding, ...scored };
      }
      if (best?.score > 0) {
        matched.push({ ...item, symbol: best.holding.symbol, matchedBy: best.matchedBy, score: best.score });
      }
    }

    const fallbackItems = Array.from(unique.values()).slice(0, 8).map((item, index) => ({
      ...item,
      symbol: index % 2 === 0 ? 'MARKET' : holdings[0].symbol,
      matchedBy: ['market'],
      score: 0,
    }));

    const selected = (matched.length ? matched : fallbackItems)
      .sort((a, b) => b.score - a.score || new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, 12)
      .map((item, index) => ({
        id: `${item.symbol}-${index}-${hashText(item.url)}`,
        symbol: item.symbol,
        title: item.title.slice(0, 180),
        source: item.source.slice(0, 40),
        url: item.url,
        publishedAt: item.publishedAt,
        matchedBy: item.matchedBy.slice(0, 4),
        analysis: analyzeNewsItem(item),
      }));

    return {
      source: matched.length ? 'investing' : 'fallback',
      fetchedAt: new Date().toISOString(),
      summary: matched.length
        ? `从英为财情中国版 RSS 抓取并按 ${holdings.length} 支持仓关键词匹配到 ${selected.length} 条相关新闻。`
        : '英为财情中国版 RSS 暂未命中具体持仓，当前展示中文市场相关新闻作为参考。',
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
    market: normalizeEnum(item?.market, ['US', 'HK'], 'HK'),
    type: normalizeEnum(item?.type, ['个股', 'ETF', '杠杆ETF'], 'ETF'),
    name: String(item?.name || '').slice(0, 40),
    symbol: normalizeSymbol(item?.symbol),
    currency: normalizeEnum(item?.currency, ['USD', 'HKD'], 'HKD'),
    qty: asNumber(item?.qty),
    price: asNumber(item?.price),
    cost: asNumber(item?.cost),
    sourceImage: String(item?.sourceImage || '').slice(0, 120),
    warnings: normalizeStringArray(item?.warnings, 5, 80),
  })).filter((item) => item.symbol || item.name) : [];

  const accountSnapshots = Array.isArray(result?.accountSnapshots) ? result.accountSnapshots.slice(0, 20).map((item) => ({
    broker: normalizeEnum(item?.broker, supportedBrokers, '盈立证券'),
    account: String(item?.account || '').slice(0, 40),
    market: normalizeEnum(item?.market, ['US', 'HK'], 'HK'),
    currency: normalizeEnum(item?.currency, ['USD', 'HKD'], 'HKD'),
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
  if (/^\d{5}\.HK$/.test(text)) return text;
  if (/^\d{5}$/.test(text)) return `${text}.HK`;
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
  const prompt = `请从这些券商截图中识别个人持仓快照。只输出 JSON，不要 Markdown。\n\n支持券商：${supportedBrokerText}。\n\n识别要求：\n- 合并多张截图的信息，去重明显重复的持仓。\n- 只基于截图内容，不要猜测截图中没有的字段。\n- 数字必须保留小数，注意数量、现价、成本价、账户净值不要串列。\n- 港股代码输出为 00936.HK、300323.SZ 这种市场后缀格式；美股输出 AAPL.US、QQQ.US、VOO.US 这种格式。\n- broker 只能是 ${supportedBrokerText}。\n- market 只能是 US 或 HK；currency 只能是 USD 或 HKD。\n- type 只能是 个股、ETF、杠杆ETF。\n- 对不确定字段写入该行 warnings。\n\n输出格式：\n{\n  "summary":"一句话说明识别结果",\n  "holdings":[{"broker":"${supportedBrokerJsonText}","account":"账户名","market":"US|HK","type":"个股|ETF|杠杆ETF","name":"名称","symbol":"代码","currency":"USD|HKD","qty":0,"price":0,"cost":0,"sourceImage":"文件名","warnings":["可疑字段"]}],\n  "accountSnapshots":[{"broker":"${supportedBrokerJsonText}","account":"账户名","market":"US|HK","currency":"USD|HKD","netAsset":0,"sourceImage":"文件名","warnings":["可疑字段"]}],\n  "warnings":["整体注意事项"]\n}`;

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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { code: 0, data: { status: 'ok', service: 'gup-risk-analysis', model: anthropicModel } });
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
