import { useState } from 'react';
import { AccountBreakdown } from '../components/AccountBreakdown';
import { HoldingList } from '../components/HoldingList';
import { SellRecordsPanel } from '../components/SellRecordsPanel';
import { SellTradeSheet } from '../components/SellTradeSheet';
import { BuyRecordsPanel } from '../components/BuyRecordsPanel';
import { BuyTradeSheet } from '../components/BuyTradeSheet';
import { Plus } from 'lucide-react';
import type { AppContext } from '../appContext';
import type { Holding } from '../types';

export function HoldingsPage({ context }: { context: AppContext }) {
  const [view, setView] = useState<'current' | 'buys' | 'sales'>('current');
  const [sellHolding, setSellHolding] = useState<Holding | null>(null);
  const [buyHolding, setBuyHolding] = useState<Holding | null | undefined>(undefined);

  return (
    <div className="page-stack">
      <div className="holding-view-tabs holding-record-tabs" aria-label="持仓视图">
        <button type="button" className={view === 'current' ? 'active' : ''} onClick={() => setView('current')}>当前持仓</button>
        <button type="button" className={view === 'buys' ? 'active' : ''} onClick={() => setView('buys')}>买入记录</button>
        <button type="button" className={view === 'sales' ? 'active' : ''} onClick={() => setView('sales')}>卖出记录</button>
      </div>
      {view === 'current' ? (
        <>
          <button type="button" className="new-buy-button" onClick={() => setBuyHolding(null)}><Plus size={17} />新增买入</button>
          <HoldingList context={context} />
          <AccountBreakdown context={context} onBuy={setBuyHolding} onSell={setSellHolding} />
        </>
      ) : view === 'buys' ? <BuyRecordsPanel context={context} /> : <SellRecordsPanel context={context} />}
      {buyHolding !== undefined && <BuyTradeSheet context={context} holding={buyHolding ?? undefined} onClose={() => setBuyHolding(undefined)} />}
      {sellHolding && <SellTradeSheet context={context} holding={sellHolding} onClose={() => setSellHolding(null)} />}
    </div>
  );
}
