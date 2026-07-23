import { RotateCcw, SlidersHorizontal, TrendingDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppContext } from '../appContext';
import type { SellRecord } from '../types';
import { convert, money, signed } from '../utils/currency';
import { PanelTitle } from './PanelTitle';

type PeriodFilter = 'all' | '30d' | 'year';

export function SellRecordsPanel({ context }: { context: AppContext }) {
  const [period, setPeriod] = useState<PeriodFilter>('all');
  const [symbol, setSymbol] = useState('ALL');
  const [account, setAccount] = useState('ALL');
  const [pendingId, setPendingId] = useState('');
  const [confirmingId, setConfirmingId] = useState('');
  const [error, setError] = useState('');
  const symbols = Array.from(new Set(context.sellRecords.map((record) => record.symbol))).sort();
  const accounts = Array.from(new Set(context.sellRecords.map((record) => `${record.broker} · ${record.account}`))).sort();

  const rows = useMemo(() => context.sellRecords.filter((record) => {
    if (symbol !== 'ALL' && record.symbol !== symbol) return false;
    if (account !== 'ALL' && `${record.broker} · ${record.account}` !== account) return false;
    return isInPeriod(record, period);
  }).sort((a, b) => b.tradedAt.localeCompare(a.tradedAt)), [account, context.sellRecords, period, symbol]);

  const activeRows = rows.filter((record) => record.status === 'active');
  const totals = activeRows.reduce((result, record) => ({
    amount: result.amount + convert(record.price * record.qty, record.currency, context.currency),
    pnl: result.pnl + convert(record.realizedPnl, record.currency, context.currency),
    fees: result.fees + convert(record.fees, record.currency, context.currency),
  }), { amount: 0, pnl: 0, fees: 0 });

  async function revoke(record: SellRecord) {
    setPendingId(record.id);
    setError('');
    try {
      await context.revokeSell(record.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '撤销失败');
    } finally {
      setPendingId('');
      setConfirmingId('');
    }
  }

  return (
    <section className="panel sell-records-panel">
      <PanelTitle icon={TrendingDown} title="卖出记录" action={`${activeRows.length} 笔有效记录`} />
      <div className="sell-record-filters">
        <div className="holding-view-tabs compact-tabs" aria-label="卖出时间筛选">
          {([['all', '全部'], ['30d', '近30天'], ['year', '今年']] as const).map(([key, label]) => (
            <button key={key} type="button" className={period === key ? 'active' : ''} onClick={() => setPeriod(key)}>{label}</button>
          ))}
        </div>
        <label><SlidersHorizontal size={14} /><select value={symbol} onChange={(event) => setSymbol(event.target.value)}><option value="ALL">全部股票</option>{symbols.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><select value={account} onChange={(event) => setAccount(event.target.value)}><option value="ALL">全部账户</option>{accounts.map((item) => <option key={item}>{item}</option>)}</select></label>
      </div>
      <div className="sell-record-summary">
        <div><span>卖出金额</span><b>{money(totals.amount, context.currency, context.masked)}</b></div>
        <div><span>已实现盈亏</span><b className={totals.pnl >= 0 ? 'pos' : 'neg'}>{signed(totals.pnl, context.currency, context.masked)}</b></div>
        <div><span>手续费</span><b>{money(totals.fees, context.currency, context.masked)}</b></div>
      </div>
      {error && <p className="sell-error">{error}</p>}
      {!rows.length && <div className="sell-record-empty"><b>暂无卖出记录</b><span>从当前持仓的账户明细中登记卖出。</span></div>}
      <div className="sell-record-list">
        {rows.map((record) => (
          <article key={record.id} className={`sell-record-row ${record.status === 'reversed' ? 'reversed' : ''}`}>
            <div className="sell-record-main">
              <div><b>{record.name}</b><span>{record.symbol} · {record.broker} · {record.account}</span></div>
              <span className={`sell-status ${record.status}`}>{record.status === 'active' ? '有效' : '已撤销'}</span>
            </div>
            <div className="sell-record-data">
              <div><span>成交时间</span><b>{formatDateTime(record.tradedAt)}</b></div>
              <div><span>数量 / 成交价</span><b>{context.masked ? '****' : formatQty(record.qty)} / {record.price.toFixed(3)}</b></div>
              <div><span>成本 / 手续费</span><b>{record.costAtSell.toFixed(3)} / {record.fees.toFixed(2)}</b></div>
              <div><span>已实现盈亏</span><b className={record.realizedPnl >= 0 ? 'pos' : 'neg'}>{signed(record.realizedPnl, record.currency, context.masked)}</b></div>
            </div>
            {record.note && <p className="sell-record-note">{record.note}</p>}
            {record.status === 'active' && (
              confirmingId === record.id ? (
                <div className="sell-revoke-confirm">
                  <span>将恢复 {formatQty(record.qty)} 股，确定撤销？</span>
                  <button type="button" className="secondary-action" onClick={() => setConfirmingId('')} disabled={pendingId === record.id}>取消</button>
                  <button type="button" className="sell-revoke-button" disabled={pendingId === record.id} onClick={() => void revoke(record)}>
                    <RotateCcw size={15} />{pendingId === record.id ? '撤销中' : '确认恢复数量'}
                  </button>
                </div>
              ) : (
                <button type="button" className="sell-revoke-button" onClick={() => setConfirmingId(record.id)}>
                  <RotateCcw size={15} />撤销卖出
                </button>
              )
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function isInPeriod(record: SellRecord, period: PeriodFilter) {
  if (period === 'all') return true;
  const date = new Date(record.tradedAt);
  const now = new Date();
  if (period === '30d') return date.getTime() >= now.getTime() - 30 * 24 * 60 * 60 * 1000;
  return date.getFullYear() === now.getFullYear();
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatQty(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
