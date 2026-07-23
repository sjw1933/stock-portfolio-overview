import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, LineChart, RefreshCw } from 'lucide-react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PanelTitle } from '../components/PanelTitle';
import type { AppContext } from '../appContext';
import type { SellRecord } from '../types';
import { supportsMarketHistory, fetchMarketHistory, type TrendPeriod, type TrendPoint, type TrendSeries } from '../utils/marketHistory';

const periods: Array<{ key: TrendPeriod; label: string }> = [
  { key: 'minute', label: '分时' },
  { key: 'fiveDay', label: '5日' },
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
];

export function TrendsPage({ context }: { context: AppContext }) {
  const trendHoldings = useMemo(() => {
    const map = new Map(context.aggregated.map((holding) => [holding.symbol, holding]));
    for (const record of context.sellRecords) {
      if (!map.has(record.symbol)) {
        map.set(record.symbol, {
          ...record,
          type: record.holdingType,
          qty: 0,
          price: record.positionPriceAtSell,
          cost: record.costAtSell,
          todayPnl: 0,
          totalPnl: 0,
          rows: [],
          marketValue: 0,
        });
      }
    }
    return Array.from(map.values());
  }, [context.aggregated, context.sellRecords]);
  const defaultSymbol = trendHoldings.find((holding) => supportsMarketHistory(holding.symbol))?.symbol ?? trendHoldings[0]?.symbol ?? '';
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [period, setPeriod] = useState<TrendPeriod>('minute');
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const selectedHolding = useMemo(
    () => trendHoldings.find((holding) => holding.symbol === symbol) ?? trendHoldings[0],
    [symbol, trendHoldings],
  );
  const canLoad = Boolean(selectedHolding && supportsMarketHistory(selectedHolding.symbol));
  const isMinuteSupported = selectedHolding ? isMinuteCapable(selectedHolding.symbol) : false;
  const availablePeriods = useMemo(
    () => new Set<TrendPeriod>(isMinuteSupported ? periods.map((item) => item.key) : ['day', 'week', 'month']),
    [isMinuteSupported],
  );

  useEffect(() => {
    if (!availablePeriods.has(period)) setPeriod('day');
  }, [availablePeriods, period]);

  useEffect(() => {
    if (!selectedHolding || !canLoad) {
      setSeries(null);
      setStatus('error');
      setError('该标的历史行情待接入。');
      return;
    }

    const controller = new AbortController();
    setStatus('loading');
    setError('');
    void fetchMarketHistory(selectedHolding.symbol, period, controller.signal)
      .then((result) => {
        setSeries(result);
        setStatus('ready');
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setSeries(null);
        setStatus('error');
        setError(reason instanceof Error ? reason.message : '行情加载失败');
      });

    return () => controller.abort();
  }, [selectedHolding, canLoad, period]);

  return (
    <div className="page-stack market-page">
      <section className="panel market-panel">
        <PanelTitle icon={LineChart} title="持仓单票行情" action={status === 'ready' ? `更新 ${series?.fetchedAt}` : status === 'loading' ? '加载中' : '待接入'} />
        <div className="symbol-tabs" aria-label="持仓选择">
          {trendHoldings.map((holding) => {
            const supported = supportsMarketHistory(holding.symbol);
            return (
              <button
                type="button"
                key={holding.symbol}
                className={holding.symbol === selectedHolding?.symbol ? 'active' : ''}
                disabled={!supported}
                onClick={() => setSymbol(holding.symbol)}
              >
                <b>{holding.name}</b>
                <span>{holding.symbol}{holding.qty === 0 ? ' · 已清仓' : supported ? isMinuteCapable(holding.symbol) ? ' · 全周期' : ' · 日周月' : ' · 待接入'}</span>
              </button>
            );
          })}
        </div>

        <div className="period-tabs" aria-label="周期选择">
          {periods.map((item) => {
            const available = availablePeriods.has(item.key);
            return (
            <button type="button" key={item.key} className={period === item.key ? 'active' : ''} disabled={!available} onClick={() => setPeriod(item.key)}>
              {item.label}{available ? '' : '待'}
            </button>
            );
          })}
        </div>

        {status === 'ready' && series ? (
          <MarketChart
            series={series}
            name={selectedHolding?.name ?? series.symbol}
            cost={selectedHolding?.qty ? selectedHolding.cost : undefined}
            sellRecords={context.sellRecords.filter((record) => record.symbol === series.symbol && record.status === 'active')}
          />
        ) : (
          <div className="trend-state">
            {status === 'loading' ? <RefreshCw size={22} /> : <Activity size={22} />}
            <b>{status === 'loading' ? '正在读取真实行情' : '暂不可用'}</b>
            <p>{status === 'loading' ? '正在连接真实行情接口，生成价格、成交量和 RSI。' : error}</p>
          </div>
        )}
      </section>

      <section className="panel market-note-panel">
        <PanelTitle icon={BarChart3} title="图表说明" action="真实行情" />
        <div className="market-notes">
          <p>港股和美股支持分时、5日、日K、周K、月K；美股 5 日当前按最近 5 个交易日展示。</p>
          <p>如果新导入的美股代码在数据源没有历史行情，会显示数据源返回的错误，而不是需要手工接入。</p>
          <p>蓝色虚线为当前持仓加权成本价；红色“卖”标记来自手工确认的有效卖出记录。</p>
          <p>成交量按分钟或周期展示，RSI 使用 6、12、24 三组参数在前端计算。</p>
        </div>
      </section>
    </div>
  );
}

