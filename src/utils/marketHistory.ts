export type TrendPeriod = 'minute' | 'fiveDay' | 'day' | 'week' | 'month';

export type TrendPoint = {
  key: string;
  label: string;
  date?: string;
  price: number;
  avg?: number;
  volume: number;
  amount?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  rsi6?: number;
  rsi12?: number;
  rsi24?: number;
  direction: 'up' | 'down';
};

export type TrendSeries = {
  symbol: string;
  period: TrendPeriod;
  points: TrendPoint[];
  latest: number;
  previous: number;
  change: number;
  changePct: number;
  average?: number;
  totalVolume: number;
  fetchedAt: string;
};

const nasdaqSymbolByLocalSymbol: Record<string, { symbol: string; assetClass: 'stocks' | 'etf' }> = {
  'AAPL.US': { symbol: 'AAPL', assetClass: 'stocks' },
  'QQQ.US': { symbol: 'QQQ', assetClass: 'etf' },
  'VOO.US': { symbol: 'VOO', assetClass: 'etf' },
};

const klineTypeByPeriod: Partial<Record<TrendPeriod, string>> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

export function supportsMarketHistory(symbol: string) {
  return Boolean(toTencentCode(symbol) || toUsTicker(symbol));
}

export async function fetchMarketHistory(symbol: string, period: TrendPeriod, signal?: AbortSignal): Promise<TrendSeries> {
  const code = toTencentCode(symbol);
  if (!code) return fetchNasdaqSeries(symbol, period, signal);

  if (period === 'minute') return fetchMinuteSeries(symbol, code, signal);
  if (period === 'fiveDay') return fetchFiveDaySeries(symbol, code, signal);
  return fetchKlineSeries(symbol, code, period, signal);
}

function toTencentCode(symbol: string) {
  const normalized = symbol.toUpperCase();
  const hk = normalized.match(/^(\d{1,5})\.HK$/);
  if (hk) return `hk${hk[1].padStart(5, '0')}`;
  const sz = normalized.match(/^(\d{6})\.SZ$/);
  if (sz) return `sz${sz[1]}`;
  const sh = normalized.match(/^(\d{6})\.(SS|SH)$/);
  if (sh) return `sh${sh[1]}`;
  return '';
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`行情请求失败：${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchMinuteSeries(symbol: string, code: string, signal?: AbortSignal): Promise<TrendSeries> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(code)}`;
  const payload = await fetchJson<TencentMinutePayload>(url, signal);
  const rows = payload.data?.[code]?.data?.data ?? [];
  const points = parseMinuteRows(rows, currentDateKey());
  return buildSeries(symbol, 'minute', points);
}

async function fetchFiveDaySeries(symbol: string, code: string, signal?: AbortSignal): Promise<TrendSeries> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${encodeURIComponent(code)}`;
  const payload = await fetchJson<TencentDayPayload>(url, signal);
  const days = payload.data?.[code]?.data ?? [];
  const points = days.flatMap((day) => parseMinuteRows(day.data ?? [], day.date));
  return buildSeries(symbol, 'fiveDay', points);
}

async function fetchKlineSeries(symbol: string, code: string, period: TrendPeriod, signal?: AbortSignal): Promise<TrendSeries> {
  const type = klineTypeByPeriod[period];
  if (!type) throw new Error('不支持的行情周期');

  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${encodeURIComponent(`${code},${type},,,320`)}`;
  const payload = await fetchJson<TencentKlinePayload>(url, signal);
  const rows = payload.data?.[code]?.[type] ?? [];
  const points = rows.map((row, index) => {
    const open = toNumber(row[1]);
    const close = toNumber(row[2]);
    const high = toNumber(row[3]);
    const low = toNumber(row[4]);
    const volume = toNumber(row[5]);
    const previousClose = index > 0 ? toNumber(rows[index - 1][2]) : open;
    return {
      key: row[0],
      label: row[0].slice(5),
      date: row[0],
      price: close,
      open,
      high,
      low,
      close,
      avg: movingAverage(rows, index, 5),
      volume,
      direction: close >= previousClose ? 'up' : 'down',
    } satisfies TrendPoint;
  });
  return buildSeries(symbol, period, points);
}

