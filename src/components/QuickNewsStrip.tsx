import type { HoldingNewsItem } from '../types';

export function QuickNewsStrip({ items }: { items: HoldingNewsItem[] }) {
  return (
    <section className="quick-news-strip" aria-label="持仓相关新闻速览">
      {items.slice(0, 3).map((item) => (
        <a href={item.url} target="_blank" rel="noreferrer" key={item.id}>
          <span>{item.symbol}</span>
          <b>{item.title}</b>
        </a>
      ))}
      {!items.length && (
        <div>
          <span>NEWS</span>
          <b>正在抓取 Investing 持仓相关新闻</b>
        </div>
      )}
    </section>
  );
}
