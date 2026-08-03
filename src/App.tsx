import { useCallback, useEffect, useMemo, useState } from 'react';
import { accountSnapshots, baseRiskAlerts, holdings as importedHoldings } from './data/mockPortfolio';
import { AppShell } from './components/AppShell';
import { PortfolioSummaryCard } from './components/PortfolioSummaryCard';
import { QuickNewsStrip } from './components/QuickNewsStrip';
import { OverviewPage } from './pages/OverviewPage';
import { HoldingsPage } from './pages/HoldingsPage';
import { TrendsPage } from './pages/TrendsPage';
import { ImportPage } from './pages/ImportPage';
import { AskPage } from './pages/AskPage';
import type { BuyInput, Currency, Holding, HoldingNewsStatus, QuoteSession, QuoteStatus, SavedSnapshot, SellInput, SnapshotDraft, Tab } from './types';
import { aggregateHoldings, buildSummary } from './utils/portfolio';
import { applyQuotes, fetchLatestQuotes } from './utils/quotes';
import { AlertTriangle, BrainCircuit } from 'lucide-react';
import { fetchRiskAnalysis } from './utils/riskAnalysis';
import { fetchHoldingNews } from './utils/holdingNews';
import { clearSharedSnapshot, fetchSharedSnapshot, pushSharedSnapshot, readSavedSnapshot, saveSnapshotFromDraft } from './utils/snapshotStorage';
import { aiConfigPayload, readAiConfig, saveAiConfig } from './utils/aiConfig';
import { applySell, reverseSell } from './utils/sellTransactions';
import { applyBuy, reverseBuy } from './utils/buyTransactions';

const dailyRiskAnalysisLimit = 3;
const riskAnalysisCacheKey = 'gup-risk-analysis-cache-v2';
const holdingNewsCacheKey = 'gup-holding-news-cache-v3';
const holdingNewsAiEnabledKey = 'gup-holding-news-ai-enabled-v1';
const tabs: Tab[] = ['overview', 'holdings', 'trends', 'ask', 'import'];

type CachedRiskAnalysis = {
  day: string;
  count: number;
  result: Awaited<ReturnType<typeof fetchRiskAnalysis>> | null;
};

type CachedHoldingNews = {
  day: string;
  result: Awaited<ReturnType<typeof fetchHoldingNews>> | null;
};

function todayKey() {
  return new Date().toLocaleDateString('en-CA');
}

function readInitialTab(): Tab {
  const hash = window.location.hash.replace('#', '');
  return tabs.includes(hash as Tab) ? (hash as Tab) : 'overview';
}

function readRiskAnalysisCache(): CachedRiskAnalysis {
  try {
    const cached = JSON.parse(localStorage.getItem(riskAnalysisCacheKey) || 'null') as CachedRiskAnalysis | null;
    if (cached?.day === todayKey()) return cached;
  } catch {
    // Ignore corrupted browser cache and start a fresh daily budget.
  }
  return { day: todayKey(), count: 0, result: null };
}

function writeRiskAnalysisCache(cache: CachedRiskAnalysis) {
  localStorage.setItem(riskAnalysisCacheKey, JSON.stringify(cache));
}

function readHoldingNewsCache(): CachedHoldingNews {
  try {
    const cached = JSON.parse(localStorage.getItem(holdingNewsCacheKey) || 'null') as CachedHoldingNews | null;
    if (cached?.day === todayKey()) return cached;
  } catch {
    // Ignore corrupted browser cache and refetch Investing news.
  }
  return { day: todayKey(), result: null };
}

function writeHoldingNewsCache(cache: CachedHoldingNews) {
  localStorage.setItem(holdingNewsCacheKey, JSON.stringify(cache));
}

function readHoldingNewsAiEnabled() {
  return localStorage.getItem(holdingNewsAiEnabledKey) !== 'false';
}

