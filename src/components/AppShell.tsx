import type { ReactNode } from 'react';
import { BottomNav } from './BottomNav';
import { TopBar } from './TopBar';
import type { AppContext } from '../appContext';

export function AppShell({ children, context }: { children: ReactNode; context: AppContext }) {
  return (
    <main className="app">
      <TopBar context={context} />
      {children}
      <BottomNav tab={context.tab} setTab={context.setTab} />
    </main>
  );
}
