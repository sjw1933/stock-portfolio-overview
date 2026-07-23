import { ArrowLeft, Check, TrendingDown, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppContext } from '../appContext';
import type { Holding, SellInput } from '../types';
import { signed } from '../utils/currency';

export function SellTradeSheet({ context, holding, onClose }: { context: AppContext; holding: Holding; onClose: () => void }) {
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [qty, setQty] = useState(holding.qty);
  const [price, setPrice] = useState(holding.price);
  const [costAtSell, setCostAtSell] = useState(holding.cost);
  const [fees, setFees] = useState(0);
  const [tradedAt, setTradedAt] = useState(toLocalDateTime(new Date()));
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving'>('idle');
  const [error, setError] = useState('');

  const afterQty = Math.max(0, Math.round((holding.qty - qty) * 10000) / 10000);
  const realizedPnl = (price - costAtSell) * qty - fees;
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!Number.isFinite(qty) || qty <= 0) errors.push('卖出数量必须大于 0');
    if (qty > holding.qty + 0.0000001) errors.push(`卖出数量不能超过 ${formatQty(holding.qty)}`);
    if (!Number.isFinite(price) || price <= 0) errors.push('成交价格必须大于 0');
    if (!Number.isFinite(costAtSell) || costAtSell <= 0) errors.push('卖出时成本价必须大于 0');
    if (!Number.isFinite(fees) || fees < 0) errors.push('手续费不能小于 0');
    if (!tradedAt || Number.isNaN(new Date(tradedAt).getTime())) errors.push('成交日期时间无效');
    if (new Date(tradedAt).getTime() > Date.now() + 5 * 60 * 1000) errors.push('成交时间不能晚于当前时间');
    return errors;
  }, [costAtSell, fees, holding.qty, price, qty, tradedAt]);

  async function submit() {
    if (validation.length || status === 'saving') return;
    setStatus('saving');
    setError('');
    const input: SellInput = { qty, price, costAtSell, fees, tradedAt, note };
    try {
      await context.registerSell(holding, input);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '卖出登记失败');
      setStep('form');
      setStatus('idle');
    }
  }

  return (
    <div className="modal-backdrop sell-backdrop" role="presentation">
      <section className="sell-sheet" role="dialog" aria-modal="true" aria-labelledby="sell-sheet-title">
        <div className="sell-sheet-head">
          <div>
            <p className="eyebrow">{holding.broker} · {holding.account}</p>
            <h2 id="sell-sheet-title">登记卖出 · {holding.symbol}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭卖出登记"><X size={20} /></button>
        </div>

        {step === 'form' ? (
          <>
            <div className="sell-position-summary">
              <div><span>当前持仓</span><b>{formatQty(holding.qty)}</b></div>
              <div><span>当前价格</span><b>{holding.price.toFixed(3)}</b></div>
              <div><span>券商成本</span><b>{holding.cost.toFixed(3)}</b></div>
            </div>
            <div className="sell-form-grid">
              <label>
                卖出数量
                <div className="input-with-action">
                  <input type="number" min="0" max={holding.qty} step="0.0001" value={qty} onChange={(event) => setQty(Number(event.target.value))} />
                  <button type="button" onClick={() => setQty(holding.qty)}>全部</button>
                </div>
              </label>
              <label>成交价格<input type="number" min="0" step="0.0001" value={price} onChange={(event) => setPrice(Number(event.target.value))} /></label>
              <label>卖出时成本价<input type="number" min="0" step="0.0001" value={costAtSell} onChange={(event) => setCostAtSell(Number(event.target.value))} /></label>
              <label>手续费及税费<input type="number" min="0" step="0.01" value={fees} onChange={(event) => setFees(Number(event.target.value))} /></label>
              <label>成交日期时间<input type="datetime-local" value={tradedAt} onChange={(event) => setTradedAt(event.target.value)} /></label>
              <label className="sell-note-field">备注<input value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} placeholder="可选" /></label>
            </div>
            <div className="sell-estimate">
              <span>已实现盈亏（估算）</span>
              <b className={realizedPnl >= 0 ? 'pos' : 'neg'}>{signed(realizedPnl, holding.currency, false)}</b>
              <small>按当前填写的卖出时成本价计算，成交后固定保存。</small>
            </div>
            {validation.length > 0 && <p className="sell-error">{validation[0]}</p>}
            {error && <p className="sell-error">{error}</p>}
            <button type="button" className="primary-action" disabled={validation.length > 0} onClick={() => setStep('confirm')}>
              下一步确认
            </button>
          </>
        ) : (
          <div className="sell-confirm">
            <div className="sell-confirm-icon"><TrendingDown size={24} /></div>
            <div>
              <span>持仓数量变化</span>
              <strong>{formatQty(holding.qty)} → {formatQty(afterQty)}</strong>
              {afterQty === 0 && <em>提交后该账户此标的将清仓</em>}
            </div>
            <dl>
              <div><dt>成交</dt><dd>{formatQty(qty)} 股 × {price.toFixed(4)} {holding.currency}</dd></div>
              <div><dt>手续费</dt><dd>{fees.toFixed(2)} {holding.currency}</dd></div>
              <div><dt>已实现盈亏</dt><dd className={realizedPnl >= 0 ? 'pos' : 'neg'}>{signed(realizedPnl, holding.currency, false)}</dd></div>
            </dl>
            <p>卖出记录提交后不可直接编辑；如填写错误，需要撤销后重新登记。</p>
            {error && <p className="sell-error">{error}</p>}
            <div className="sell-confirm-actions">
              <button type="button" className="secondary-action" onClick={() => setStep('form')} disabled={status === 'saving'}><ArrowLeft size={16} />返回修改</button>
              <button type="button" className="primary-action" onClick={() => void submit()} disabled={status === 'saving'}><Check size={17} />{status === 'saving' ? '正在提交' : '确认卖出'}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function toLocalDateTime(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function formatQty(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
