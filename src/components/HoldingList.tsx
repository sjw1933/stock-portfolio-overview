import { Wallet } from 'lucide-react';
import { useMemo } from 'react';
import { PanelTitle } from './PanelTitle';
import type { AppContext } from '../appContext';
import { convert, money, signed } from '../utils/currency';
import { quoteViewSessionLabel } from '../utils/quotes';

export function HoldingList({ context, limit }: { context: AppContext; limit?: number }) {
  const rows = limit ? context.aggregated.slice(0, limit) : context.aggregated;
  const viewLabel = quoteViewSessionLabel(context.quoteViewSession);
  const todayColumnLabel = context.quoteViewSession === 'regular' ? '今日盈亏' : `${viewLabel}盈亏`;
  const totalColumnLabel = context.quoteViewSession === 'regular' ? '盈亏' : `${viewLabel}盈亏`;

  const gross = useMemo(
    () => rows.reduce((sum, item) => sum + convert(item.marketValue, item.currency, context.currency), 0),
    [rows, context.currency],
  );

  return (
    <section className="panel holdings-list">
      <PanelTitle icon={Wallet} title="合并持仓" action="明细按账户拆分" />
      <div className="table-head">
        <span>名称/代码</span>
        <span>市值/数量</span>
        <span>现价/成本</span>
        <span>{totalColumnLabel}</span>
        <span>{todayColumnLabel}</span>
        <span>仓位占比</span>
      </div>
      {!rows.length && (
        <div className="holdings-empty">
          <b>当前没有持仓</b>
          <span>卖出记录和已实现收益仍会保留。</span>
        </div>
      )}
      {rows.map((item) => {
        const marketValue = convert(item.marketValue, item.currency, context.currency);
        const todayBase = item.marketValue - item.todayPnl;
        const todayRate = Math.abs(todayBase) > 0.000001 ? (item.todayPnl / todayBase) * 100 : null;
        const weight = gross > 0.000001 ? (marketValue / gross) * 100 : null;
        const session = context.quoteSessions[item.symbol] ?? (item.market === 'US' ? context.quoteViewSession : undefined);
        return (
          <article className="holding-row" key={item.symbol}>
            <div>
              <b>{item.name}</b>
              <span>{item.symbol}</span>
            </div>
            <div>
              <b>{money(marketValue, context.currency, context.masked)}</b>
              <span>{context.masked ? '****' : item.qty.toFixed(item.qty < 1 ? 4 : 2)}</span>
            </div>
            <div className="holding-price-cell">
              <div className="holding-price-line">
                <b className="holding-price-value">{item.price.toFixed(3)}</b>
                {session && (
                  <em className={`quote-session quote-session-${session}`}>
                    {quoteViewSessionLabel(session)}
                  </em>
                )}
              </div>
              <span>{item.cost.toFixed(3)}</span>
            </div>
            <div className={item.totalPnl >= 0 ? 'pos' : 'neg'}>
              <b>{signed(convert(item.totalPnl, item.currency, context.currency), context.currency, context.masked)}</b>
              <span>{(((item.price - item.cost) / item.cost) * 100).toFixed(2)}%</span>
            </div>
            <div className={`today-pnl-cell ${item.todayPnl >= 0 ? 'pos' : 'neg'}`}>
              <span className="holding-mobile-label">{todayColumnLabel}</span>
              <div className="today-pnl-values">
                <b>{signed(convert(item.todayPnl, item.currency, context.currency), context.currency, context.masked)}</b>
                <span>{todayRate === null ? '--' : `${todayRate.toFixed(2)}%`}</span>
              </div>
            </div>
            <div className="holding-weight-cell">
              <span className="holding-mobile-label">仓位占比</span>
              <div className="holding-weight-values">
                <b>{weight === null ? '--' : `${weight.toFixed(1)}%`}</b>
                <span>占持仓</span>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
