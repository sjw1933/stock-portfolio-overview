import { useEffect, useMemo, useState } from 'react';
import { ArrowDownUp, CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { AppContext } from '../appContext';
import {
  aggregateReturns,
  buildDailyReturns,
  buildLiveTodayDetails,
  formatDotDate,
  formatReturnPct,
  formatReturnPctCell,
  formatReturnUsdCell,
  formatReturnUsdFull,
  localDateKey,
  monthMatrix,
  type AggregatedReturnPoint,
  type DailyReturnPoint,
  type ReturnDetailRow,
  type ReturnGranularity,
  type ReturnUnit,
} from '../utils/returnsCalendar';

const weekLabels = ['日', '一', '二', '三', '四', '五', '六'];
const granularityOptions: Array<{ key: ReturnGranularity; label: string }> = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
];

export function ReturnsPage({ context }: { context: AppContext }) {
  const [granularity, setGranularity] = useState<ReturnGranularity>('day');
  const [unit, setUnit] = useState<ReturnUnit>('usd');
  const [sortDesc, setSortDesc] = useState(true);
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [daily, setDaily] = useState<DailyReturnPoint[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorText, setErrorText] = useState('');
  const [fetchedAt, setFetchedAt] = useState('');

  const structureKey = useMemo(
    () => context.holdings.map((item) => `${item.symbol}:${item.qty}:${item.currency}`).sort().join('|'),
    [context.holdings],
  );
  const ledgerKey = useMemo(
    () => [
      context.buyRecords.length,
      context.sellRecords.length,
      context.importLogs.length,
      context.savedSnapshot?.revision ?? 0,
      context.savedSnapshot?.positionsUpdatedAt ?? '',
      context.savedSnapshot?.savedAt ?? '',
    ].join(':'),
    [
      context.buyRecords.length,
      context.sellRecords.length,
      context.importLogs.length,
      context.savedSnapshot?.revision,
      context.savedSnapshot?.positionsUpdatedAt,
      context.savedSnapshot?.savedAt,
    ],
  );

  async function loadReturns(signal?: AbortSignal) {
    const today = localDateKey();
    const points = await buildDailyReturns({
      holdings: context.holdings,
      buyRecords: context.buyRecords,
      sellRecords: context.sellRecords,
      importLogs: context.importLogs,
      positionsUpdatedAt: context.savedSnapshot?.positionsUpdatedAt,
      savedAt: context.savedSnapshot?.savedAt,
      signal,
      liveToday: null,
    });
    const liveDetails = buildLiveTodayDetails(context.holdings);
    const pnlUsd = liveDetails.reduce((sum, row) => sum + row.pnlUsd, 0);
    const baseUsd = liveDetails.reduce((sum, row) => sum + row.baseUsd, 0);
    const livePoint: DailyReturnPoint = {
      date: today,
      pnlUsd,
      baseUsd,
      percent: baseUsd > 0.000001 ? (pnlUsd / baseUsd) * 100 : null,
      details: liveDetails,
    };
    const withoutToday = points.filter((point) => point.date !== today);
    return [...withoutToday, livePoint].sort((a, b) => a.date.localeCompare(b.date));
  }

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setErrorText('');
    void loadReturns(controller.signal)
      .then((points) => {
        if (controller.signal.aborted) return;
        setDaily(points);
        setStatus('ready');
        setFetchedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        setSelectedKey((current) => current ?? points[points.length - 1]?.date ?? localDateKey());
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn('returns calendar failed', error);
        setStatus('error');
        setErrorText(error instanceof Error ? error.message : '收益日历加载失败');
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, ledgerKey]);

  const liveTodayKey = useMemo(
    () => context.holdings.map((item) => `${item.symbol}:${item.todayPnl.toFixed(4)}`).join('|'),
    [context.holdings],
  );
  useEffect(() => {
    if (status !== 'ready') return;
    const today = localDateKey();
    const liveDetails = buildLiveTodayDetails(context.holdings);
    const pnlUsd = liveDetails.reduce((sum, row) => sum + row.pnlUsd, 0);
    const baseUsd = liveDetails.reduce((sum, row) => sum + row.baseUsd, 0);
    setDaily((current) => {
      const nextPoint: DailyReturnPoint = {
        date: today,
        pnlUsd,
        baseUsd,
        percent: baseUsd > 0.000001 ? (pnlUsd / baseUsd) * 100 : null,
        details: liveDetails,
      };
      const others = current.filter((point) => point.date !== today);
      return [...others, nextPoint].sort((a, b) => a.date.localeCompare(b.date));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveTodayKey, status]);

  const aggregated = useMemo(
    () => aggregateReturns(daily, granularity),
    [daily, granularity],
  );

  const visiblePoints = useMemo(() => {
    if (granularity === 'day') {
      const prefix = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`;
      return aggregated.filter((item) => item.key.startsWith(prefix));
    }
    if (granularity === 'week' || granularity === 'month') {
      return aggregated.filter((item) => item.startDate.startsWith(String(cursor.year)) || item.key.startsWith(String(cursor.year)));
    }
    return aggregated;
  }, [aggregated, cursor.month, cursor.year, granularity]);

  const pointByKey = useMemo(() => {
    const map = new Map<string, AggregatedReturnPoint>();
    for (const item of aggregated) map.set(item.key, item);
    return map;
  }, [aggregated]);

  const selected = useMemo(() => {
    if (selectedKey && pointByKey.has(selectedKey)) return pointByKey.get(selectedKey) ?? null;
    if (selectedKey) {
      const byDate = aggregated.find((item) => selectedKey >= item.startDate && selectedKey <= item.endDate);
      if (byDate) return byDate;
    }
    return visiblePoints[visiblePoints.length - 1] ?? null;
  }, [aggregated, pointByKey, selectedKey, visiblePoints]);

  const monthDays = useMemo(
    () => monthMatrix(cursor.year, cursor.month),
    [cursor.month, cursor.year],
  );

  const periodTotal = useMemo(() => {
    const pnlUsd = visiblePoints.reduce((sum, item) => sum + item.pnlUsd, 0);
    const base = visiblePoints[0]?.baseUsd ?? 0;
    const winDays = visiblePoints.reduce((sum, item) => sum + item.winDays, 0);
    const dayCount = visiblePoints.reduce((sum, item) => sum + item.dayCount, 0);
    return {
      pnlUsd,
      percent: base > 0.000001 ? (pnlUsd / base) * 100 : null,
      winDays,
      dayCount,
    };
  }, [visiblePoints]);

  const sortedDetails = useMemo(() => {
    const rows = selected?.details ? [...selected.details] : [];
    rows.sort((a, b) => (sortDesc ? b.pnlUsd - a.pnlUsd : a.pnlUsd - b.pnlUsd));
    return rows;
  }, [selected, sortDesc]);

  function shiftCursor(delta: number) {
    setCursor((current) => {
      if (granularity === 'day') {
        const date = new Date(current.year, current.month + delta, 1);
        return { year: date.getFullYear(), month: date.getMonth() };
      }
      return { year: current.year + delta, month: current.month };
    });
  }

  function displayCell(point: { pnlUsd: number; percent: number | null } | undefined) {
    if (!point) {
      return unit === 'pct' ? '0.00%' : '$0';
    }
    return unit === 'pct'
      ? formatReturnPctCell(point.percent, context.masked)
      : formatReturnUsdCell(point.pnlUsd, context.masked);
  }

  function displayValue(point: { pnlUsd: number; percent: number | null }) {
    return unit === 'pct'
      ? formatReturnPct(point.percent, context.masked)
      : formatReturnUsdFull(point.pnlUsd, context.masked);
  }

  /** Green profit / red loss (product rule); soft pastel cells like the reference calendar. */
  function toneClass(value: number) {
    if (value > 0.000001) return 'pos';
    if (value < -0.000001) return 'neg';
    return 'flat';
  }

  function refresh() {
    setStatus('loading');
    void loadReturns()
      .then((points) => {
        setDaily(points);
        setStatus('ready');
        setFetchedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
      })
      .catch((error: unknown) => {
        setStatus('error');
        setErrorText(error instanceof Error ? error.message : '收益日历加载失败');
      });
  }

  return (
    <div className="page-stack returns-page">
      <section className="returns-card">
        <header className="returns-card-head">
          <div>
            <h2>收益日历</h2>
            <p>
              {status === 'loading' && '加载历史行情…'}
              {status === 'error' && (errorText || '加载失败')}
              {status === 'ready' && (fetchedAt ? `更新 ${fetchedAt} · 估算` : '估算收益')}
            </p>
          </div>
          <button type="button" className="returns-icon-btn" onClick={refresh} disabled={status === 'loading'} aria-label="刷新">
            <RefreshCw size={16} />
          </button>
        </header>

        <div className="returns-controls">
          <div className="returns-pill-group" aria-label="收益周期">
            {granularityOptions.map((item) => (
              <button
                key={item.key}
                type="button"
                className={granularity === item.key ? 'active' : ''}
                onClick={() => {
                  setGranularity(item.key);
                  if (item.key === 'day' && selected) setSelectedKey(selected.endDate);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="returns-unit-group" aria-label="收益单位">
            <button type="button" className={unit === 'usd' ? 'active' : ''} onClick={() => setUnit('usd')}>$</button>
            <button type="button" className={unit === 'pct' ? 'active' : ''} onClick={() => setUnit('pct')}>%</button>
          </div>
        </div>

        <div className="returns-month-nav">
          <button type="button" onClick={() => shiftCursor(-1)} aria-label="上一期">
            <ChevronLeft size={18} />
          </button>
          <strong>
            {granularity === 'day'
              ? `${cursor.year}年${cursor.month + 1}月`
              : granularity === 'year'
                ? '全部年份'
                : `${cursor.year}年`}
          </strong>
          <button type="button" onClick={() => shiftCursor(1)} aria-label="下一期">
            <ChevronRight size={18} />
          </button>
        </div>

        <div className={`returns-strip ${toneClass(periodTotal.pnlUsd)}`}>
          <span>本期合计</span>
          <b>{displayValue(periodTotal)}</b>
          <em>{periodTotal.winDays}/{periodTotal.dayCount || 0} 盈</em>
        </div>

        {status === 'error' && <div className="returns-empty">{errorText || '收益日历加载失败'}</div>}
        {status === 'loading' && !daily.length && <div className="returns-empty">正在按持仓拉取日线并估算收益…</div>}

        {granularity === 'day' ? (
          <div className="returns-calendar" role="grid" aria-label="日收益日历">
            <div className="returns-weekdays">
              {weekLabels.map((label) => <span key={label}>{label}</span>)}
            </div>
            {monthDays.map((week, weekIndex) => (
              <div className="returns-week" key={`w-${weekIndex}`}>
                {week.map((date, dayIndex) => {
                  if (!date) return <div key={`e-${weekIndex}-${dayIndex}`} className="returns-day empty" />;
                  const point = pointByKey.get(date);
                  const value = point?.pnlUsd ?? 0;
                  const selectedDay = selected?.key === date || selectedKey === date;
                  return (
                    <button
                      key={date}
                      type="button"
                      className={[
                        'returns-day',
                        toneClass(value),
                        !point ? 'flat' : '',
                        selectedDay ? 'selected' : '',
                        date === localDateKey() ? 'today' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => setSelectedKey(date)}
                    >
                      <em>{Number(date.slice(8))}</em>
                      <strong>{displayCell(point)}</strong>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="returns-period-grid" aria-label={`${granularity}收益列表`}>
            {visiblePoints.length === 0 && status === 'ready' && (
              <div className="returns-empty">该周期暂无估算收益</div>
            )}
            {visiblePoints.map((point) => (
              <button
                key={point.key}
                type="button"
                className={[
                  'returns-period-card',
                  toneClass(point.pnlUsd),
                  selected?.key === point.key ? 'selected' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setSelectedKey(point.key)}
              >
                <span>{point.label}</span>
                <b>{displayCell(point)}</b>
                <em>{point.winDays}/{point.dayCount} 盈</em>
              </button>
            ))}
          </div>
        )}

        <p className="returns-footnote">
          仅从首次买入/导入/快照日起估算（日线 × 可还原仓位）；不会把当前持仓套到更早月份。今日用实时盈亏，非正式对账单。
        </p>
      </section>

      <section className="returns-card returns-detail-card">
        <header className="returns-detail-head-row">
          <h2>
            {detailTitle(selected, granularity)}
            {selected && (
              <span>
                {' '}
                (
                {selected.startDate === selected.endDate
                  ? formatDotDate(selected.startDate)
                  : `${formatDotDate(selected.startDate)}-${formatDotDate(selected.endDate)}`}
                )
              </span>
            )}
          </h2>
          <button
            type="button"
            className="returns-sort-btn"
            onClick={() => setSortDesc((value) => !value)}
            aria-label="盈亏排序"
          >
            盈亏排序
            <ArrowDownUp size={14} />
          </button>
        </header>

        {!selected && <div className="returns-empty">选择上方日期或周期查看明细</div>}

        {selected && (
          <>
            <div className={`returns-detail-total ${toneClass(selected.pnlUsd)}`}>
              <div>
                <span>收益</span>
                <b>{formatReturnUsdFull(selected.pnlUsd, context.masked)}</b>
              </div>
              <div>
                <span>收益率</span>
                <b>{formatReturnPct(selected.percent, context.masked)}</b>
              </div>
            </div>

            <ul className="returns-detail-list">
              {sortedDetails.length === 0 && (
                <li className="returns-empty-state">
                  <CalendarDays size={36} strokeWidth={1.5} />
                  <p>当日暂无持仓收益明细</p>
                </li>
              )}
              {sortedDetails.map((row) => (
                <DetailRow key={row.symbol} row={row} unit={unit} masked={context.masked} toneClass={toneClass} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function DetailRow({
  row,
  unit,
  masked,
  toneClass,
}: {
  row: ReturnDetailRow;
  unit: ReturnUnit;
  masked: boolean;
  toneClass: (value: number) => string;
}) {
  return (
    <li>
      <div className="returns-detail-main">
        <b>{row.symbol.replace(/\.US$|\.HK$/i, '')}</b>
        <span>{row.name}</span>
      </div>
      <div className={`returns-detail-values ${toneClass(row.pnlUsd)}`}>
        <strong>
          {unit === 'pct'
            ? formatReturnPct(row.percent, masked)
            : formatReturnUsdFull(row.pnlUsd, masked)}
        </strong>
        <em>
          {unit === 'pct'
            ? formatReturnUsdFull(row.pnlUsd, masked)
            : formatReturnPct(row.percent, masked)}
          {' · '}
          {masked
            ? '**** 股'
            : row.qtySod === row.qtyEod
              ? `${row.qtyEod.toLocaleString('zh-CN', { maximumFractionDigits: 4 })} 股`
              : `${row.qtySod.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}→${row.qtyEod.toLocaleString('zh-CN', { maximumFractionDigits: 4 })} 股`}
        </em>
      </div>
    </li>
  );
}

function detailTitle(point: AggregatedReturnPoint | null, granularity: ReturnGranularity) {
  if (!point) return '收益明细';
  if (granularity === 'day') return '当日收益明细';
  if (granularity === 'week') return '当周收益明细';
  if (granularity === 'month') return '当月收益明细';
  return '当年收益明细';
}
