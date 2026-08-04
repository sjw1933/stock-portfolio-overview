import type { AggregatedHolding, Currency, MarketSession, QuoteViewSession } from '../types';
import { convert } from './currency';
import { quoteViewSessionLabel } from './quotes';

export type OutlookBias = 'bullish' | 'bearish' | 'neutral';
export type OutlookConfidence = 'high' | 'medium' | 'low';

export type HoldingOutlookItem = {
  symbol: string;
  name: string;
  type: AggregatedHolding['type'];
  bias: OutlookBias;
  confidence: OutlookConfidence;
  score: number;
  todayRate: number | null;
  weight: number;
  reasons: string[];
};

export type PortfolioOutlook = {
  bias: OutlookBias;
  confidence: OutlookConfidence;
  score: number;
  summary: string;
  sessionLabel: string;
  items: HoldingOutlookItem[];
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  /** rule = local heuristics; ai = LLM enhanced; fallback = AI failed then rules */
  source?: 'rule' | 'ai' | 'fallback';
  model?: string;
};

type BuildOutlookInput = {
  holdings: AggregatedHolding[];
  currency: Currency;
  totalAssets: number;
  quoteViewSession: QuoteViewSession;
  marketSession: MarketSession;
};

export function biasLabel(bias: OutlookBias) {
  return bias === 'bullish' ? '偏多' : bias === 'bearish' ? '偏空' : '震荡';
}

export function confidenceLabel(confidence: OutlookConfidence) {
  return confidence === 'high' ? '高' : confidence === 'medium' ? '中' : '低';
}

/** Rule-based intraday outlook from live marks — not investment advice. */
export function buildPortfolioOutlook(input: BuildOutlookInput): PortfolioOutlook {
  const sessionLabel = quoteViewSessionLabel(input.quoteViewSession);
  const total = Math.max(input.totalAssets, 0.000001);
  const gross = input.holdings.reduce(
    (sum, item) => sum + convert(item.marketValue, item.currency, input.currency),
    0,
  );

  const items = input.holdings
    .map((holding) => buildHoldingOutlook(holding, input, total, gross))
    .sort((a, b) => b.weight - a.weight || Math.abs(b.score) - Math.abs(a.score));

  const weightedScore = items.reduce((sum, item) => sum + item.score * (item.weight / 100), 0);
  const bias = scoreToBias(weightedScore);
  const confidence = portfolioConfidence(items, input.marketSession);
  const bullishCount = items.filter((item) => item.bias === 'bullish').length;
  const bearishCount = items.filter((item) => item.bias === 'bearish').length;
  const neutralCount = items.filter((item) => item.bias === 'neutral').length;
  const focus = items[0];

  const summary = items.length
    ? `${sessionLabel}口径下组合整体${biasLabel(bias)}（信心${confidenceLabel(confidence)}）。偏多 ${bullishCount} / 偏空 ${bearishCount} / 震荡 ${neutralCount}。${
      focus
        ? `优先关注 ${focus.symbol}（${biasLabel(focus.bias)}，仓位约 ${focus.weight.toFixed(1)}%）。`
        : ''
    }规则预判，仅供复盘参考。`
    : '当前没有持仓，暂无法生成走势预判。';

  return {
    bias,
    confidence,
    score: weightedScore,
    summary,
    sessionLabel,
    items: items.slice(0, 8),
    bullishCount,
    bearishCount,
    neutralCount,
    source: 'rule',
  };
}

