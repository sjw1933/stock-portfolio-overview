import type { AiApiConfig, AskAnalysisResult, Currency, Holding, HoldingNewsItem, PortfolioSummary, QuoteStatus, RiskAlert } from '../types';

type AskAnalysisInput = {
  question: string;
  holdings: Holding[];
  summary: PortfolioSummary;
  currency: Currency;
  quoteStatus: QuoteStatus;
  lastRefresh: string;
  riskSummary: string;
  risks: Array<Pick<RiskAlert, 'level' | 'title' | 'text'>>;
  newsSummary: string;
  newsItems: HoldingNewsItem[];
  aiConfig?: AiApiConfig;
};

export async function fetchAskAnalysis(input: AskAnalysisInput, signal?: AbortSignal): Promise<AskAnalysisResult> {
  const response = await fetch('/api/risk-analysis', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const payload = await response.json() as { code?: number; message?: string; data?: AskAnalysisResult };
  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message ?? `ask analysis failed: ${response.status}`);
  }

  return payload.data;
}
