import type { AiApiConfig, Currency, Holding, PortfolioSummary, QuoteStatus, RiskAnalysisResult } from '../types';

type RiskAnalysisInput = {
  holdings: Holding[];
  summary: PortfolioSummary;
  currency: Currency;
  quoteStatus: QuoteStatus;
  lastRefresh: string;
  aiConfig?: AiApiConfig;
};

export async function fetchRiskAnalysis(input: RiskAnalysisInput, signal?: AbortSignal): Promise<RiskAnalysisResult> {
  const response = await fetch('/api/risk-analysis', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const payload = await response.json() as { code?: number; message?: string; data?: RiskAnalysisResult };
  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message ?? `risk analysis failed: ${response.status}`);
  }

  return payload.data;
}
