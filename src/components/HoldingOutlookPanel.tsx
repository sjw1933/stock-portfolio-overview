import { Activity, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { useMemo } from 'react';
import type { AppContext } from '../appContext';
import { PanelTitle } from './PanelTitle';
import {
  biasLabel,
  buildPortfolioOutlook,
  confidenceLabel,
  type OutlookBias,
} from '../utils/holdingOutlook';

export function HoldingOutlookPanel({ context, compact = false }: { context: AppContext; compact?: boolean }) {
  const outlook = useMemo(
    () => buildPortfolioOutlook({
      holdings: context.aggregated,
      currency: context.currency,
      totalAssets: context.summary.total,
      quoteViewSession: context.quoteViewSession,
      marketSession: context.marketSession,
    }),
    [context.aggregated, context.currency, context.summary.total, context.quoteViewSession, context.marketSession],
  );

  const rows = compact ? outlook.items.slice(0, 4) : outlook.items;

  return (
    <section className={`panel outlook-panel ${compact ? 'compact' : ''}`}>
      <PanelTitle icon={Activity} title="今日持仓走势预判" action={`${outlook.sessionLabel} · 规则预判`} />

      <div className={`outlook-summary bias-${outlook.bias}`}>
        <div className="outlook-summary-main">
          <em className={`outlook-bias bias-${outlook.bias}`}>{biasLabel(outlook.bias)}</em>
          <div>
            <b>组合整体{biasLabel(outlook.bias)}</b>
            <span>信心 {confidenceLabel(outlook.confidence)} · 偏多 {outlook.bullishCount} · 偏空 {outlook.bearishCount} · 震荡 {outlook.neutralCount}</span>
          </div>
        </div>
        <p>{outlook.summary}</p>
      </div>

      {!rows.length ? (
        <div className="outlook-empty">
          <b>暂无持仓预判</b>
          <span>导入或同步持仓后，会按今日涨跌与仓位结构生成短线预判。</span>
        </div>
      ) : (
        <div className="outlook-list">
          {rows.map((item) => (
            <article className="outlook-row" key={item.symbol}>
              <div className="outlook-row-head">
                <div className="outlook-name">
                  <b>{item.name}</b>
                  <span>{item.symbol}</span>
                </div>
                <div className="outlook-tags">
                  <em className={`outlook-bias bias-${item.bias}`}>
                    <BiasIcon bias={item.bias} />
                    {biasLabel(item.bias)}
                  </em>
                  <span className={`outlook-confidence conf-${item.confidence}`}>信心{confidenceLabel(item.confidence)}</span>
                </div>
              </div>
              <div className="outlook-metrics">
                <span>仓位 {item.weight.toFixed(1)}%</span>
                <span className={item.todayRate === null ? '' : item.todayRate >= 0 ? 'pos' : 'neg'}>
                  {outlook.sessionLabel} {item.todayRate === null ? '--' : formatSignedPct(item.todayRate)}
                </span>
                <span>{item.type}</span>
              </div>
              <ul className="outlook-reasons">
                {item.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}

      <p className="outlook-note">基于当前报价、今日盈亏与仓位权重的规则预判，不构成投资建议；开盘后请结合实时盘口复核。</p>
    </section>
  );
}

function BiasIcon({ bias }: { bias: OutlookBias }) {
  if (bias === 'bullish') return <TrendingUp size={12} aria-hidden="true" />;
  if (bias === 'bearish') return <TrendingDown size={12} aria-hidden="true" />;
  return <Minus size={12} aria-hidden="true" />;
}

function formatSignedPct(value: number) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}
