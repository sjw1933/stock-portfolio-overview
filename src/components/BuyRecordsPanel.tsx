import { RotateCcw, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppContext } from '../appContext';
import type { BuyRecord } from '../types';
import { convert, money } from '../utils/currency';
import { PanelTitle } from './PanelTitle';

type PeriodFilter = 'all' | '30d' | 'year';

export function BuyRecordsPanel({ context }: { context: AppContext }) {
  const [period, setPeriod] = useState<PeriodFilter>('all');
  const [symbol, setSymbol] = useState('ALL');
  const [account, setAccount] = useState('ALL');
  const [pendingId, setPendingId] = useState('');
  const [confirmingId, setConfirmingId] = useState('');
  const [error, setError] = useState('');
  const symbols = Array.from(new Set(context.buyRecords.map((record) => record.symbol))).sort();
  const accounts = Array.from(new Set(context.buyRecords.map((record) => `${record.broker} · ${record.account}`))).sort();
  const rows = useMemo(() => context.buyRecords.filter((record) => {
    if (symbol !== 'ALL' && record.symbol !== symbol) return false;
    if (account !== 'ALL' && `${record.broker} · ${record.account}` !== account) return false;
    return isInPeriod(record, period);
  }).sort((a, b) => b.tradedAt.localeCompare(a.tradedAt)), [account, context.buyRecords, period, symbol]);
  const activeRows = rows.filter((record) => record.status === 'active');
  const totals = activeRows.reduce((result, record) => ({ amount: result.amount + convert(record.totalCost, record.currency, context.currency), fees: result.fees + convert(record.fees, record.currency, context.currency) }), { amount: 0, fees: 0 });

  async function revoke(record: BuyRecord) {
    setPendingId(record.id);
    setError('');
    try { await context.revokeBuy(record.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '撤销失败'); }
    finally { setPendingId(''); setConfirmingId(''); }
  }

  return (
    <section className="panel sell-records-panel buy-records-panel">
      <PanelTitle icon={TrendingUp} title="买入记录" action={`${activeRows.length} 笔有效记录`} />
      <div className="sell-record-filters"><div className="holding-view-tabs compact-tabs" aria-label="买入时间筛选">{([['all', '全部'], ['30d', '近30天'], ['year', '今年']] as const).map(([key, label]) => <button key={key} type="button" className={period === key ? 'active' : ''} onClick={() => setPeriod(key)}>{label}</button>)}</div><label><SlidersHorizontal size={14} /><select value={symbol} onChange={(event) => setSymbol(event.target.value)}><option value="ALL">全部股票</option>{symbols.map((item) => <option key={item}>{item}</option>)}</select></label><label><select value={account} onChange={(event) => setAccount(event.target.value)}><option value="ALL">全部账户</option>{accounts.map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <div className="sell-record-summary buy-record-summary"><div><span>买入总成本</span><b>{money(totals.amount, context.currency, context.masked)}</b></div><div><span>手续费</span><b>{money(totals.fees, context.currency, context.masked)}</b></div><div><span>有效记录</span><b>{activeRows.length} 笔</b></div></div>
      {error && <p className="sell-error">{error}</p>}
      {!rows.length && <div className="sell-record-empty"><b>暂无买入记录</b><span>从当前持仓加仓，或使用“新增买入”。</span></div>}
      <div className="sell-record-list">{rows.map((record) => (
        <article key={record.id} className={`sell-record-row buy-record-row ${record.status === 'reversed' ? 'reversed' : ''}`}>
          <div className="sell-record-main"><div><b>{record.name}</b><span>{record.symbol} · {record.broker} · {record.account}</span></div><span className={`sell-status ${record.status}`}>{record.status === 'active' ? '有效' : '已撤销'}</span></div>
          <div className="sell-record-data"><div><span>成交时间</span><b>{formatDateTime(record.tradedAt)}</b></div><div><span>数量 / 成交价</span><b>{context.masked ? '****' : formatQty(record.qty)} / {record.price.toFixed(4)}</b></div><div><span>总成本 / 手续费</span><b>{record.totalCost.toFixed(2)} / {record.fees.toFixed(2)}</b></div><div><span>加权成本变化</span><b>{record.beforeQty > 0 ? record.beforeCost.toFixed(4) : '--'} → {record.afterCost.toFixed(4)}</b></div></div>
          {record.note && <p className="sell-record-note">{record.note}</p>}
          {record.status === 'reversed' && record.reversalEffect === 'history-only' && <p className="record-reversal-note">后续已有快照或交易，本次只撤销历史记录，未改动当前持仓。</p>}
          {record.status === 'active' && (confirmingId === record.id ? <div className="sell-revoke-confirm"><span>撤销后会在条件允许时回退数量和成本，确定吗？</span><button type="button" className="secondary-action" onClick={() => setConfirmingId('')} disabled={pendingId === record.id}>取消</button><button type="button" className="sell-revoke-button buy-revoke-button" disabled={pendingId === record.id} onClick={() => void revoke(record)}><RotateCcw size={15} />{pendingId === record.id ? '撤销中' : '确认撤销'}</button></div> : <button type="button" className="sell-revoke-button buy-revoke-button" onClick={() => setConfirmingId(record.id)}><RotateCcw size={15} />撤销买入</button>)}
        </article>
      ))}</div>
    </section>
  );
}

function isInPeriod(record: BuyRecord, period: PeriodFilter) {
  if (period === 'all') return true;
  const date = new Date(record.tradedAt);
  const now = new Date();
  if (period === '30d') return date.getTime() >= now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return date.getFullYear() === now.getFullYear();
}

function formatDateTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function formatQty(value: number) { return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }); }
