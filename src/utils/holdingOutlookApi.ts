import type { AiApiConfig } from '../types';
import type { PortfolioOutlook } from './holdingOutlook';

export type HoldingOutlookRequest = {
  ruleOutlook: PortfolioOutlook;
  quoteViewSession: string;
  marketSession: string;
  currency: string;
  aiConfig?: AiApiConfig;
};

export async function fetchAiHoldingOutlook(
  input: HoldingOutlookRequest,
  signal?: AbortSignal,
): Promise<PortfolioOutlook> {
  const response = await fetch('/api/holding-outlook', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as { code?: number; message?: string; data?: PortfolioOutlook };
  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message ?? `holding outlook failed: ${response.status}`);
  }
  return payload.data;
}