export function App() {
  const initialSnapshot = useMemo(readSavedSnapshot, []);
  const [tab, setTabState] = useState<Tab>(readInitialTab);
  const [currency, setCurrency] = useState<Currency>('USD');
  const [baseHoldings, setBaseHoldings] = useState(initialSnapshot?.holdings ?? importedHoldings);
  const [accountSnapshotsState, setAccountSnapshotsState] = useState(initialSnapshot?.accountSnapshots ?? accountSnapshots);
  const [savedSnapshot, setSavedSnapshot] = useState(initialSnapshot);
  const [holdings, setHoldings] = useState(initialSnapshot?.holdings ?? importedHoldings);
  const [masked, setMasked] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [confirmedRows, setConfirmedRows] = useState<Record<string, boolean>>({});
  const [lastRefresh, setLastRefresh] = useState('截图导入价');
  const [quoteStatus, setQuoteStatus] = useState<QuoteStatus>('idle');
  const [quoteSessions, setQuoteSessions] = useState<Record<string, QuoteSession | undefined>>({});
  const [riskAnalysis, setRiskAnalysis] = useState<Awaited<ReturnType<typeof fetchRiskAnalysis>> | null>(null);
  const [riskAnalysisStatus, setRiskAnalysisStatus] = useState<'idle' | 'loading' | 'ai' | 'fallback' | 'error'>('idle');
  const [holdingNews, setHoldingNews] = useState<Awaited<ReturnType<typeof fetchHoldingNews>> | null>(null);
  const [newsStatus, setNewsStatus] = useState<HoldingNewsStatus>('idle');
  const [newsAiEnabled, setNewsAiEnabledState] = useState(readHoldingNewsAiEnabled);
  const [aiConfigState, setAiConfigState] = useState(readAiConfig);

  const setAiConfig = useCallback((config: typeof aiConfigState) => {
    saveAiConfig(config);
    setAiConfigState(config);
  }, []);

  const setNewsAiEnabled = useCallback((enabled: boolean) => {
    localStorage.setItem(holdingNewsAiEnabledKey, String(enabled));
    setNewsAiEnabledState(enabled);
  }, []);

  const setTab = useCallback((nextTab: Tab) => {
    setTabState(nextTab);
    window.history.replaceState(null, '', `#${nextTab}`);
  }, []);

  const refreshNews = useCallback(async () => {
    const controller = new AbortController();
    setNewsStatus('loading');
    try {
      const result = await fetchHoldingNews(holdings, controller.signal);
      writeHoldingNewsCache({ day: todayKey(), result });
      setHoldingNews(result);
      setNewsStatus(result.source === 'investing' ? 'live' : 'fallback');
    } catch (error) {
      console.warn('holding news failed', error);
      setNewsStatus('error');
    }
  }, [holdings]);

  const applySavedSnapshot = useCallback((snapshot: SavedSnapshot) => {
    setSavedSnapshot(snapshot);
    setBaseHoldings(snapshot.holdings);
    setHoldings(snapshot.holdings);
    setAccountSnapshotsState(snapshot.accountSnapshots);
    setLastRefresh('共享快照价');
    setQuoteStatus('idle');
    setQuoteSessions({});
  }, []);

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    setQuoteStatus('refreshing');

    try {
      if (!baseHoldings.length) {
        setQuoteSessions({});
        setLastRefresh(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        setQuoteStatus('live');
        return;
      }
      const quotes = await fetchLatestQuotes(baseHoldings, controller.signal);
      setHoldings((current) => applyQuotes(current, quotes));
      setQuoteSessions(Object.fromEntries(
        Array.from(quotes.entries()).flatMap(([symbol, quote]) => quote.session ? [[symbol, quote.session]] : []),
      ));
      setLastRefresh(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      setQuoteStatus('live');
    } catch (error) {
      console.warn('quote refresh failed, using imported snapshot prices', error);
      setLastRefresh(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      setQuoteStatus('fallback');
    } finally {
      window.clearTimeout(timeout);
    }
  }, [baseHoldings]);

  const saveDraftSnapshot = useCallback(async (draft: SnapshotDraft, fileNames: string[]) => {
    const remoteSnapshot = await fetchSharedSnapshot();
    const previous = remoteSnapshot ?? savedSnapshot ?? createDefaultSnapshot(holdings, accountSnapshotsState);
    const saved = saveSnapshotFromDraft(draft, fileNames, previous);
    const shared = await pushSharedSnapshot(saved, previous.revision);
    applySavedSnapshot(shared);
    setConfirmedRows({});
    setUploaded(false);
    setLastRefresh(draft.source === 'manual' ? '手动持仓价' : 'OCR 快照价');
    setQuoteStatus('idle');
  }, [accountSnapshotsState, applySavedSnapshot, holdings, savedSnapshot]);

  const registerBuy = useCallback(async (input: BuyInput) => {
    const remote = await fetchSharedSnapshot();
    const previous = remote ?? savedSnapshot;
    if (!previous) throw new Error('共享持仓尚未准备好，请刷新页面后重试');
    if (savedSnapshot && previous.revision !== savedSnapshot.revision) {
      applySavedSnapshot(previous);
      throw new Error('持仓已在其他设备更新，页面已刷新，请重新确认买入');
    }
    const next = applyBuy(previous, input);
    const shared = await pushSharedSnapshot(next, previous.revision);
    applySavedSnapshot(shared);
  }, [applySavedSnapshot, savedSnapshot]);

  const revokeBuy = useCallback(async (recordId: string) => {
    const remote = await fetchSharedSnapshot();
    const previous = remote ?? savedSnapshot;
    if (!previous) throw new Error('共享持仓尚未准备好，请刷新页面后重试');
    if (savedSnapshot && previous.revision !== savedSnapshot.revision) {
      applySavedSnapshot(previous);
      throw new Error('持仓已在其他设备更新，页面已刷新，请重新操作');
    }
    const next = reverseBuy(previous, recordId);
    const shared = await pushSharedSnapshot(next, previous.revision);
    applySavedSnapshot(shared);
  }, [applySavedSnapshot, savedSnapshot]);

  const registerSell = useCallback(async (holding: Holding, input: SellInput) => {
    const remote = await fetchSharedSnapshot();
    const previous = remote ?? savedSnapshot;
    if (!previous) throw new Error('共享持仓尚未准备好，请刷新页面后重试');
    if (savedSnapshot && previous.revision !== savedSnapshot.revision) {
      applySavedSnapshot(previous);
      throw new Error('持仓已在其他设备更新，页面已刷新，请重新确认卖出');
    }
    const next = applySell(previous, holding, input);
    const shared = await pushSharedSnapshot(next, previous.revision);
    applySavedSnapshot(shared);
  }, [applySavedSnapshot, savedSnapshot]);

  const revokeSell = useCallback(async (recordId: string) => {
    const remote = await fetchSharedSnapshot();
    const previous = remote ?? savedSnapshot;
    if (!previous) throw new Error('共享持仓尚未准备好，请刷新页面后重试');
    if (savedSnapshot && previous.revision !== savedSnapshot.revision) {
      applySavedSnapshot(previous);
      throw new Error('持仓已在其他设备更新，页面已刷新，请重新操作');
    }
    const next = reverseSell(previous, recordId);
    const shared = await pushSharedSnapshot(next, previous.revision);
    applySavedSnapshot(shared);
  }, [applySavedSnapshot, savedSnapshot]);

  const resetSnapshot = useCallback(async () => {
    await clearSharedSnapshot();
    setSavedSnapshot(null);
    setBaseHoldings(importedHoldings);
    setHoldings(importedHoldings);
    setAccountSnapshotsState(accountSnapshots);
    setConfirmedRows({});
    setUploaded(false);
    setLastRefresh('截图导入价');
    setQuoteStatus('idle');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSharedSnapshot(controller.signal)
      .then((shared) => {
        if (shared) {
          applySavedSnapshot(shared);
          return;
        }
        if (initialSnapshot) {
          void pushSharedSnapshot(initialSnapshot, initialSnapshot.revision, controller.signal).catch((error) => {
            console.warn('initial shared snapshot seed failed', error);
          });
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn('shared snapshot fetch failed', error);
      });
    return () => controller.abort();
  }, [applySavedSnapshot, initialSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    const sync = () => {
      void fetchSharedSnapshot(controller.signal)
        .then((shared) => {
          if (shared && shared.revision > (savedSnapshot?.revision ?? -1)) applySavedSnapshot(shared);
        })
        .catch((error) => {
          if (!controller.signal.aborted) console.warn('shared snapshot sync failed', error);
        });
    };
    const timer = window.setInterval(sync, 10000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [applySavedSnapshot, savedSnapshot?.revision]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const summary = useMemo(
    () => buildSummary(
      holdings,
      currency,
      accountSnapshotsState,
      baseHoldings,
      savedSnapshot?.sellRecords ?? [],
      savedSnapshot?.buyRecords ?? [],
      savedSnapshot?.positionsUpdatedAt ?? '',
      savedSnapshot?.accountPositionsUpdatedAt ?? {},
    ),
    [currency, holdings, accountSnapshotsState, baseHoldings, savedSnapshot?.sellRecords, savedSnapshot?.buyRecords, savedSnapshot?.positionsUpdatedAt, savedSnapshot?.accountPositionsUpdatedAt],
  );
  const aggregated = useMemo(() => aggregateHoldings(holdings, currency), [currency, holdings]);

  useEffect(() => {
    const cache = readHoldingNewsCache();
    if (cache.result) {
      setHoldingNews(cache.result);
      setNewsStatus(cache.result.source === 'investing' ? 'live' : 'fallback');
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setNewsStatus('loading');
      void fetchHoldingNews(holdings, controller.signal)
        .then((result) => {
          writeHoldingNewsCache({ day: todayKey(), result });
          setHoldingNews(result);
          setNewsStatus(result.source === 'investing' ? 'live' : 'fallback');
        })
        .catch((error) => {
          console.warn('holding news failed', error);
          setNewsStatus(cache.result ? 'fallback' : 'error');
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [holdings]);

  useEffect(() => {
    const cache = readRiskAnalysisCache();
    if (cache.result) {
      setRiskAnalysis(cache.result);
      setRiskAnalysisStatus(cache.result.source === 'ai' ? 'ai' : 'fallback');
    }

    if (cache.count >= dailyRiskAnalysisLimit) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRiskAnalysisStatus('loading');
      void fetchRiskAnalysis({ holdings, summary, currency, quoteStatus, lastRefresh, ...aiConfigPayload(aiConfigState) }, controller.signal)
        .then((result) => {
          writeRiskAnalysisCache({ day: todayKey(), count: cache.count + 1, result });
          setRiskAnalysis(result);
          setRiskAnalysisStatus(result.source === 'ai' ? 'ai' : 'fallback');
        })
        .catch((error) => {
          console.warn('risk analysis failed, using hard alerts', error);
          writeRiskAnalysisCache({ day: todayKey(), count: cache.count + 1, result: cache.result });
          setRiskAnalysisStatus('error');
        });
    }, 450);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const risks = useMemo(() => {
    const hardAlerts = quoteStatus !== 'fallback' && quoteStatus !== 'error' ? baseRiskAlerts : [
      {
        level: '中' as const,
        title: '行情刷新失败',
        text: '当前页面正在使用截图导入价，稍后会继续每 10 秒自动重试。',
        icon: AlertTriangle,
      },
      ...baseRiskAlerts,
    ];

    if (!riskAnalysis) return hardAlerts;

    return riskAnalysis.alerts.map((risk) => ({
      ...risk,
      icon: riskAnalysis.source === 'ai' ? BrainCircuit : AlertTriangle,
    }));
  }, [quoteStatus, riskAnalysis]);

  const riskSummary = riskAnalysis?.summary ?? (riskAnalysisStatus === 'loading' ? '正在调用大模型生成持仓风险解读。' : '当前展示本地硬规则预警。');
  const newsItems = holdingNews?.items ?? [];
  const newsSummary = holdingNews?.summary ?? (newsStatus === 'loading' ? '正在从 Investing 抓取持仓相关新闻。' : '按当前持仓代码从 Investing 新闻源聚合相关新闻。');
  const newsFetchedAt = holdingNews?.fetchedAt ?? '';

  const context = {
    tab,
    setTab,
    currency,
    setCurrency,
    masked,
    setMasked,
    uploaded,
    setUploaded,
    confirmedRows,
    setConfirmedRows,
    lastRefresh,
    quoteStatus,
    quoteSessions,
    refresh,
    holdings,
    accountSnapshots: accountSnapshotsState,
    savedSnapshot,
    buyRecords: savedSnapshot?.buyRecords ?? [],
    sellRecords: savedSnapshot?.sellRecords ?? [],
    importLogs: savedSnapshot?.importLogs ?? [],
    saveDraftSnapshot,
    registerBuy,
    revokeBuy,
    registerSell,
    revokeSell,
    resetSnapshot,
    summary,
    aggregated,
    risks,
    riskSummary,
    riskAnalysisStatus,
    newsItems,
    newsSummary,
    newsStatus,
    newsFetchedAt,
    refreshNews,
    newsAiEnabled,
    setNewsAiEnabled,
    aiConfig: aiConfigState,
    setAiConfig,
  };

  return (
    <AppShell context={context}>
      <section className={`dashboard-grid dashboard-grid-${tab}`}>
        <div className="primary-column">
          <PortfolioSummaryCard context={context} />
          {tab !== 'trends' && tab !== 'ask' && <QuickNewsStrip items={newsItems} />}
          {tab === 'overview' && <OverviewPage context={context} />}
          {tab === 'holdings' && <HoldingsPage context={context} />}
          {tab === 'trends' && <TrendsPage context={context} />}
          {tab === 'ask' && <AskPage context={context} />}
          {tab === 'import' && <ImportPage context={context} />}
        </div>
        {tab !== 'trends' && tab !== 'ask' && (
          <aside className="fold-sidebar">
            <OverviewPage context={context} sidebar />
          </aside>
        )}
      </section>
    </AppShell>
  );
}

function createDefaultSnapshot(holdings: Holding[], accounts: typeof accountSnapshots): SavedSnapshot {
  const now = new Date().toISOString();
  return {
    revision: 0,
    source: 'default',
    savedAt: now,
    positionsUpdatedAt: now,
    accountPositionsUpdatedAt: Object.fromEntries(
      [...holdings, ...accounts].map((item) => [`${item.broker}::${item.account}::${item.market}`, now]),
    ),
    originalFileNames: [],
    warnings: [],
    holdings,
    accountSnapshots: accounts,
    buyRecords: [],
    sellRecords: [],
    importLogs: [],
  };
}
