import { PieChart } from 'lucide-react';
import { Cell, Pie, PieChart as RePieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { AppContext } from '../appContext';
import { PanelTitle } from './PanelTitle';
import { convert, money } from '../utils/currency';

export function StructurePanel({ context }: { context: AppContext }) {
  const currency = context.currency;
  const marketNetAsset = (market: 'US' | 'HK') =>
    context.accountSnapshots
      .filter((snapshot) => snapshot.market === market)
      .reduce((sum, snapshot) => sum + convert(snapshot.netAsset, snapshot.currency, currency), 0);
  const pieData = [
    { name: '美股', value: marketNetAsset('US'), color: '#1769e8' },
    { name: '港股', value: marketNetAsset('HK'), color: '#e4485f' },
  ];

  return (
    <section className="panel structure-panel">
      <PanelTitle icon={PieChart} title="仓位结构" action="结构优先" />
      <div className="structure-body">
        <div className="pie-wrap">
          <ResponsiveContainer width="100%" height={170}>
            <RePieChart>
              <Pie data={pieData} dataKey="value" innerRadius={45} outerRadius={72} paddingAngle={3}>
                {pieData.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => money(Number(value ?? 0), currency, context.masked)} />
            </RePieChart>
          </ResponsiveContainer>
        </div>
        <div className="structure-list">
          {pieData.map((item) => (
            <div key={item.name}>
              <span>
                <i style={{ background: item.color }} />
                {item.name}
              </span>
              <b>{money(item.value, currency, context.masked)}</b>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
