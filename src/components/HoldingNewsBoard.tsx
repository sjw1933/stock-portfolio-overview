import { ChevronDown, ExternalLink, Newspaper, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AggregatedHolding, HoldingNewsItem, HoldingNewsStatus } from '../types';

const newsExpandedKey = 'gup-holding-news-expanded-v1';

const statusLabel: Record<HoldingNewsStatus, string> = {
  idle: '待加载',
  loading: '抓取中',
  live: 'Investing / Ticker',
  fallback: '市场新闻',
  error: '抓取失败',
};

function readNewsExpanded() {
  try {
    const raw = localStorage.getItem(newsExpandedKey);
    if (raw === null) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function HoldingNewsBoard({
  items,
  compact = false,
  summary,
  status,
  fetchedAt,
  holdings,
  onRefresh,
  aiEnabled,
  onAiEnabledChange,
}: {
  items: HoldingNewsItem[];
  compact?: boolean;
  summary: string;
  status: HoldingNewsStatus;
  fetchedAt: string;
  holdings: AggregatedHolding[];
  onRefresh: () => void;
  aiEnabled: boolean;
  onAiEnabledChange: (enabled: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(readNewsExpanded);
  const [activeSymbol, setActiveSymbol] = useState('ALL');
  const symbolCounts = useMemo(() => buildSymbolCounts(items, holdings), [items, holdings]);
  const filteredItems = activeSymbol === 'ALL' ? items : items.filter((item) => matchesNewsSymbol(item, activeSymbol));
  const visibleItems = filteredItems.slice(0, compact ? 5 : 8);
  const statusText = fetchedAt ? `最后更新 ${formatFetchedAt(fetchedAt)}` : statusLabel[status];

  useEffect(() => {
    if (activeSymbol !== 'ALL' && !symbolCounts.some((item) => item.symbol === activeSymbol)) setActiveSymbol('ALL');
  }, [activeSymbol, symbolCounts]);

  function toggleExpanded() {
    setExpanded((current) => {
      const next = !current;
      try {
        localStorage.setItem(newsExpandedKey, String(next));
      } catch {
        // Ignore private-mode storage failures.
      }
      return next;
    });
  }

  return (
    <section className={`panel news-board ${compact ? 'compact' : ''} ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <div className="news-board-head">
        <button
          type="button"
          className="news-collapse-toggle"
          aria-expanded={expanded}
          aria-controls="holding-news-body"
          onClick={toggleExpanded}
        >
          <span className="news-collapse-title">
            <Newspaper size={19} aria-hidden="true" />
            <span>
              <b>持仓相关新闻</b>
              <em>{statusText} · {items.length} 条</em>
            </span>
          </span>
          <span className="news-collapse-meta">
            <span className="news-collapse-hint">{expanded ? '收起' : '展开'}</span>
            <ChevronDown size={18} className={`news-collapse-chevron ${expanded ? 'open' : ''}`} aria-hidden="true" />
          </span>
        </button>
      </div>

      {expanded && (
        <div className="news-board-body" id="holding-news-body">
          <div className="news-actions" aria-label="新闻分析设置">
            <button type="button" className="news-refresh-button" onClick={onRefresh} disabled={status === 'loading'}>
              <RefreshCw size={15} />
              刷新新闻
            </button>
            <button
              type="button"
              className={`news-ai-toggle ${aiEnabled ? 'active' : ''}`}
              aria-pressed={aiEnabled}
              onClick={() => onAiEnabledChange(!aiEnabled)}
            >
              <Sparkles size={16} />
              AI分析：{aiEnabled ? '开' : '关'}
            </button>
          </div>
          <div className="news-filter-pills" aria-label="按持仓筛选新闻">
            <button type="button" className={activeSymbol === 'ALL' ? 'active' : ''} onClick={() => setActiveSymbol('ALL')}>全部 {items.length}</button>
            {symbolCounts.map((item) => (
              <button type="button" key={item.symbol} className={activeSymbol === item.symbol ? 'active' : ''} onClick={() => setActiveSymbol(item.symbol)}>
                {shortSymbol(item.symbol)} {item.count}
              </button>
            ))}
          </div>
          {!compact && aiEnabled && <p className={`news-summary ${status === 'loading' ? 'loading' : ''}`}>{summary}</p>}
          {visibleItems.length ? visibleItems.map((item) => (
            <a className="news-item" href={item.url} target="_blank" rel="noreferrer" key={item.id}>
              <div className="news-symbol">{item.symbol}</div>
              <div>
                <b>{item.title}</b>
                <p>{formatMeta(item)}</p>
                {aiEnabled && item.analysis && (
                  <div className="news-ai-result">
                    <em className={stanceClass(item.analysis.stance)}>AI总结：{item.analysis.stance} · {item.analysis.impact}</em>
                  </div>
                )}
              </div>
              <ExternalLink size={16} />
            </a>
          )) : (
            <div className="news-empty">
              <b>暂未抓到相关新闻</b>
              <p>稍后会继续刷新；也可以点趋势页查看单标的行情。</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function buildSymbolCounts(items: HoldingNewsItem[], holdings: AggregatedHolding[]) {
  return holdings
    .map((holding) => ({
      symbol: holding.symbol,
      count: items.filter((item) => matchesNewsSymbol(item, holding.symbol)).length,
    }))
    .filter((item) => item.count > 0)
    .slice(0, 8);
}

function matchesNewsSymbol(item: HoldingNewsItem, symbol: string) {
  const normalized = symbol.toUpperCase();
  const ticker = shortSymbol(normalized);
  const matchedBy = item.matchedBy.map((value) => value.toUpperCase());
  return item.symbol.toUpperCase() === normalized || item.symbol.toUpperCase() === ticker || matchedBy.includes(normalized) || matchedBy.includes(ticker);
}

function shortSymbol(symbol: string) {
  return symbol.replace(/\.US$|\.HK$/, '');
}

function formatFetchedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function stanceClass(stance: HoldingNewsItem['analysis'] extends infer Analysis ? Analysis extends { stance: infer Stance } ? Stance : never : never) {
  if (stance === '利好') return 'pos';
  if (stance === '利空') return 'neg';
  return 'neu';
}

function formatMeta(item: HoldingNewsItem) {
  const time = item.publishedAt ? new Date(item.publishedAt) : null;
  const timeText = time && !Number.isNaN(time.getTime())
    ? time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    : '时间未知';
  const matched = item.matchedBy.length ? ` · 命中 ${item.matchedBy.slice(0, 2).join('/')}` : '';
  return `${item.source} · ${timeText}${matched}`;
}
