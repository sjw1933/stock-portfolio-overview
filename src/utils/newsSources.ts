export type NewsSourceId = 'tencent' | 'investing' | 'yahoo' | 'google';

export type NewsSourceOption = {
  id: NewsSourceId;
  label: string;
  hint: string;
};

/** Default: include Tencent for CN access, keep Investing; Yahoo/Google optional. */
export const defaultNewsSources: NewsSourceId[] = ['tencent', 'investing'];

export const newsSourceOptions: NewsSourceOption[] = [
  { id: 'tencent', label: '腾讯财经', hint: '国内可访问' },
  { id: 'investing', label: 'Investing', hint: '英/中 RSS' },
  { id: 'yahoo', label: 'Yahoo', hint: '按 ticker' },
  { id: 'google', label: 'Google 新闻', hint: '按 ticker' },
];

const allSourceIds = newsSourceOptions.map((item) => item.id);
const newsSourcesKey = 'gup-holding-news-sources-v1';

export function readNewsSources(): NewsSourceId[] {
  try {
    const raw = localStorage.getItem(newsSourcesKey);
    if (!raw) return [...defaultNewsSources];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...defaultNewsSources];
    const selected = parsed.filter((item): item is NewsSourceId => allSourceIds.includes(item as NewsSourceId));
    return selected.length ? selected : [...defaultNewsSources];
  } catch {
    return [...defaultNewsSources];
  }
}

export function writeNewsSources(sources: NewsSourceId[]) {
  const next = sources.filter((item) => allSourceIds.includes(item));
  localStorage.setItem(newsSourcesKey, JSON.stringify(next.length ? next : defaultNewsSources));
}

export function toggleNewsSource(current: NewsSourceId[], id: NewsSourceId): NewsSourceId[] {
  if (current.includes(id)) {
    const next = current.filter((item) => item !== id);
    // Keep at least one source.
    return next.length ? next : current;
  }
  return [...current, id];
}

export function newsSourcesLabel(sources: NewsSourceId[]) {
  if (!sources.length) return '未选源';
  return sources
    .map((id) => newsSourceOptions.find((item) => item.id === id)?.label || id)
    .join(' · ');
}
