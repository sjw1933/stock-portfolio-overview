import type { RiskAlert } from '../types';

export function QuickRiskStrip({ risks }: { risks: RiskAlert[] }) {
  return (
    <section className="quick-risk-strip">
      {risks.slice(0, 3).map((risk) => (
        <div key={risk.title}>
          <span>{risk.level}</span>
          <b>{risk.title}</b>
        </div>
      ))}
    </section>
  );
}
