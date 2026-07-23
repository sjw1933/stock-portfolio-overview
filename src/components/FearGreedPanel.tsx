import { useEffect, useState } from 'react';
import { ExternalLink, Gauge, RefreshCw } from 'lucide-react';
import { fetchFearGreed, type FearGreedRating, type FearGreedResult } from '../utils/fearGreed';

const refreshIntervalMs = 15 * 60 * 1000;
const cnnSourceUrl = 'https://www.cnn.com/markets/fear-and-greed';
const zones = [
  { key: 'extreme-fear', label: '极度恐慌', color: '#c9344f' },
  { key: 'fear', label: '恐慌', color: '#e8753d' },
  { key: 'neutral', label: '中性', color: '#e4b83f' },
  { key: 'greed', label: '贪婪', color: '#5aa875' },
  { key: 'extreme-greed', label: '极度贪婪', color: '#168c6b' },
] as const;

export function FearGreedPanel() {
  const [wideLayout, setWideLayout] = useState(() => window.matchMedia('(min-width: 720px)').matches);
  const [data, setData] = useState<FearGreedResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const media = window.matchMedia('(min-width: 720px)');
    const handleChange = () => setWideLayout(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!wideLayout) return undefined;
    const controller = new AbortController();
    void load(false, controller.signal);
    const timer = window.setInterval(() => void load(false), refreshIntervalMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [wideLayout]);

  async function load(forceRefresh: boolean, signal?: AbortSignal) {
    setStatus('loading');
    try {
      setData(await fetchFearGreed(forceRefresh, signal));
      setStatus('ready');
    } catch (error) {
      if (signal?.aborted) return;
      console.warn('fear and greed fetch failed', error);
      setStatus('error');
    }
  }

  if (!wideLayout) return null;

  return (
    <section className="panel fear-greed-panel">
      <div className="fear-greed-header">
        <div>
          <Gauge size={19} />
          <div>
            <h2>美股市场恐慌指数</h2>
            <span>CNN Fear &amp; Greed</span>
          </div>
        </div>
        <div className="fear-greed-actions">
          <button type="button" title="刷新恐慌指数" aria-label="刷新恐慌指数" disabled={status === 'loading'} onClick={() => void load(true)}>
            <RefreshCw size={16} className={status === 'loading' ? 'spin' : ''} />
          </button>
          <a href={cnnSourceUrl} target="_blank" rel="noreferrer" title="打开 CNN 数据来源" aria-label="打开 CNN 数据来源">
            <ExternalLink size={16} />
          </a>
        </div>
      </div>

      {!data && status === 'loading' && <div className="fear-greed-empty">正在读取 CNN 市场情绪数据</div>}
      {!data && status === 'error' && (
        <div className="fear-greed-empty error">
          <b>恐慌指数暂时不可用</b>
          <span>稍后会自动重试，也可以手动刷新。</span>
        </div>
      )}

      {data && (
        <>
          <FearGreedGauge score={data.score} rating={data.rating} />
          <div className="fear-greed-history">
            <HistoryItem label="昨日" score={data.previousClose} />
            <HistoryItem label="一周前" score={data.previousWeek} />
            <HistoryItem label="一月前" score={data.previousMonth} />
            <HistoryItem label="一年前" score={data.previousYear} />
          </div>
          <div className="fear-greed-meta">
            <span className={data.cacheStatus === 'cached' ? 'cached' : ''}>{data.cacheStatus === 'cached' ? '缓存数据' : 'CNN 实时数据'}</span>
            <time dateTime={data.timestamp}>更新 {formatTime(data.timestamp)}</time>
          </div>
        </>
      )}
    </section>
  );
}

function FearGreedGauge({ score, rating }: { score: number; rating: FearGreedRating }) {
  const rounded = Math.round(score);
  const angle = 180 - (Math.min(100, Math.max(0, score)) * 1.8);
  const tip = polarPoint(angle, 82);

  return (
    <div className="fear-greed-gauge" aria-label={`当前恐慌指数 ${rounded}，${ratingLabel(rating)}`}>
      <svg viewBox="0 0 300 188" role="img">
        {zones.map((zone, index) => (
          <path
            key={zone.key}
            d={gaugeSegmentPath(180 - index * 36, 180 - (index + 1) * 36)}
            fill={zone.color}
            opacity={zone.key === rating.replace(' ', '-') ? 1 : 0.28}
            stroke={zone.key === rating.replace(' ', '-') ? zone.color : '#ffffff'}
            strokeWidth={zone.key === rating.replace(' ', '-') ? 3 : 2}
          />
        ))}
        <text x="25" y="151" className="gauge-tick">0</text>
        <text x="71" y="74" className="gauge-tick">25</text>
        <text x="150" y="39" className="gauge-tick" textAnchor="middle">50</text>
        <text x="229" y="74" className="gauge-tick" textAnchor="end">75</text>
        <text x="275" y="151" className="gauge-tick" textAnchor="end">100</text>
        <line x1="150" y1="142" x2={tip.x} y2={tip.y} className="gauge-needle" />
        <circle cx="150" cy="142" r="8" className="gauge-hub" />
        <text x="150" y="170" className="gauge-score" textAnchor="middle">{rounded}</text>
        <text x="150" y="186" className="gauge-rating" textAnchor="middle">{ratingLabel(rating)}</text>
      </svg>
    </div>
  );
}

function HistoryItem({ label, score }: { label: string; score: number }) {
  const rating = ratingFromScore(score);
  return (
    <div>
      <span>{label}</span>
      <b className={`fear-tone ${rating.replace(' ', '-')}`}>{Math.round(score)}</b>
      <em>{ratingLabel(rating)}</em>
    </div>
  );
}

function gaugeSegmentPath(startAngle: number, endAngle: number) {
  const outerStart = polarPoint(startAngle, 122);
  const outerEnd = polarPoint(endAngle, 122);
  const innerEnd = polarPoint(endAngle, 88);
  const innerStart = polarPoint(startAngle, 88);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A 122 122 0 0 0 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A 88 88 0 0 1 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

function polarPoint(angle: number, radius: number) {
  const radians = angle * Math.PI / 180;
  return {
    x: Number((150 + radius * Math.cos(radians)).toFixed(2)),
    y: Number((142 - radius * Math.sin(radians)).toFixed(2)),
  };
}

function ratingFromScore(score: number): FearGreedRating {
  if (score < 25) return 'extreme fear';
  if (score < 45) return 'fear';
  if (score < 56) return 'neutral';
  if (score < 76) return 'greed';
  return 'extreme greed';
}

function ratingLabel(rating: FearGreedRating) {
  return {
    'extreme fear': '极度恐慌',
    fear: '恐慌',
    neutral: '中性',
    greed: '贪婪',
    'extreme greed': '极度贪婪',
  }[rating];
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