async function fetchNasdaqSeries(symbol: string, period: TrendPeriod, signal?: AbortSignal): Promise<TrendSeries> {
  const remote = nasdaqSymbolByLocalSymbol[symbol] ?? buildUsRemoteSymbol(symbol);
  if (!remote) throw new Error(`${symbol} 暂未接入历史行情`);
  if (period === 'minute') {
    return fetchNasdaqMinuteSeries(symbol, signal);
  }

  const url = `/api/market-history?symbol=${encodeURIComponent(symbol)}&period=${encodeURIComponent(period)}`;
  const response = await fetchJson<{ code: number; message?: string; data?: NasdaqHistoricalPayload }>(url, signal);
  if (response.code !== 0 || !response.data) throw new Error(response.message ?? '美股历史行情加载失败');
  const payload = response.data;
  const rows = payload.data?.tradesTable?.rows ?? [];
  const dailyPoints = rows.map(parseNasdaqRow).filter(Boolean).reverse() as TrendPoint[];
  const points = period === 'fiveDay' ? dailyPoints.slice(-5) : period === 'day' ? dailyPoints : aggregatePeriodPoints(dailyPoints, period);
  return buildSeries(symbol, period, points);
}

async function fetchNasdaqMinuteSeries(symbol: string, signal?: AbortSignal): Promise<TrendSeries> {
  const url = `/api/market-history?symbol=${encodeURIComponent(symbol)}&period=minute`;
  const response = await fetchJson<{ code: number; message?: string; data?: NasdaqChartPayload }>(url, signal);
  if (response.code !== 0 || !response.data) throw new Error(response.message ?? '美股分时行情加载失败');
  const chartPoints = response.data.data?.chart ?? [];
  const points = chartPoints.map((point, index) => {
    const price = toNumber(point.y ?? point.z?.value);
    const previous = index > 0 ? toNumber(chartPoints[index - 1].y ?? chartPoints[index - 1].z?.value) : price;
    const date = formatTimestampDate(point.x);
    return {
      key: `${point.x ?? index}`,
      label: formatTimestampTime(point.x, point.z?.dateTime),
      date,
      price,
      open: previous,
      high: Math.max(price, previous),
      low: Math.min(price, previous),
      close: price,
      avg: movingAverageNumbers(chartPoints.map((item) => toNumber(item.y ?? item.z?.value)), index, 20),
      volume: 0,
      direction: price >= previous ? 'up' : 'down',
    } satisfies TrendPoint;
  });
  return buildSeries(symbol, 'minute', points);
}

function buildUsRemoteSymbol(symbol: string) {
  const ticker = toUsTicker(symbol);
  if (!ticker) return null;
  return { symbol: ticker, assetClass: guessUsAssetClass(ticker) } as const;
}

function toUsTicker(symbol: string) {
  const match = String(symbol || '').toUpperCase().match(/^([A-Z][A-Z0-9.-]{0,9})\.US$/);
  return match?.[1] ?? '';
}

function guessUsAssetClass(ticker: string): 'stocks' | 'etf' {
  if (ticker.endsWith('Q') || ['QQQ', 'VOO', 'SPY', 'DIA', 'IWM', 'VTI'].includes(ticker)) return 'etf';
  return 'stocks';
}

function parseNasdaqRow(row: NasdaqHistoricalRow): TrendPoint | null {
  const date = parseUsDate(row.date);
  const open = parseMarketNumber(row.open);
  const close = parseMarketNumber(row.close);
  const high = parseMarketNumber(row.high);
  const low = parseMarketNumber(row.low);
  const volume = parseMarketNumber(row.volume);
  if (!date || close <= 0) return null;
  return {
    key: date,
    label: date.slice(5),
    date,
    price: close,
    open,
    high,
    low,
    close,
    avg: close,
    volume,
    direction: close >= open ? 'up' : 'down',
  };
}

function aggregatePeriodPoints(points: TrendPoint[], period: 'week' | 'month'): TrendPoint[] {
  const groups = new Map<string, TrendPoint[]>();
  for (const point of points) {
    const key = period === 'week' ? weekKey(point.date ?? point.key) : (point.date ?? point.key).slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }

  return Array.from(groups.entries()).map(([key, group]) => {
    const first = group[0];
    const last = group[group.length - 1];
    const open = first.open ?? first.price;
    const close = last.close ?? last.price;
    const high = Math.max(...group.map((point) => point.high ?? point.price));
    const low = Math.min(...group.map((point) => point.low ?? point.price));
    const volume = group.reduce((total, point) => total + point.volume, 0);
    return {
      key,
      label: key.slice(5),
      date: last.date,
      price: close,
      open,
      high,
      low,
      close,
      avg: close,
      volume,
      direction: close >= open ? 'up' : 'down',
    } satisfies TrendPoint;
  });
}

