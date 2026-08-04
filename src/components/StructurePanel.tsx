import { useMemo } from 'react';
import { PieChart } from 'lucide-react';
import { Cell, Pie, PieChart as RePieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { AppContext } from '../appContext';
import { PanelTitle } from './PanelTitle';
import { convert, money } from '../utils/currency';

const palette = [
  '#1769e8',
  '#2687ff',
  '#0f5cd6',
  '#4f8ef7',
  '#7aaefc',
  '#3b82f6',
  '#2563eb',
  '#1d4ed8',
  '#60a5fa',
  '#93c5fd',
  '#38bdf8',
  '#0ea5e9',
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

function PieSliceLabel(props: {
  cx?: number;
  cy?: number;
  midAngle?: number;
  innerRadius?: number;
  outerRadius?: number;
  percent?: number;
  name?: string;
}) {
  const { cx, cy, midAngle, innerRadius, outerRadius, percent, name } = props;
  if (
    cx == null
    || cy == null
    || midAngle == null
    || innerRadius == null
    || outerRadius == null
    || percent == null
    || !name
  ) {
    return null;
  }

  // Skip tiny slices to avoid overlapping labels.
  if (percent < 0.04) return null;

  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.55;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  const pct = (percent * 100).toFixed(0);

  return (
    <text
      x={x}
      y={y}
      fill="#ffffff"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={10}
      fontWeight={800}
      style={{ pointerEvents: 'none', textShadow: '0 1px 2px rgb(15 23 42 / 35%)' }}
    >
      {name}
      <tspan x={x} dy="1.15em" fontSize={9} fontWeight={700}>
        {pct}%
      </tspan>
    </text>
  );
}

export function StructurePanel({ context }: { context: AppContext }) {
  const currency = context.currency;

  const { pieData, gross } = useMemo(() => {
    const rows: PieSlice[] = context.aggregated
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

    const total = rows.reduce((sum, item) => sum + item.value, 0);
    const withPct = rows.map((item) => ({
      ...item,
      percent: total > 0.000001 ? item.value / total : 0,
    }));

    return { pieData: withPct, gross: total };
  }, [context.aggregated, currency]);

  return (
    <section className="panel structure-panel">
      <PanelTitle
        icon={PieChart}
        title="仓位结构"
        action={gross > 0 ? `持仓合计 ${money(gross, currency, context.masked)}` : '暂无持仓'}
      />
      <div className="structure-body structure-body-chart-only">
        <div className="pie-wrap pie-wrap-large">
          {pieData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={42}
                  outerRadius={78}
                  paddingAngle={pieData.length > 1 ? 2 : 0}
                  stroke="#fff"
                  strokeWidth={1}
                  labelLine={false}
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
      </div>
    </section>
  );
}
