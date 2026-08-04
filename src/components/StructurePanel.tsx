import { useEffect, useMemo, useRef, useState } from 'react';
import { PieChart } from 'lucide-react';
import { Cell, Pie, PieChart as RePieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { AppContext } from '../appContext';
import type { AggregatedHolding, Currency } from '../types';
import { PanelTitle } from './PanelTitle';
import { convert, money } from '../utils/currency';

/** Structure chart freezes market-value weights between ticks. */
const structureRefreshMs = 10 * 60 * 1000;

/** Distinct hues so adjacent holdings stay easy to tell apart. */
const palette = [
  '#1769e8', // blue
  '#e4485f', // rose
  '#0d9488', // teal
  '#d97706', // amber
  '#7c3aed', // violet
  '#059669', // green
  '#ea580c', // orange
  '#0891b2', // cyan
  '#db2777', // pink
  '#4f46e5', // indigo
  '#65a30d', // lime
  '#c026d3', // fuchsia
];

function shortSymbol(symbol: string) {
  return symbol.replace(/\.US$|\.HK$/i, '');
}

type PieSlice = {
  key: string;
  name: string;
  fullName: string;
  value: number;
  percent: number;
  color: string;
};

type StructureSnapshotRow = {
  symbol: string;
  name: string;
  marketValue: number;
  currency: AggregatedHolding['currency'];
};

function holdingsStructureKey(holdings: AggregatedHolding[]) {
  return holdings
    .map((item) => `${item.symbol}:${item.qty}:${item.currency}`)
    .sort()
    .join('|');
}

function buildSnapshot(holdings: AggregatedHolding[]): StructureSnapshotRow[] {
  return holdings.map((item) => ({
    symbol: item.symbol,
    name: item.name,
    marketValue: item.marketValue,
    currency: item.currency,
  }));
}

function buildPieData(rows: StructureSnapshotRow[], currency: Currency) {
  const slices = rows
    .map((item, index) => {
      const value = convert(item.marketValue, item.currency, currency);
      return {
        key: item.symbol,
        name: shortSymbol(item.symbol),
        fullName: item.name,
        value,
        percent: 0,
        color: palette[index % palette.length],
      };
    })
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = slices.reduce((sum, item) => sum + item.value, 0);
  const pieData: PieSlice[] = slices.map((item, index) => ({
    ...item,
    percent: total > 0.000001 ? item.value / total : 0,
    color: palette[index % palette.length],
  }));

  return { pieData, gross: total };
}

function PieSliceLabel(props: {
  cx?: number;
  cy?: number;
  midAngle?: number;
  outerRadius?: number;
  percent?: number;
  name?: string;
  payload?: PieSlice;
}) {
  const { cx, cy, midAngle, outerRadius, percent, name, payload } = props;
  if (
    cx == null
    || cy == null
    || midAngle == null
    || outerRadius == null
    || percent == null
    || !name
  ) {
    return null;
  }

  // Tiny slices: keep the chart clean; tooltip still has full detail.
  if (percent < 0.035) return null;

  const RADIAN = Math.PI / 180;
  const radius = outerRadius + 16;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  const anchor = x >= cx ? 'start' : 'end';
  const pct = (percent * 100).toFixed(0);
  const color = payload?.color || '#0f172a';

  return (
    <g style={{ pointerEvents: 'none' }}>
      <text
        x={x}
        y={y - 6}
        fill={color}
        textAnchor={anchor}
        dominantBaseline="central"
        fontSize={11}
        fontWeight={800}
        stroke="#ffffff"
        strokeWidth={3}
        paintOrder="stroke"
      >
        {name}
      </text>
      <text
        x={x}
        y={y + 8}
        fill="#0f172a"
        textAnchor={anchor}
        dominantBaseline="central"
        fontSize={11}
        fontWeight={800}
        stroke="#ffffff"
        strokeWidth={3}
        paintOrder="stroke"
      >
        {pct}%
      </text>
    </g>
  );
}

function formatStructureTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function StructurePanel({ context }: { context: AppContext }) {
  const currency = context.currency;
  const latestHoldingsRef = useRef(context.aggregated);
  latestHoldingsRef.current = context.aggregated;

  const structureKey = useMemo(
    () => holdingsStructureKey(context.aggregated),
    [context.aggregated],
  );

  const [snapshotRows, setSnapshotRows] = useState<StructureSnapshotRow[]>(() => buildSnapshot(context.aggregated));
  const [snapshotAt, setSnapshotAt] = useState(() => Date.now());

  // Immediate refresh when holdings composition changes (import / buy / sell qty).
  useEffect(() => {
    setSnapshotRows(buildSnapshot(context.aggregated));
    setSnapshotAt(Date.now());
  }, [structureKey]);

  // Timed refresh every 10 minutes from the latest live marks.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSnapshotRows(buildSnapshot(latestHoldingsRef.current));
      setSnapshotAt(Date.now());
    }, structureRefreshMs);
    return () => window.clearInterval(timer);
  }, []);

  const { pieData, gross } = useMemo(
    () => buildPieData(snapshotRows, currency),
    [snapshotRows, currency],
  );

  const actionText = gross > 0
    ? `合计 ${money(gross, currency, context.masked)} · ${formatStructureTime(snapshotAt)} · 10分钟刷新`
    : '暂无持仓';

  return (
    <section className="panel structure-panel">
      <PanelTitle icon={PieChart} title="仓位结构" action={actionText} />
      <div className="structure-body structure-body-chart-only">
        <div className="pie-wrap pie-wrap-large">
          {pieData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart margin={{ top: 12, right: 28, bottom: 12, left: 28 }}>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={72}
                  paddingAngle={pieData.length > 1 ? 2.5 : 0}
                  stroke="#ffffff"
                  strokeWidth={2}
                  labelLine={{
                    stroke: '#94a3b8',
                    strokeWidth: 1,
                  }}
                  label={<PieSliceLabel />}
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.key} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value, _name, item) => {
                    const payload = item?.payload as PieSlice | undefined;
                    const pct = payload ? ` · ${(payload.percent * 100).toFixed(1)}%` : '';
                    return [
                      `${money(Number(value ?? 0), currency, context.masked)}${pct}`,
                      payload?.fullName || payload?.name || '',
                    ];
                  }}
                />
              </RePieChart>
            </ResponsiveContainer>
          ) : (
            <div className="structure-empty">暂无持仓市值</div>
          )}
        </div>
        {pieData.length > 0 && (
          <ul className="structure-legend" aria-label="持仓颜色图例">
            {pieData.map((item) => (
              <li key={item.key}>
                <i style={{ background: item.color }} />
                <span>{item.name}</span>
                <em>{(item.percent * 100).toFixed(1)}%</em>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
