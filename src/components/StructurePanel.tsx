import { useMemo } from 'react';
import { PieChart } from 'lucide-react';
import { Cell, Pie, PieChart as RePieChart, ResponsiveContainer, Tooltip, LabelList } from 'recharts';
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

export function StructurePanel({ context }: { context: AppContext }) {
  const currency = context.currency;

  const { pieData, gross, marketTotals } = useMemo(() => {
    const rows = context.aggregated.map((item, index) => {
      const value = convert(item.marketValue, item.currency, currency);
      return {
        key: item.symbol,
        name: shortSymbol(item.symbol),
        fullName: item.name,
        symbol: item.symbol,
        value,
        color: palette[index % palette.length],
      };
    }).filter((item) => item.value > 0);

    const total = rows.reduce((sum, item) => sum + item.value, 0);
    const withPct = rows.map((item) => ({
      ...item,
      percent: total > 0.000001 ? (item.value / total) * 100 : 0,
    }));

    const marketTotals = {
      US: context.aggregated
        .filter((item) => item.market === 'US')
        .reduce((sum, item) => sum + convert(item.marketValue, item.currency, currency), 0),
      HK: context.aggregated
        .filter((item) => item.market === 'HK')
        .reduce((sum, item) => sum + convert(item.marketValue, item.currency, currency), 0),
    };

    return { pieData: withPct, gross: total, marketTotals };
  }, [context.aggregated, currency]);

  return (
    <section className="panel structure-panel">
      <PanelTitle
        icon={PieChart}
        title="仓位结构"
        action={gross > 0 ? `持仓合计 ${money(gross, currency, context.masked)}` : '暂无持仓'}
      />
      <div className="structure-body">
        <div className="pie-wrap">
          {pieData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={38}
                  outerRadius={68}
                  paddingAngle={pieData.length > 1 ? 2 : 0}
                  stroke="#fff"
                  strokeWidth={1}
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.key} fill={entry.color} />
                  ))}
                  <LabelList
                    dataKey="label"
                    content={(props) => {
                      const { cx, cy, midAngle, outerRadius, index } = props as {
                        cx?: number;
                        cy?: number;
                        midAngle?: number;
                        outerRadius?: number;
                        index?: number;
                      };
                      if (
                        cx == null || cy == null || midAngle == null || outerRadius == null || index == null
                      ) return null;
                      const item = pieData[index];
                      if (!item || item.percent < 4) return null;
                      const RADIAN = Math.PI / 180;
                      const radius = outerRadius + 14;
                      const x = cx + radius * Math.cos(-midAngle * RADIAN);
                      const y = cy + radius * Math.sin(-midAngle * RADIAN);
                      return (
                        <text
                          x={x}
                          y={y}
                          fill="#334155"
                          textAnchor={x > cx ? 'start' : 'end'}
                          dominantBaseline="central"
                          fontSize={10}
                          fontWeight={700}
                        >
                          {item.name} {item.percent.toFixed(0)}%
                        </text>
                      );
                    }}
                  />
                </Pie>
                <Tooltip
                  formatter={(value, _name, item) => {
                    const payload = item?.payload as { percent?: number; fullName?: string } | undefined;
                    const pct = payload?.percent != null ? ` · ${payload.percent.toFixed(1)}%` : '';
                    return [`${money(Number(value ?? 0), currency, context.masked)}${pct}`, payload?.fullName || ''];
                  }}
                />
              </RePieChart>
            </ResponsiveContainer>
          ) : (
            <div className="structure-empty">暂无持仓市值</div>
          )}
        </div>
        <div className="structure-list">
          {pieData.map((item) => (
            <div key={item.key}>
              <span>
                <i style={{ background: item.color }} />
                {item.name}
                <em className="structure-pct">{item.percent.toFixed(1)}%</em>
              </span>
              <b>{money(item.value, currency, context.masked)}</b>
            </div>
          ))}
          {(marketTotals.US > 0 || marketTotals.HK > 0) && (
            <div className="structure-market-foot">
              <span>
                美股 {money(marketTotals.US, currency, context.masked)}
                {gross > 0 ? ` · ${(marketTotals.US / gross * 100).toFixed(0)}%` : ''}
              </span>
              <span>
                港股 {money(marketTotals.HK, currency, context.masked)}
                {gross > 0 ? ` · ${(marketTotals.HK / gross * 100).toFixed(0)}%` : ''}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