function isMinuteCapable(symbol: string) {
  return symbol.endsWith('.HK') || symbol.endsWith('.US');
}

function MarketChart({ series, name, cost, sellRecords }: { series: TrendSeries; name: string; cost?: number; sellRecords: SellRecord[] }) {
  const latest = series.points[series.points.length - 1];
  const priceColor = series.change >= 0 ? '#10a77a' : '#ef476f';
  const changePrefix = series.change >= 0 ? '+' : '';
  const volumeMax = Math.max(...series.points.map((point) => point.volume));
  const costPrice = Number.isFinite(cost) && cost && cost > 0 ? cost : undefined;
  const saleMarkers = buildSaleMarkers(series, sellRecords);

  return (
    <div className="market-chart-wrap">
      <div className="market-headline">
        <div>
          <span>{name} · {series.symbol}</span>
          <strong>{series.latest.toFixed(3)}</strong>
        </div>
        <div className={series.change >= 0 ? 'pos' : 'neg'}>
          <b>{changePrefix}{series.change.toFixed(3)}</b>
          <span>{changePrefix}{series.changePct.toFixed(2)}%</span>
        </div>
      </div>

      <div className="market-meta">
        <span>均价 <b>{series.average?.toFixed(3) ?? '--'}</b></span>
        <span>买入成本 <b>{costPrice?.toFixed(3) ?? '--'}</b></span>
        <span>VOL <b>{formatVolume(series.totalVolume)}</b></span>
      </div>

      <ResponsiveContainer width="100%" height={340}>
        <ComposedChart data={series.points} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={priceColor} stopOpacity={0.18} />
              <stop offset="100%" stopColor={priceColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#edf1f6" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={46} tick={{ fill: '#6b7280', fontSize: 12 }} />
          <YAxis yAxisId="price" width={64} domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} />
          <YAxis yAxisId="volume" orientation="right" hide domain={[0, volumeMax || 1]} />
          <Tooltip content={<MarketTooltip />} />
          <Area yAxisId="price" type="monotone" dataKey="price" stroke={priceColor} strokeWidth={2.2} fill="url(#priceFill)" dot={false} activeDot={{ r: 3 }} />
          <Line yAxisId="price" type="monotone" dataKey="avg" stroke="#f4c430" strokeWidth={2} dot={false} connectNulls />
          {latest && <ReferenceLine yAxisId="price" y={latest.price} stroke={priceColor} strokeDasharray="5 5" strokeOpacity={0.65} />}
          {costPrice && (
            <ReferenceLine
              yAxisId="price"
              y={costPrice}
              stroke="#2563eb"
              strokeDasharray="7 5"
              strokeOpacity={0.9}
              label={{ value: `买入成本 ${costPrice.toFixed(2)}`, position: 'insideTopRight', fill: '#2563eb', fontSize: 12, fontWeight: 800 }}
            />
          )}
          {saleMarkers.map((marker) => (
            <ReferenceDot
              key={marker.record.id}
              yAxisId="price"
              x={marker.point.label}
              y={marker.record.price}
              r={5}
              fill="#ef476f"
              stroke="#ffffff"
              strokeWidth={2}
              label={{ value: '卖', position: 'top', fill: '#c51f46', fontSize: 12, fontWeight: 900 }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      {saleMarkers.length > 0 && (
        <div className="chart-sale-markers">
          {saleMarkers.map(({ record }) => (
            <div key={record.id}>
              <span>卖</span>
              <b>{new Date(record.tradedAt).toLocaleDateString('zh-CN')} · {record.price.toFixed(3)} {record.currency}</b>
              <em>{record.qty.toLocaleString('zh-CN', { maximumFractionDigits: 4 })} 股 · 已实现 {record.realizedPnl >= 0 ? '+' : ''}{record.realizedPnl.toFixed(2)}</em>
            </div>
          ))}
        </div>
      )}

      <div className="volume-chart">
        <ResponsiveContainer width="100%" height={112}>
          <ComposedChart data={series.points} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#edf1f6" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={56} tick={{ fill: '#6b7280', fontSize: 12 }} />
            <YAxis hide />
            <Tooltip content={<VolumeTooltip />} />
            <Bar dataKey="volume" radius={[2, 2, 0, 0]}>
              {series.points.map((point) => (
                <Cell key={point.key} fill={point.direction === 'up' ? '#10a77a' : '#ef476f'} opacity={0.78} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="rsi-title">
        <b>RSI</b>
        <span className="rsi6">6:{formatIndicator(latest?.rsi6)}</span>
        <span className="rsi12">12:{formatIndicator(latest?.rsi12)}</span>
        <span className="rsi24">24:{formatIndicator(latest?.rsi24)}</span>
      </div>
      <ResponsiveContainer width="100%" height={126}>
        <ComposedChart data={series.points} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#edf1f6" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={60} tick={{ fill: '#6b7280', fontSize: 12 }} />
          <YAxis width={38} domain={[0, 100]} tickLine={false} axisLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} />
          <Tooltip content={<RsiTooltip />} />
          <ReferenceLine y={80} stroke="#6b7280" strokeDasharray="4 4" />
          <ReferenceLine y={20} stroke="#6b7280" strokeDasharray="4 4" strokeOpacity={0.55} />
          <Line type="monotone" dataKey="rsi6" stroke="#e85d4f" dot={false} strokeWidth={1.8} connectNulls />
          <Line type="monotone" dataKey="rsi12" stroke="#2f80ed" dot={false} strokeWidth={1.8} connectNulls />
          <Line type="monotone" dataKey="rsi24" stroke="#8e44ad" dot={false} strokeWidth={1.8} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function buildSaleMarkers(series: TrendSeries, records: SellRecord[]) {
  return records.flatMap((record) => {
    const tradeDate = record.tradedAt.slice(0, 10);
    const exact = series.points.filter((point) => point.date === tradeDate);
    const point = exact[exact.length - 1] ?? nearestDatedPoint(series.points, tradeDate);
    return point ? [{ point, record }] : [];
  });
}

function nearestDatedPoint(points: TrendPoint[], date: string) {
  const target = new Date(`${date}T12:00:00Z`).getTime();
  const dated = points.filter((point) => point.date && !Number.isNaN(new Date(`${point.date}T12:00:00Z`).getTime()));
  if (!dated.length) return undefined;
  const point = dated.reduce((closest, candidate) => {
    const closestDistance = Math.abs(new Date(`${closest.date}T12:00:00Z`).getTime() - target);
    const candidateDistance = Math.abs(new Date(`${candidate.date}T12:00:00Z`).getTime() - target);
    return candidateDistance < closestDistance ? candidate : closest;
  });
  const distanceDays = Math.abs(new Date(`${point.date}T12:00:00Z`).getTime() - target) / 86400000;
  return distanceDays <= (seriesPeriodTolerance(points) ?? 4) ? point : undefined;
}

function seriesPeriodTolerance(points: TrendPoint[]) {
  if (points.length < 2) return 4;
  const first = points.find((point) => point.date)?.date;
  const last = [...points].reverse().find((point) => point.date)?.date;
  if (!first || !last) return 4;
  const span = Math.abs(new Date(last).getTime() - new Date(first).getTime()) / 86400000;
  return Math.max(4, Math.ceil(span / points.length) * 2);
}

function MarketTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as TrendPoint;
  return (
    <div className="chart-tooltip">
      <b>{label}</b>
      <span>价格 {point.price.toFixed(3)}</span>
      {point.avg ? <span>均价 {point.avg.toFixed(3)}</span> : null}
      <span>成交量 {formatVolume(point.volume)}</span>
    </div>
  );
}

function VolumeTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as TrendPoint;
  return (
    <div className="chart-tooltip">
      <b>{label}</b>
      <span>成交量 {formatVolume(point.volume)}</span>
    </div>
  );
}

function RsiTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as TrendPoint;
  return (
    <div className="chart-tooltip">
      <b>{label}</b>
      <span>RSI6 {formatIndicator(point.rsi6)}</span>
      <span>RSI12 {formatIndicator(point.rsi12)}</span>
      <span>RSI24 {formatIndicator(point.rsi24)}</span>
    </div>
  );
}

function formatVolume(value: number) {
  if (value >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return value.toLocaleString('zh-CN');
}

function formatIndicator(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '--';
}

type TooltipProps = {
  active?: boolean;
  payload?: Array<{ payload: unknown }>;
  label?: string;
};
