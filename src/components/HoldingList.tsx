import { Wallet } from 'lucide-react';
import { PanelTitle } from './PanelTitle';
import type { AppContext } from '../appContext';
import { convert, money, signed } from '../utils/currency';

export function HoldingList({ context, limit }: { context: AppContext; limit?: number }) {
  const rows = limit ? context.aggregated.slice(0, limit) : context.aggregated;

  return (
    <section className="panel holdings-list">
      <PanelTitle icon={Wallet} title="合并持仓" action="明细按账户拆分" />
      <div className="table-head">
        <span>名称/代码</span>
        <span>市值/数量</span>
        <span>现价/成本</span>
        <span>盈亏</span>
        <span>今日盈亏</span>
      </div>
      {!rows.length && (
        <div className="holdings-empty">
          <b>当前没有持仓</b>
          <span>卖出记录和已实现收益仍会保留。</span>
        </div>
      )}
      {rows.map((item) => {
        const todayBase = item.marketValue - item.todayPnl;
        const todayRate = Math.abs(todayBase) > 0.000001 ? (item.todayPnl / todayBase) * 100 : null;
        return (
          <article className="holding-row" key={item.symbol}>
            <div>
              <b>{item.name}</b>
              <span>{item.symbol}</span>
            </div>
            <div>
              <b>{money(convert(item.marketValue, item.currency, context.currency), context.currency, context.masked)}</b>
              <span>{context.masked ? '****' : item.qty.toFixed(item.qty < 1 ? 4 : 2)}</span>
            </div>
            <div>
              <b className="holding-price">
                {item.price.toFixed(3)}
                {context.quoteSessions[item.symbol] && (
                  <em className={`quote-session quote-session-${context.quoteSessions[item.symbol]}`}>
                    {context.quoteSessions[item.symbol] === 'pre' ? '盘前' : '盘后'}
                  </em>
                )}
              </b>
              <span>{item.cost.toFixed(3)}</span>
            </div>
            <div className={item.totalPnl >= 0 ? 'pos' : 'neg'}>
              <b>{signed(convert(item.totalPnl, item.currency, context.currency), context.currency, context.masked)}</b>
              <span>{(((item.price - item.cost) / item.cost) * 100).toFixed(2)}%</span>
            </div>
            <div className={`today-pnl-cell ${item.todayPnl >= 0 ? 'pos' : 'neg'}`}>
              <span className="holding-mobile-label">今日盈亏</span>
              <div className="today-pnl-values">
                <b>{signed(convert(item.todayPnl, item.currency, context.currency), context.currency, context.masked)}</b>
                <span>{todayRate === null ? '--' : `${todayRate.toFixed(2)}%`}</span>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
