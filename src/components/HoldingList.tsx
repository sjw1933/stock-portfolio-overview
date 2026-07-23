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
      </div>
      {!rows.length && (
        <div className="holdings-empty">
          <b>当前没有持仓</b>
          <span>卖出记录和已实现收益仍会保留。</span>
        </div>
      )}
      {rows.map((item) => (
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
            <b>{item.price.toFixed(3)}</b>
            <span>{item.cost.toFixed(3)}</span>
          </div>
          <div className={item.totalPnl >= 0 ? 'pos' : 'neg'}>
            <b>{signed(convert(item.totalPnl, item.currency, context.currency), context.currency, context.masked)}</b>
            <span>{(((item.price - item.cost) / item.cost) * 100).toFixed(2)}%</span>
          </div>
        </article>
      ))}
    </section>
  );
}
