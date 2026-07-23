import { ListChecks, TrendingDown, TrendingUp } from 'lucide-react';
import { PanelTitle } from './PanelTitle';
import type { AppContext } from '../appContext';
import { convert, signed } from '../utils/currency';

export function AccountBreakdown({ context, onBuy, onSell }: { context: AppContext; onBuy: (holding: AppContext['holdings'][number]) => void; onSell: (holding: AppContext['holdings'][number]) => void }) {
  const accounts = Array.from(new Set(context.holdings.map((holding) => `${holding.broker} · ${holding.account}`)));

  return (
    <section className="panel account-breakdown">
      <PanelTitle icon={ListChecks} title="账户拆分" action="增量更新" />
      {accounts.map((account) => {
        const rows = context.holdings.filter((holding) => `${holding.broker} · ${holding.account}` === account);
        return (
          <details key={account} open>
            <summary>
              {account}
              <span>{rows.length} 只</span>
            </summary>
            {rows.map((row) => (
              <div className="account-row" key={`${account}-${row.symbol}`}>
                <span>{row.symbol}</span>
                <b>{context.masked ? '****' : row.qty}</b>
                <em className={row.totalPnl >= 0 ? 'pos' : 'neg'}>
                  {signed(convert(row.totalPnl, row.currency, context.currency), context.currency, context.masked)}
                </em>
                <div className="trade-entry-actions"><button type="button" className="buy-entry-button" onClick={() => onBuy(row)} title="登记买入"><TrendingUp size={15} />买入</button><button type="button" className="sell-entry-button" onClick={() => onSell(row)} title="登记卖出"><TrendingDown size={15} />卖出</button></div>
              </div>
            ))}
          </details>
        );
      })}
    </section>
  );
}
