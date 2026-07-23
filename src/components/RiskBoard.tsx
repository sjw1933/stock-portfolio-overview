import { AlertTriangle } from 'lucide-react';
import { PanelTitle } from './PanelTitle';
import type { RiskAlert, RiskAnalysisStatus } from '../types';

const statusLabel: Record<RiskAnalysisStatus, string> = {
  idle: '硬预警',
  loading: 'AI 分析中',
  ai: 'AI 预警',
  fallback: '规则兜底',
  error: '硬预警',
};

export function RiskBoard({
  risks,
  compact = false,
  summary,
  status,
}: {
  risks: RiskAlert[];
  compact?: boolean;
  summary: string;
  status: RiskAnalysisStatus;
}) {
  return (
    <section className={`panel risk-board ${compact ? 'compact' : ''}`}>
      <PanelTitle icon={AlertTriangle} title="持仓风险预警" action={statusLabel[status]} />
      {!compact && <p className={`risk-summary ${status === 'loading' ? 'loading' : ''}`}>{summary}</p>}
      {risks.slice(0, compact ? 3 : risks.length).map((risk) => {
        const Icon = risk.icon;
        return (
          <article className="risk-item" key={risk.title}>
            <div className={`risk-level ${risk.level === '高' ? 'high' : risk.level === '中' ? 'mid' : 'low'}`}>{risk.level}</div>
            <Icon size={20} />
            <div>
              <b>{risk.title}</b>
              <p>{risk.text}</p>
            </div>
          </article>
        );
      })}
    </section>
  );
}
