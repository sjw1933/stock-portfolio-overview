import { Activity, BrainCircuit, Minus, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppContext } from '../appContext';
import { PanelTitle } from './PanelTitle';
import { aiConfigPayload } from '../utils/aiConfig';
import {
  biasLabel,
  buildPortfolioOutlook,
  confidenceLabel,
  type OutlookBias,
  type PortfolioOutlook,
} from '../utils/holdingOutlook';
import { fetchAiHoldingOutlook } from '../utils/holdingOutlookApi';

export function HoldingOutlookPanel({ context, compact = false }: { context: AppContext; compact?: boolean }) {
  const ruleOutlook = useMemo(
    () => buildPortfolioOutlook({
      holdings: context.aggregated,
      currency: context.currency,
      totalAssets: context.summary.total,
      quoteViewSession: context.quoteViewSession,
      marketSession: context.marketSession,
    }),
    [context.aggregated, context.currency, context.summary.total, context.quoteViewSession, context.marketSession],
  );

  // Only invalidate AI when ticker set / session view changes — not on every 10s quote tick.
  const structuralKey = useMemo(
    () => JSON.stringify({
      symbols: context.aggregated.map((item) => item.symbol).sort(),
      quoteViewSession: context.quoteViewSession,
      marketSession: context.marketSession,
      currency: context.currency,
    }),
    [context.aggregated, context.quoteViewSession, context.marketSession, context.currency],
  );

  const [aiOutlook, setAiOutlook] = useState<PortfolioOutlook | null>(null);
  const [aiStructuralKey, setAiStructuralKey] = useState('');
  const [status, setStatus] = useState<'rule' | 'loading' | 'ai' | 'fallback'>('rule');
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (aiStructuralKey && aiStructuralKey !== structuralKey) {
      setAiOutlook(null);
      setAiStructuralKey('');
      setStatus('rule');
      setError('');
    }
  }, [structuralKey, aiStructuralKey]);

  const outlook = useMemo(() => {
    if (aiOutlook && aiStructuralKey === structuralKey) {
      return blendLiveMetrics(aiOutlook, ruleOutlook);
    }
    return ruleOutlook;
  }, [aiOutlook, aiStructuralKey, structuralKey, ruleOutlook]);

  async function runAiOutlook() {
    if (!ruleOutlook.items.length || status === 'loading') return;
    const requestId = ++requestIdRef.current;
    const keyAtStart = structuralKey;
    setStatus('loading');
    setError('');
    try {
      const result = await fetchAiHoldingOutlook({
        ruleOutlook,
        quoteViewSession: context.quoteViewSession,
        marketSession: context.marketSession,
        currency: context.currency,
        ...aiConfigPayload(context.aiConfig),
      });
      if (requestId !== requestIdRef.current) return;
      if (keyAtStart !== structuralKey) return;

      if (result.source === 'ai') {
        setAiOutlook(result);
        setAiStructuralKey(keyAtStart);
        setStatus('ai');
        setError('');
      } else {
        setAiOutlook(null);
        setAiStructuralKey('');
        setStatus('fallback');
        setError(stripFallbackMessage(result.summary) || 'AI 暂不可用，已回退规则预判');
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.warn('ai holding outlook failed', err);
      setAiOutlook(null);
      setAiStructuralKey('');
      setStatus('fallback');
      setError(err instanceof Error ? err.message : 'AI 预判失败');
    }
  }

  const rows = compact ? outlook.items.slice(0, 4) : outlook.items;
  const sourceAction = status === 'ai' && outlook.model
    ? `AI · ${outlook.model}`
    : status === 'loading'
      ? 'AI 分析中'
      : status === 'fallback'
        ? '规则回退'
        : `${outlook.sessionLabel} · 规则预判`;

  return (
    <section className={`panel outlook-panel ${compact ? 'compact' : ''} source-${status}`}>
      <PanelTitle icon={Activity} title="今日持仓走势预判" action={sourceAction} />

      <div className="outlook-actions">
        <button
          type="button"
          className={`outlook-ai-button ${status === 'ai' ? 'active' : ''}`}
          onClick={() => void runAiOutlook()}
          disabled={status === 'loading' || !ruleOutlook.items.length}
        >
          {status === 'loading' ? <RefreshCw size={15} className="spin" /> : <BrainCircuit size={15} />}
          {status === 'loading' ? 'AI 分析中…' : status === 'ai' ? '重新 AI 预判' : '接入 AI 预判'}
        </button>
        <span className={`outlook-source-pill source-${status}`}>
          {status === 'ai' ? `已接入 ${outlook.model || 'AI'}` : status === 'loading' ? '请求中' : status === 'fallback' ? 'AI 未成功' : '当前：规则预判'}
        </span>
        <span className="outlook-ai-hint">
          {context.aiConfig.apiKey ? '使用页面 AI 配置' : '使用服务器默认模型'}
        </span>
      </div>

      <div className={`outlook-summary bias-${outlook.bias}`}>
        <div className="outlook-summary-main">
          <em className={`outlook-bias bias-${outlook.bias}`}>{biasLabel(outlook.bias)}</em>
          <div>
            <b>组合整体{biasLabel(outlook.bias)}</b>
            <span>
              信心 {confidenceLabel(outlook.confidence)} · 偏多 {outlook.bullishCount} · 偏空 {outlook.bearishCount} · 震荡 {outlook.neutralCount}
              {status === 'ai' && outlook.model ? ` · ${outlook.model}` : ''}
            </span>
          </div>
        </div>
        <p>{outlook.summary}</p>
        {error && <small className="outlook-error">{error}</small>}
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

      <p className="outlook-note">
        默认规则预判；点「接入 AI 预判」后调用服务器 OpenAI 兼容 / Anthropic 模型。
        行情刷新不会清掉 AI 结果。不构成投资建议。
      </p>
    </section>
  );
}

/** Keep AI bias/reasons, refresh live weight/todayRate from latest rules. */
function blendLiveMetrics(ai: PortfolioOutlook, rule: PortfolioOutlook): PortfolioOutlook {
  const liveBySymbol = new Map(rule.items.map((item) => [item.symbol, item]));
  const items = ai.items.map((item) => {
    const live = liveBySymbol.get(item.symbol);
    if (!live) return item;
    return {
      ...item,
      name: live.name,
      type: live.type,
      todayRate: live.todayRate,
      weight: live.weight,
    };
  });
  return {
    ...ai,
    sessionLabel: rule.sessionLabel,
    items,
    bullishCount: items.filter((item) => item.bias === 'bullish').length,
    bearishCount: items.filter((item) => item.bias === 'bearish').length,
    neutralCount: items.filter((item) => item.bias === 'neutral').length,
  };
}

function stripFallbackMessage(summary: string) {
  const match = summary.match(/AI 暂不可用[:：]\s*(.+)$/);
  return match?.[1]?.trim() || '';
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
