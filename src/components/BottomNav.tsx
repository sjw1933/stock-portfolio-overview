import { Home, LineChart, MessageCircle, Upload, Wallet } from 'lucide-react';
import type { Tab } from '../types';

const navItems = [
  { key: 'overview' as const, label: '总览', icon: Home },
  { key: 'holdings' as const, label: '持仓', icon: Wallet },
  { key: 'trends' as const, label: '趋势', icon: LineChart },
  { key: 'ask' as const, label: '问询', icon: MessageCircle },
  { key: 'import' as const, label: '导入', icon: Upload },
];

export function BottomNav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>
            <Icon size={21} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
