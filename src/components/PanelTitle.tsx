import type { ElementType } from 'react';

export function PanelTitle({ icon: Icon, title, action }: { icon: ElementType; title: string; action: string }) {
  return (
    <div className="panel-title">
      <div>
        <Icon size={19} />
        <h2>{title}</h2>
      </div>
      <span>{action}</span>
    </div>
  );
}
