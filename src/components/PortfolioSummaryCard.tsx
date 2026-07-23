import { Lock } from 'lucide-react';
import type { AppContext } from '../appContext';
import { money, signed } from '../utils/currency';

export function PortfolioSummaryCard({ context }: { context: AppContext }) {
  const currency = context.currency;
  const statusText = {
    idle: '等待首次刷新',
    refreshing: '行情刷新中',
    live: '实时行情已更新',
    fallback: '行情刷新失败，使用截图价格',
    error: '行情异常',
  }[context.quoteStatus];

  return (
    <section className="hero-summary">
      <div className="hero-row">
        <div>
          <p className="muted">总资产净值 · 默认港币</p>
          <strong>{money(context.summary.total, currency, context.masked)}</strong>
        </div>
        <Lock size={20} />
      </div>
      <div className="metric-grid">
        <Metric label="今日浮动盈亏" value={signed(context.summary.todayPnl, currency, context.masked)} positive={context.summary.todayPnl >= 0} />
        <Metric label="今日已实现" value={signed(context.summary.todayRealizedPnl, currency, context.masked)} positive={context.summary.todayRealizedPnl >= 0} />
        <Metric label="持仓成本" value={money(context.summary.cost, currency, context.masked)} />
        <Metric
          label="剩余资产（估算）"
          value={context.summary.cashComplete ? money(context.summary.cash, currency, context.masked) : '--'}
          hint={context.summary.cashComplete ? undefined : `${context.summary.missingNetAssetAccounts} 个账户缺少净值`}
        />
        <Metric label="持仓收益" value={signed(context.summary.totalPnl, currency, context.masked)} positive={context.summary.totalPnl >= 0} />
        <Metric label="已实现收益（估算）" value={signed(context.summary.realizedPnl, currency, context.masked)} positive={context.summary.realizedPnl >= 0} />
        <Metric label="总收益（估算）" value={signed(context.summary.totalReturn, currency, context.masked)} positive={context.summary.totalReturn >= 0} />
      </div>
      <p className={`refresh-note ${context.quoteStatus === 'fallback' || context.quoteStatus === 'error' ? 'refresh-warn' : ''}`}>
        10 秒自动刷新 · {statusText} · 最后更新 {context.lastRefresh}
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
