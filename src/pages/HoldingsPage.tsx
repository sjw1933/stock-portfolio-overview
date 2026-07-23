import { useState } from 'react';
import { AccountBreakdown } from '../components/AccountBreakdown';
import { HoldingList } from '../components/HoldingList';
import { SellRecordsPanel } from '../components/SellRecordsPanel';
import { SellTradeSheet } from '../components/SellTradeSheet';
import type { AppContext } from '../appContext';
import type { Holding } from '../types';

export function HoldingsPage({ context }: { context: AppContext }) {
  const [view, setView] = useState<'current' | 'sales'>('current');
  const [sellHolding, setSellHolding] = useState<Holding | null>(null);

  return (
    <div className="page-stack">
      <div className="holding-view-tabs" aria-label="持仓视图">
        <button type="button" className={view === 'current' ? 'active' : ''} onClick={() => setView('current')}>当前持仓</button>
        <button type="button" className={view === 'sales' ? 'active' : ''} onClick={() => setView('sales')}>卖出记录</button>
      </div>
      {view === 'current' ? (
        <>
          <HoldingList context={context} />
          <AccountBreakdown context={context} onSell={setSellHolding} />
        </>
      ) : <SellRecordsPanel context={context} />}
      {sellHolding && <SellTradeSheet context={context} holding={sellHolding} onClose={() => setSellHolding(null)} />}
    </div>
  );
}