function parseMinuteRows(rows: string[], date: string): TrendPoint[] {
  let previousVolume = 0;
  let previousPrice = 0;
  return rows.map((row) => {
    const [time = '', priceRaw = '', cumulativeVolumeRaw = '', amountRaw = ''] = row.split(' ');
    const price = toNumber(priceRaw);
    const cumulativeVolume = toNumber(cumulativeVolumeRaw);
    const amount = toNumber(amountRaw);
    const volume = Math.max(0, cumulativeVolume - previousVolume);
    const avg = cumulativeVolume > 0 ? amount / cumulativeVolume : price;
    const point: TrendPoint = {
      key: `${date}-${time}`,
      label: formatMinuteLabel(time, date),
      date,
      price,
      avg,
      volume,
      amount,
      direction: previousPrice === 0 || price >= previousPrice ? 'up' : 'down',
    };
    previousVolume = cumulativeVolume;
    previousPrice = price;
    return point;
  });
}

function buildSeries(symbol: string, period: TrendPeriod, points: TrendPoint[]): TrendSeries {
  const cleanPoints = appendRsi(points.filter((point) => Number.isFinite(point.price) && point.price > 0));
  if (!cleanPoints.length) throw new Error('没有可用行情数据');

  const latestPoint = cleanPoints[cleanPoints.length - 1];
  const previous = period === 'minute' || period === 'fiveDay'
    ? cleanPoints[0].price
    : cleanPoints.length > 1 ? cleanPoints[cleanPoints.length - 2].price : cleanPoints[0].price;
  const latest = latestPoint.price;
  const change = latest - previous;
  const totalVolume = cleanPoints.reduce((sum, point) => sum + point.volume, 0);

  return {
    symbol,
    period,
    points: cleanPoints,
    latest,
    previous,
    change,
    changePct: previous ? (change / previous) * 100 : 0,
    average: latestPoint.avg,
    totalVolume,
    fetchedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
}

function appendRsi(points: TrendPoint[]): TrendPoint[] {
  const prices = points.map((point) => point.price);
  const rsi6 = calculateRsi(prices, 6);
  const rsi12 = calculateRsi(prices, 12);
  const rsi24 = calculateRsi(prices, 24);
  return points.map((point, index) => ({
    ...point,
    rsi6: rsi6[index],
    rsi12: rsi12[index],
    rsi24: rsi24[index],
  }));
}

function calculateRsi(values: number[], period: number): Array<number | undefined> {
  return values.map((_, index) => {
    if (index < period) return undefined;
    let gains = 0;
    let losses = 0;
    for (let i = index - period + 1; i <= index; i += 1) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return Number((100 - 100 / (1 + rs)).toFixed(3));
  });
}

function movingAverage(rows: string[][], index: number, windowSize: number) {
  const start = Math.max(0, index - windowSize + 1);
  const slice = rows.slice(start, index + 1);
  const sum = slice.reduce((total, row) => total + toNumber(row[2]), 0);
  return Number((sum / slice.length).toFixed(3));
}

function movingAverageNumbers(values: Array<number | null | undefined>, index: number, windowSize: number) {
  const start = Math.max(0, index - windowSize + 1);
  const slice = values.slice(start, index + 1).map(toNumber).filter((value) => value > 0);
  if (!slice.length) return undefined;
  const sum = slice.reduce((total, value) => total + value, 0);
  return Number((sum / slice.length).toFixed(3));
}

function parseMarketNumber(value: string | undefined) {
  return toNumber(value?.replace(/[$,]/g, ''));
}

function parseUsDate(value: string | undefined) {
  if (!value) return '';
  const [month, day, year] = value.split('/');
  if (!month || !day || !year) return '';
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function weekKey(dateValue: string) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function formatMinuteLabel(time: string, date: string) {
  const formattedTime = `${time.slice(0, 2)}:${time.slice(2)}`;
  if (!date || date === currentDateKey()) return formattedTime;
  return `${date.slice(4, 6)}/${date.slice(6)} ${formattedTime}`;
}

function formatTimestampDate(timestamp?: number) {
  if (!timestamp) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function formatTimestampTime(timestamp?: number, fallback?: string) {
  if (!timestamp) return fallback || '';
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
  return time === '24:00' ? '00:00' : time;
}

function currentDateKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}${month}${day}`;
}

function toNumber(value: string | number | null | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

type TencentMinutePayload = {
  data?: Record<string, { data?: { data?: string[] } }>;
};

type TencentDayPayload = {
  data?: Record<string, { data?: Array<{ date: string; data?: string[] }> }>;
};

type TencentKlinePayload = {
  data?: Record<string, Record<string, string[][]>>;
};

type NasdaqHistoricalPayload = {
  data?: {
    tradesTable?: {
      rows?: NasdaqHistoricalRow[];
    };
  };
};

type NasdaqHistoricalRow = {
  date?: string;
  close?: string;
  volume?: string;
  open?: string;
  high?: string;
  low?: string;
};

type NasdaqChartPayload = {
  data?: {
    symbol?: string;
    chart?: Array<{
      x?: number;
      y?: number;
      z?: {
        dateTime?: string;
        value?: string;
      };
    }>;
  };
};
