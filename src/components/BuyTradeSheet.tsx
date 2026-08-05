import { ArrowLeft, Check, Search, TrendingUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppContext } from '../appContext';
import type { Broker, BuyInput, Holding } from '../types';
import { currencyForMarket, marketLabel } from '../utils/currency';
import { fetchSecurityQuote, normalizeSecuritySymbol } from '../utils/quotes';

const brokers = ['盈立证券', '致富证券', '星财富', 'Schwab', 'US Bancorp Advisors'] as const;
const holdingTypes = ['个股', 'ETF', '杠杆ETF'] as const;
const markets: Holding['market'][] = ['US', 'HK', 'CN'];

type AccountOption = Pick<Holding, 'broker' | 'account' | 'market' | 'currency'>;

export function BuyTradeSheet({ context, holding, onClose }: { context: AppContext; holding?: Holding; onClose: () => void }) {
  const accountOptions = useMemo(() => buildAccountOptions(context), [context.accountSnapshots, context.holdings]);
  const initialAccount = holding ? accountFromHolding(holding) : accountOptions[0];
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [accountChoice, setAccountChoice] = useState(holding ? accountKey(holding) : initialAccount ? accountKey(initialAccount) : '__new__');
  const [newBroker, setNewBroker] = useState<Broker>('盈立证券');
  const [newAccount, setNewAccount] = useState('');
  const [newMarket, setNewMarket] = useState<Holding['market']>('US');
  const [name, setName] = useState(holding?.name ?? '');
  const [symbol, setSymbol] = useState(holding?.symbol ?? '');
  const [holdingType, setHoldingType] = useState<Holding['type']>(holding?.type ?? '个股');
  const [qty, setQty] = useState(0);
  const [price, setPrice] = useState(holding?.price ?? 0);
  const [currentPrice, setCurrentPrice] = useState(holding?.price ?? 0);
  const [fees, setFees] = useState(0);
  const [tradedAt, setTradedAt] = useState(toLocalDateTime(new Date()));
  const [note, setNote] = useState('');
  const [lookupStatus, setLookupStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [status, setStatus] = useState<'idle' | 'saving'>('idle');
  const [error, setError] = useState('');

  const selectedAccount = holding
    ? accountFromHolding(holding)
    : accountChoice === '__new__'
      ? { broker: newBroker, account: newAccount, market: newMarket, currency: currencyForMarket(newMarket) }
      : accountOptions.find((item) => accountKey(item) === accountChoice) ?? initialAccount;
  const normalizedSymbol = normalizeSecuritySymbol(symbol, selectedAccount?.market ?? 'US');
  const existing = selectedAccount
    ? context.holdings.find((item) => accountKey(item) === accountKey(selectedAccount) && item.symbol === normalizedSymbol)
    : undefined;
  const beforeQty = holding?.qty ?? existing?.qty ?? 0;
  const beforeCost = holding?.cost ?? existing?.cost ?? 0;
  const totalCost = price * qty + fees;
  const afterQty = beforeQty + qty;
  const afterCost = afterQty > 0 ? ((beforeQty * beforeCost) + totalCost) / afterQty : 0;
  const currency = selectedAccount?.currency ?? 'USD';

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!selectedAccount?.account.trim()) errors.push('请选择或填写券商账户');
    if (!symbol.trim()) errors.push('股票代码不能为空');
    if (!name.trim()) errors.push('股票名称不能为空');
    if (!Number.isFinite(qty) || qty <= 0) errors.push('买入数量必须大于 0');
    if (!Number.isFinite(price) || price <= 0) errors.push('成交价格必须大于 0');
    if (!Number.isFinite(fees) || fees < 0) errors.push('手续费不能小于 0');
    if (!tradedAt || Number.isNaN(new Date(tradedAt).getTime())) errors.push('成交日期时间无效');
    if (new Date(tradedAt).getTime() > Date.now() + 5 * 60 * 1000) errors.push('成交时间不能晚于当前时间');
    return errors;
  }, [fees, name, price, qty, selectedAccount?.account, symbol, tradedAt]);

  async function lookupQuote() {
    if (!symbol.trim() || !selectedAccount) return;
    setLookupStatus('loading');
    setError('');
    try {
      const quote = await fetchSecurityQuote(symbol, selectedAccount.market);
      setSymbol(normalizeSecuritySymbol(symbol, selectedAccount.market));
      if (!name.trim() && quote.name) setName(quote.name);
      setCurrentPrice(quote.price);
      if (!(price > 0)) setPrice(quote.price);
      setLookupStatus('ready');
    } catch (reason) {
      setLookupStatus('error');
      setError(reason instanceof Error ? reason.message : '行情查询失败，可继续手动填写');
    }
  }

  async function submit() {
    if (validation.length || status === 'saving' || !selectedAccount) return;
    setStatus('saving');
    setError('');
    const input: BuyInput = {
      broker: selectedAccount.broker,
      account: selectedAccount.account,
      market: selectedAccount.market,
      holdingType,
      name,
      symbol,
      currency: selectedAccount.currency,
      qty,
      price,
      currentPrice: currentPrice > 0 ? currentPrice : price,
      fees,
      tradedAt,
      note,
    };
    try {
      await context.registerBuy(input);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '买入登记失败');
      setStep('form');
      setStatus('idle');
    }
  }

  return (
    <div className="modal-backdrop sell-backdrop" role="presentation">
      <section className="sell-sheet buy-sheet" role="dialog" aria-modal="true" aria-labelledby="buy-sheet-title">
        <div className="sell-sheet-head">
          <div><p className="eyebrow">{holding ? `${holding.broker} · ${holding.account}` : '已成交交易'}</p><h2 id="buy-sheet-title">{holding ? `登记买入 · ${holding.symbol}` : '新增买入'}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭买入登记"><X size={20} /></button>
        </div>

        {step === 'form' ? (
          <>
            {!holding && (
              <div className="buy-account-block">
                <label>
                  券商账户
                  <select value={accountChoice} onChange={(event) => setAccountChoice(event.target.value)}>
                    {accountOptions.map((item) => (
                      <option key={accountKey(item)} value={accountKey(item)}>
                        {item.broker} · {item.account} · {marketLabel(item.market)}
                      </option>
                    ))}
                    <option value="__new__">新增账户</option>
                  </select>
                </label>
                {accountChoice === '__new__' && (
                  <div className="sell-form-grid new-account-fields">
                    <label>
                      券商
                      <select value={newBroker} onChange={(event) => setNewBroker(event.target.value as Broker)}>
                        {brokers.map((item) => <option key={item}>{item}</option>)}
                      </select>
                    </label>
                    <label>
                      账户名称
                      <input value={newAccount} onChange={(event) => setNewAccount(event.target.value)} />
                    </label>
                    <label>
                      市场
                      <select value={newMarket} onChange={(event) => setNewMarket(event.target.value as Holding['market'])}>
                        {markets.map((item) => (
                          <option key={item} value={item}>{marketLabel(item)}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            )}
            <div className="sell-position-summary buy-position-summary">
              <div><span>当前持仓</span><b>{formatQty(beforeQty)}</b></div>
              <div><span>当前成本</span><b>{beforeQty > 0 ? beforeCost.toFixed(4) : '--'}</b></div>
              <div><span>结算币种</span><b>{currency}</b></div>
            </div>
            <div className="sell-form-grid">
              <label>股票代码<div className="input-with-action"><input value={symbol} readOnly={Boolean(holding)} onChange={(event) => { setSymbol(event.target.value.toUpperCase()); setLookupStatus('idle'); }} /><button type="button" title="查询行情" disabled={lookupStatus === 'loading'} onClick={() => void lookupQuote()}><Search size={15} /></button></div></label>
              <label>股票名称<input value={name} readOnly={Boolean(holding)} onChange={(event) => setName(event.target.value)} /></label>
              <label>证券类型<select value={holdingType} disabled={Boolean(holding)} onChange={(event) => setHoldingType(event.target.value as Holding['type'])}>{holdingTypes.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label>买入数量<input type="number" min="0" step="0.000001" value={qty || ''} onChange={(event) => setQty(Number(event.target.value))} /></label>
              <label>成交价格<input type="number" min="0" step="0.0001" value={price || ''} onChange={(event) => setPrice(Number(event.target.value))} /></label>
              <label>手续费及税费<input type="number" min="0" step="0.01" value={fees} onChange={(event) => setFees(Number(event.target.value))} /></label>
              <label>成交日期时间<input type="datetime-local" value={tradedAt} onChange={(event) => setTradedAt(event.target.value)} /></label>
              <label className="sell-note-field">备注<input value={note} maxLength={240} onChange={(event) => setNote(event.target.value)} placeholder="可选" /></label>
            </div>
            {lookupStatus === 'ready' && <p className="lookup-ok">行情已匹配，当前价 {currentPrice.toFixed(4)} {currency}</p>}
            <div className="sell-estimate buy-estimate"><span>本次总成本</span><b>{Number.isFinite(totalCost) ? totalCost.toFixed(2) : '0.00'} {currency}</b><small>成交金额加手续费；将从该账户的剩余资产估算中扣减。</small></div>
            {validation.length > 0 && <p className="sell-error">{validation[0]}</p>}
            {error && <p className="sell-error">{error}</p>}
            <button type="button" className="primary-action" disabled={validation.length > 0} onClick={() => setStep('confirm')}>下一步确认</button>
          </>
        ) : (
          <div className="sell-confirm buy-confirm">
            <div className="sell-confirm-icon buy-confirm-icon"><TrendingUp size={24} /></div>
            <div><span>持仓数量变化</span><strong>{formatQty(beforeQty)} → {formatQty(afterQty)}</strong><em>加权成本 {beforeQty > 0 ? beforeCost.toFixed(4) : '--'} → {afterCost.toFixed(4)}</em></div>
            <dl><div><dt>账户</dt><dd>{selectedAccount?.broker} · {selectedAccount?.account}</dd></div><div><dt>成交</dt><dd>{formatQty(qty)} 股 × {price.toFixed(4)} {currency}</dd></div><div><dt>手续费</dt><dd>{fees.toFixed(2)} {currency}</dd></div><div><dt>总成本</dt><dd>{totalCost.toFixed(2)} {currency}</dd></div></dl>
            <p>买入提交后不可直接编辑；填写错误需要撤销后重新登记。</p>
            {error && <p className="sell-error">{error}</p>}
            <div className="sell-confirm-actions"><button type="button" className="secondary-action" onClick={() => setStep('form')} disabled={status === 'saving'}><ArrowLeft size={16} />返回修改</button><button type="button" className="primary-action buy-primary-action" onClick={() => void submit()} disabled={status === 'saving'}><Check size={17} />{status === 'saving' ? '正在提交' : '确认买入'}</button></div>
          </div>
        )}
      </section>
    </div>
  );
}

function buildAccountOptions(context: AppContext): AccountOption[] {
  const map = new Map<string, AccountOption>();
  for (const item of [...context.accountSnapshots, ...context.holdings]) {
    const option: AccountOption = { broker: item.broker as Broker, account: item.account, market: item.market, currency: item.currency };
    map.set(accountKey(option), option);
  }
  return Array.from(map.values());
}

function accountFromHolding(holding: Holding): AccountOption {
  return { broker: holding.broker, account: holding.account, market: holding.market, currency: holding.currency };
}

function accountKey(item: Pick<Holding, 'broker' | 'account' | 'market'>) {
  return `${item.broker}::${item.account}::${item.market}`;
}

function toLocalDateTime(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function formatQty(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}