export function mergeAiOutlook(
  base: PortfolioOutlook,
  ai: Partial<PortfolioOutlook> & { items?: Array<Partial<HoldingOutlookItem> & { symbol?: string }> },
  model: string,
): PortfolioOutlook {
  const bySymbol = new Map((ai.items || []).map((item) => [String(item.symbol || '').toUpperCase(), item]));
  const items = base.items.map((item) => {
    const patch = bySymbol.get(item.symbol.toUpperCase());
    if (!patch) return item;
    const bias = normalizeBias(patch.bias) ?? item.bias;
    const confidence = normalizeConfidence(patch.confidence) ?? item.confidence;
    const reasons = Array.isArray(patch.reasons)
      ? patch.reasons.map((reason) => String(reason || '').trim()).filter(Boolean).slice(0, 3)
      : item.reasons;
    return {
      ...item,
      bias,
      confidence,
      reasons: reasons.length ? reasons : item.reasons,
      score: typeof patch.score === 'number' && Number.isFinite(patch.score) ? patch.score : item.score,
    };
  });

  const bullishCount = items.filter((item) => item.bias === 'bullish').length;
  const bearishCount = items.filter((item) => item.bias === 'bearish').length;
  const neutralCount = items.filter((item) => item.bias === 'neutral').length;
  const bias = normalizeBias(ai.bias) ?? scoreToBias(items.reduce((sum, item) => sum + item.score * (item.weight / 100), 0));
  const confidence = normalizeConfidence(ai.confidence) ?? base.confidence;
  const summary = String(ai.summary || '').replace(/\s+/g, ' ').trim().slice(0, 280)
    || `${base.sessionLabel}口径 AI 预判：组合整体${biasLabel(bias)}（信心${confidenceLabel(confidence)}）。`;

  return {
    ...base,
    bias,
    confidence,
    summary: summary.includes('投资建议') ? summary : `${summary} 模型辅助，仅供复盘参考。`,
    items,
    bullishCount,
    bearishCount,
    neutralCount,
    source: 'ai',
    model,
    score: typeof ai.score === 'number' && Number.isFinite(ai.score) ? ai.score : base.score,
  };
}

function normalizeBias(value: unknown): OutlookBias | null {
  if (value === 'bullish' || value === 'bearish' || value === 'neutral') return value;
  if (value === '偏多') return 'bullish';
  if (value === '偏空') return 'bearish';
  if (value === '震荡' || value === '中性') return 'neutral';
  return null;
}

function normalizeConfidence(value: unknown): OutlookConfidence | null {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  if (value === '高') return 'high';
  if (value === '中') return 'medium';
  if (value === '低') return 'low';
  return null;
}

