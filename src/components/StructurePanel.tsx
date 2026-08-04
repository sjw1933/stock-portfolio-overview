import { useMemo } from 'react';
import { PieChart } from 'lucide-react';
import { Cell, Pie, PieChart as RePieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { AppContext } from '../appContext';
import type { AggregatedHolding } from '../types';
import { PanelTitle } from './PanelTitle';
import { convert, money } from '../utils/currency';

function shortSymbol(symbol: string) {
  return symbol.replace(/\.US$|\.HK$/i, '');
}

type MarketSlice = {
  market: 'US' | 'HK';
  name: string;
  value: number;
  color: string;
  holdings: Array<{
    symbol: string;
    name: string;
    value: number;
    percent: number;
  }>;
};

export function StructurePanel({ context }: { context: AppContext }) {
  const currency = context.currency;

  const { pieData, gross } = useMemo(() => {
    const grossValue = context.aggregated.reduce(
      (sum, item) => sum + convert(item.marketValue, item.currency, currency),
      0,
    );

    const buildMarket = (market: 'US' | 'HK', name: string, color: string): MarketSlice => {
      const holdings = context.aggregated
        .filter((item) => item.market === market)
        .map((item) => {
          const value = convert(item.marketValue, item.currency, currency);
          return {
            symbol: shortSymbol(item.symbol),
            name: item.name,
            value,
            percent: grossValue > 0.000001 ? (value / grossValue) * 100 : 0,
          };
        })
        .filter((item) => item.value > 0)
        .sort((a, b) => b.value - a.value);

      const value = holdings.reduce((sum, item) => sum + item.value, 0);
      return { market, name, value, color, holdings };
    };

    // Prefer live holding market values so the pie matches 合并持仓.
    // Fall back to account net assets only when that market has snapshots but no rows.
    const usFromHoldings = buildMarket('US', '美股', '#1769e8');
    const hkFromHoldings = buildMarket('HK', '港股', '#e4485f');

    const usSnapshot = context.accountSnapshots
      .filter((snapshot) => snapshot.market === 'US')
      .reduce((sum, snapshot) => sum + convert(snapshot.netAsset, snapshot.currency, currency), 0);
    const hkSnapshot = context.accountSnapshots
      .filter((snapshot) => snapshot.market === 'HK')
      .reduce((sum, snapshot) => sum + convert(snapshot.netAsset, snapshot.currency, currency), 0);

    const us = usFromHoldings.holdings.length
      ? usFromHoldings
      : { ...usFromHoldings, value: usSnapshot };
    const hk = hkFromHoldings.holdings.length
      ? hkFromHoldings
      : { ...hkFromHoldings, value: hkSnapshot };

    const pieData = [us, hk];
    const gross = pieData.reduce((sum, item) => sum + item.value, 0);
    return { pieData, gross };
  }, [context.aggregated, context.accountSnapshots, currency]);

  return (
    <section className="panel structure-panel">
      <PanelTitle
        icon={PieChart}
        title="仓位结构"
        action={gross > 0 ? `合计 ${money(gross, currency, context.masked)}` : '暂无持仓'}
      />
      <div className="structure-body">
        <div className="pie-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <RePieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                innerRadius={45}
                outerRadius={72}
                paddingAngle={pieData.some((item) => item.value > 0) ? 3 : 0}
              >
                {pieData.map((entry) => (
                  <Cell key={entry.market} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value, name) => [
                  money(Number(value ?? 0), currency, context.masked),
                  String(name ?? ''),
                ]}
              />
            </RePieChart>
          </ResponsiveContainer>
        </div>
        <div className="structure-list">
          {pieData.map((market) => {
            const marketPct = gross > 0.000001 ? (market.value / gross) * 100 : 0;
            return (
              <div key={market.market} className="structure-market-block">
                <div className="structure-market-head">
                  <span>
                    <i style={{ background: market.color }} />
                    {market.name}
                    <em className="structure-pct">{marketPct.toFixed(1)}%</em>
                  </span>
                  <b>{money(market.value, currency, context.masked)}</b>
                </div>
                {market.holdings.length > 0 ? (
                  <ul className="structure-holding-pct">
                    {market.holdings.map((item) => (
                      <li key={item.symbol}>
                        <span title={item.name}>{item.symbol}</span>
                        <em>{item.percent.toFixed(1)}%</em>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="structure-holding-empty">暂无持仓 · 0%</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
