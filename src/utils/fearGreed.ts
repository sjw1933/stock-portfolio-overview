export type FearGreedRating = 'extreme fear' | 'fear' | 'neutral' | 'greed' | 'extreme greed';

export type FearGreedResult = {
  score: number;
  rating: FearGreedRating;
  timestamp: string;
  previousClose: number;
  previousWeek: number;
  previousMonth: number;
  previousYear: number;
  fetchedAt: string;
  cacheStatus: 'live' | 'cached';
};

export async function fetchFearGreed(forceRefresh = false, signal?: AbortSignal): Promise<FearGreedResult> {
  const suffix = forceRefresh ? '?refresh=1' : '';
  const response = await fetch(`/api/fear-greed${suffix}`, { signal, cache: 'no-store' });
  const payload = await response.json() as { code?: number; message?: string; data?: FearGreedResult };
  if (!response.ok || payload.code !== 0 || !payload.data) {
    throw new Error(payload.message ?? `Fear & Greed request failed: ${response.status}`);
  }
  return payload.data;
}
