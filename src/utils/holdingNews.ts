import type { Holding, HoldingNewsResult } from '../types';
import type { NewsSourceId } from './newsSources';
import { defaultNewsSources } from './newsSources';

export async function fetchHoldingNews(
  holdings: Holding[],
  signal?: AbortSignal,
  sources: NewsSourceId[] = defaultNewsSources,
): Promise<HoldingNewsResult> {
  const response = await fetch('/api/holding-news', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      holdings,
      sources: sources.length ? sources : defaultNewsSources,
    }),
  });

  const payload = await response.json() as { code?: number; message?: string; data?: HoldingNewsResult };
  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message ?? `holding news failed: ${response.status}`);
  }

  return payload.data;
}
