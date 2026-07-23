import { HoldingList } from '../components/HoldingList';
import { HoldingNewsBoard } from '../components/HoldingNewsBoard';
import { StructurePanel } from '../components/StructurePanel';
import { FearGreedPanel } from '../components/FearGreedPanel';
import type { AppContext } from '../appContext';

export function OverviewPage({ context, sidebar = false }: { context: AppContext; sidebar?: boolean }) {
  return (
    <div className={sidebar ? 'sidebar-stack' : 'page-stack'}>
      <HoldingNewsBoard
        items={context.newsItems}
        compact={sidebar}
        summary={context.newsSummary}
        status={context.newsStatus}
        fetchedAt={context.newsFetchedAt}
        holdings={context.aggregated}
        onRefresh={() => void context.refreshNews()}
        aiEnabled={context.newsAiEnabled}
        onAiEnabledChange={context.setNewsAiEnabled}
      />
      <StructurePanel context={context} />
      {sidebar && context.tab === 'holdings' && <FearGreedPanel />}
      {!sidebar && <HoldingList context={context} />}
    </div>
  );
}