function buildHoldingOutlook(
  holding: AggregatedHolding,
  input: BuildOutlookInput,
  totalAssets: number,
  gross: number,
): HoldingOutlookItem {
  const marketValue = convert(holding.marketValue, holding.currency, input.currency);
  const todayPnl = convert(holding.todayPnl, holding.currency, input.currency);
  const weightBase = gross > 0.000001 ? gross : totalAssets;
  const weight = weightBase > 0.000001 ? (marketValue / weightBase) * 100 : 0;
  const todayBase = marketValue - todayPnl;
  const todayRate = Math.abs(todayBase) > 0.000001 ? (todayPnl / todayBase) * 100 : null;
  const costGap = holding.cost > 0 ? ((holding.price - holding.cost) / holding.cost) * 100 : null;

  let score = 0;
  const reasons: string[] = [];

  if (todayRate !== null) {
    if (todayRate >= 2) {
      score += 2.2;
      reasons.push(`${input.quoteViewSession === 'regular' ? '今日' : quoteViewSessionLabel(input.quoteViewSession)}涨幅 ${formatPct(todayRate)}，短线动量偏强`);
    } else if (todayRate >= 0.4) {
      score += 1.1;
      reasons.push(`${input.quoteViewSession === 'regular' ? '今日' : quoteViewSessionLabel(input.quoteViewSession)}小幅收红 ${formatPct(todayRate)}`);
    } else if (todayRate <= -2) {
      score -= 2.2;
      reasons.push(`${input.quoteViewSession === 'regular' ? '今日' : quoteViewSessionLabel(input.quoteViewSession)}回撤 ${formatPct(todayRate)}，短线承压`);
    } else if (todayRate <= -0.4) {
      score -= 1.1;
      reasons.push(`${input.quoteViewSession === 'regular' ? '今日' : quoteViewSessionLabel(input.quoteViewSession)}小幅走弱 ${formatPct(todayRate)}`);
    } else {
      reasons.push(`${input.quoteViewSession === 'regular' ? '今日' : quoteViewSessionLabel(input.quoteViewSession)}波动有限 ${formatPct(todayRate)}`);
    }
  } else {
    reasons.push('暂无可用涨跌幅，按仓位与结构做弱信号预判');
  }

  if (costGap !== null) {
    if (costGap >= 12) {
      score += 0.5;
      reasons.push(`浮盈约 ${formatPct(costGap)}，趋势尚未明显破坏`);
    } else if (costGap <= -12) {
      score -= 0.7;
      reasons.push(`浮亏约 ${formatPct(costGap)}，反弹前更宜控制节奏`);
    }
  }

  if (holding.type === '杠杆ETF') {
    score *= 1.25;
    reasons.push('杠杆 ETF，方向信号会被放大，波动风险更高');
  } else if (holding.type === 'ETF') {
    score *= 0.9;
    reasons.push('宽基/行业 ETF，波动通常低于单一个股');
  }

  if (weight >= 30) {
    score *= 1.05;
    reasons.push(`仓位较重（约 ${weight.toFixed(1)}%），组合弹性主要看它`);
  } else if (weight >= 15) {
    reasons.push(`中等仓位（约 ${weight.toFixed(1)}%），对组合有实质影响`);
  }

  if (input.marketSession === 'pre') {
    reasons.push('当前美股盘前，信号偏早盘预期，正式开盘后可能纠偏');
    score *= 0.92;
  } else if (input.marketSession === 'post') {
    reasons.push('当前美股盘后，信号反映收盘后情绪，隔夜仍有变数');
    score *= 0.95;
  } else if (input.marketSession === 'closed') {
    reasons.push('非交易时段，预判基于最近可用报价，次日需再确认');
    score *= 0.88;
  }

  // Soft clamp so extreme leverage does not produce absurd scores.
  score = Math.max(-4, Math.min(4, score));
  const bias = scoreToBias(score);
  const confidence = holdingConfidence(score, todayRate, weight, input.marketSession);

  return {
    symbol: holding.symbol,
    name: holding.name,
    type: holding.type,
    bias,
    confidence,
    score,
    todayRate,
    weight,
    reasons: reasons.slice(0, 3),
  };
}

function scoreToBias(score: number): OutlookBias {
  if (score >= 0.85) return 'bullish';
  if (score <= -0.85) return 'bearish';
  return 'neutral';
}

function holdingConfidence(
  score: number,
  todayRate: number | null,
  weight: number,
  marketSession: MarketSession,
): OutlookConfidence {
  const strength = Math.abs(score);
  let points = 0;
  if (strength >= 2) points += 2;
  else if (strength >= 1) points += 1;
  if (todayRate !== null && Math.abs(todayRate) >= 1) points += 1;
  if (weight >= 12) points += 1;
  if (marketSession === 'regular') points += 1;
  if (marketSession === 'closed') points -= 1;

  if (points >= 4) return 'high';
  if (points >= 2) return 'medium';
  return 'low';
}

function portfolioConfidence(items: HoldingOutlookItem[], marketSession: MarketSession): OutlookConfidence {
  if (!items.length) return 'low';
  const highShare = items.filter((item) => item.confidence === 'high').length / items.length;
  const agreement = Math.max(
    items.filter((item) => item.bias === 'bullish').length,
    items.filter((item) => item.bias === 'bearish').length,
    items.filter((item) => item.bias === 'neutral').length,
  ) / items.length;

  if (highShare >= 0.4 && agreement >= 0.5 && marketSession === 'regular') return 'high';
  if (agreement >= 0.4 || highShare >= 0.25) return 'medium';
  return 'low';
}

function formatPct(value: number) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}
