import { Lock } from 'lucide-react';
import type { AppContext } from '../appContext';
import type { QuoteViewSession } from '../types';
import { money, signed } from '../utils/currency';
import { quoteViewSessionLabel } from '../utils/quotes';

const viewSessions: QuoteViewSession[] = ['pre', 'regular', 'post'];

export function PortfolioSummaryCard({ context }: { context: AppContext }) {
  const currency = context.currency;
  const currencyLabel = {
    HKD: '港币',
    USD: '美元',
    CNY: '人民币',
  }[currency];
  const statusText = {
    idle: '等待首次刷新',
    refreshing: '行情刷新中',
    live: '实时行情已更新',
    fallback: '行情刷新失败，使用截图价格',
    error: '行情异常',
  }[context.quoteStatus];
  const viewLabel = quoteViewSessionLabel(context.quoteViewSession);
  const marketLabel = {
    pre: '当前美股盘前',
    regular: '当前美股盘中',
    post: '当前美股盘后',
    closed: '当前非交易时段，默认盘中',
  }[context.marketSession];
  const todayReturnLabel = context.quoteViewSession === 'regular' ? '今日收益' : `${viewLabel}收益`;
  const todayPnlLabel = context.quoteViewSession === 'regular' ? '今日浮动盈亏' : `${viewLabel}浮动盈亏`;

  return (
    <section className="hero-summary">
      <div className="hero-row">
        <div>
          <p className="muted">总资产净值 · {currencyLabel}</p>
          <strong>{money(context.summary.total, currency, context.masked)}</strong>
        </div>
        <div className="hero-row-actions">
          <div className="segmented session-segmented" aria-label="行情时段">
            {viewSessions.map((session) => (
              <button
                key={session}
                type="button"
                className={context.quoteViewSession === session ? 'active' : ''}
                onClick={() => context.setQuoteViewSession(session)}
              >
                {quoteViewSessionLabel(session)}
              </button>
            ))}
          </div>
          <Lock className="hero-lock" size={20} aria-hidden="true" />
        </div>
      </div>
      <div className="metric-rows">
        <div className="metric-row metric-row-primary">
          <Metric label={todayReturnLabel} value={signed(context.summary.todayReturn, currency, context.masked)} positive={context.summary.todayReturn >= 0} />
          <Metric label="总收益（估算）" value={signed(context.summary.totalReturn, currency, context.masked)} positive={context.summary.totalReturn >= 0} />
          <Metric
            label="剩余资产（估算）"
            value={context.summary.cashComplete ? money(context.summary.cash, currency, context.masked) : '--'}
            hint={context.summary.cashComplete ? undefined : `${context.summary.missingNetAssetAccounts} 个账户缺少净值`}
          />
        </div>
        <div className="metric-row metric-row-secondary">
          <Metric label={todayPnlLabel} value={signed(context.summary.todayPnl, currency, context.masked)} positive={context.summary.todayPnl >= 0} />
          <Metric label="持仓收益" value={signed(context.summary.totalPnl, currency, context.masked)} positive={context.summary.totalPnl >= 0} />
          <Metric label="已实现收益（估算）" value={signed(context.summary.realizedPnl, currency, context.masked)} positive={context.summary.realizedPnl >= 0} />
          <Metric label="持仓成本" value={money(context.summary.cost, currency, context.masked)} />
        </div>
      </div>
      <p className={`refresh-note ${context.quoteStatus === 'fallback' || context.quoteStatus === 'error' ? 'refresh-warn' : ''}`}>
        查看{viewLabel} · {marketLabel} · 10 秒自动刷新 · {statusText} · 最后更新 {context.lastRefresh}
      </p>
    </section>
  );
}

function Metric({ label, value, positive, hint }: { label: string; value: string; positive?: boolean; hint?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b className={positive === undefined ? '' : positive ? 'pos' : 'neg'}>{value}</b>
      {hint && <small>{hint}</small>}
    </div>
  );
}
