import { useMemo, useState } from 'react';
import { Check, FileSearch, RotateCcw, Trash2, UploadCloud } from 'lucide-react';
import { PanelTitle } from '../components/PanelTitle';
import type { AppContext } from '../appContext';
import type { AccountSnapshot, Holding, SnapshotDraft } from '../types';
import { recognizeSnapshot } from '../utils/ocrSnapshot';
import { holdingKey } from '../utils/sellTransactions';

const brokers = ['盈立证券', '致富证券', '星财富', 'Schwab', 'US Bancorp Advisors'] as const;
const markets = ['US', 'HK'] as const;
const holdingTypes = ['个股', 'ETF', '杠杆ETF'] as const;
const currencies = ['USD', 'HKD'] as const;

export function ImportPage({ context }: { context: AppContext }) {
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState<SnapshotDraft | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');

  const validation = useMemo(() => validateDraft(draft), [draft]);

  async function runOcr() {
    const controller = new AbortController();
    setStatus('loading');
    setError('');
    try {
      const recognized = await recognizeSnapshot(files, controller.signal, context.aiConfig);
      const result = addSellQuantityWarnings(recognized, context);
      setDraft(result);
      setStatus('ready');
    } catch (reason) {
      setStatus('error');
      setError(reason instanceof Error ? reason.message : 'OCR 识别失败');
    }
  }

  async function saveDraft() {
    if (!draft || validation.length) return;
    setStatus('loading');
    setError('');
    try {
      await context.saveDraftSnapshot(draft, files.map((file) => file.name));
      setStatus('idle');
      setDraft(null);
      setFiles([]);
    } catch (reason) {
      setStatus('error');
      setError(reason instanceof Error ? reason.message : '快照保存失败');
    }
  }

  return (
    <div className="page-stack">
      <section className="panel import-panel">
        <PanelTitle icon={UploadCloud} title="持仓快照 OCR" action={context.savedSnapshot ? '增量更新' : '多图合并'} />
        <div className="upload-box ocr-upload-box">
          <FileSearch size={30} />
          <b>{status === 'loading' ? '正在识别截图' : '上传券商截图'}</b>
          <p>支持盈立证券、致富证券、星财富、Schwab、US Bancorp Advisors 截图。一次最多 6 张，单张不超过 6MB；确认后只更新本次截图识别到的账户和持仓。</p>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 6))}
          />
          <div className="ocr-file-list">
            {files.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
          </div>
          <button onClick={() => void runOcr()} disabled={!files.length || status === 'loading'}>
            {status === 'loading' ? '识别中' : '开始 OCR 识别'}
          </button>
          {context.savedSnapshot && (
            <button className="secondary-action" onClick={context.resetSnapshot}>
              <RotateCcw size={16} />
              恢复默认快照
            </button>
          )}
          {error && <p className="warn-text">{error}</p>}
        </div>
      </section>

      {draft && (
        <section className="panel ocr-panel">
          <PanelTitle icon={FileSearch} title="识别草稿复核" action={draft.model || 'AI OCR'} />
          <div className="ocr-account">
            <div>
              <b>{draft.summary}</b>
              <span>{draft.holdings.length} 只持仓 · {draft.accountSnapshots.length} 个账户净值 · 未出现在本次截图里的数据会保留</span>
            </div>
            <span className={validation.length ? 'confidence' : 'confidence ok'}>{validation.length ? '需修正' : '可保存'}</span>
          </div>
          {draft.warnings.length > 0 && <p className="warn-text">{draft.warnings.join('；')}</p>}

          <DraftHoldings draft={draft} setDraft={setDraft} />
          <DraftAccounts draft={draft} setDraft={setDraft} />

          {validation.length > 0 && (
            <div className="change-summary">
              <b>保存前需修正</b>
              {validation.map((item) => <p key={item}>{item}</p>)}
            </div>
          )}

          <button className="primary-action" disabled={validation.length > 0 || status === 'loading'} onClick={() => void saveDraft()}>
            <Check size={18} />
            {status === 'loading' ? '正在保存' : '确认增量更新'}
          </button>
        </section>
      )}
    </div>
  );
}

function DraftHoldings({ draft, setDraft }: DraftProps) {
  return (
    <div className="draft-table">
      <div className="draft-section-title">持仓明细</div>
      {draft.holdings.map((row, index) => (
        <article className="draft-row" key={`${row.symbol}-${index}`}>
          <div className="draft-row-head">
            <b>{row.name || row.symbol || `持仓 ${index + 1}`}</b>
            <button onClick={() => setDraft(removeHolding(draft, index))} aria-label="删除持仓"><Trash2 size={16} /></button>
          </div>
          <div className="draft-fields">
            <SelectField label="券商" value={row.broker} options={brokers} onChange={(value) => setDraft(updateHolding(draft, index, { broker: value as Holding['broker'] }))} />
            <TextField label="账户" value={row.account} onChange={(value) => setDraft(updateHolding(draft, index, { account: value }))} />
            <SelectField label="市场" value={row.market} options={markets} onChange={(value) => setDraft(updateHolding(draft, index, { market: value as Holding['market'] }))} />
            <SelectField label="类型" value={row.type} options={holdingTypes} onChange={(value) => setDraft(updateHolding(draft, index, { type: value as Holding['type'] }))} />
            <TextField label="名称" value={row.name} onChange={(value) => setDraft(updateHolding(draft, index, { name: value }))} />
            <TextField label="代码" value={row.symbol} onChange={(value) => setDraft(updateHolding(draft, index, { symbol: value.toUpperCase() }))} />
            <SelectField label="币种" value={row.currency} options={currencies} onChange={(value) => setDraft(updateHolding(draft, index, { currency: value as Holding['currency'] }))} />
            <NumberField label="数量" value={row.qty} onChange={(value) => setDraft(updateHolding(draft, index, { qty: value }))} />
            <NumberField label="现价" value={row.price} onChange={(value) => setDraft(updateHolding(draft, index, { price: value }))} />
            <NumberField label="成本" value={row.cost} onChange={(value) => setDraft(updateHolding(draft, index, { cost: value }))} />
          </div>
          {row.warnings?.length ? <p className="warn-text">{row.warnings.join('；')}</p> : null}
        </article>
      ))}
    </div>
  );
}

function DraftAccounts({ draft, setDraft }: DraftProps) {
  return (
    <div className="draft-table">
      <div className="draft-section-title">账户净值</div>
      {draft.accountSnapshots.map((row, index) => (
        <article className="draft-row" key={`${row.account}-${index}`}>
          <div className="draft-row-head">
            <b>{row.account || `账户 ${index + 1}`}</b>
            <button onClick={() => setDraft(removeAccount(draft, index))} aria-label="删除账户"><Trash2 size={16} /></button>
          </div>
          <div className="draft-fields">
            <SelectField label="券商" value={row.broker} options={brokers} onChange={(value) => setDraft(updateAccount(draft, index, { broker: value }))} />
            <TextField label="账户" value={row.account} onChange={(value) => setDraft(updateAccount(draft, index, { account: value }))} />
            <SelectField label="市场" value={row.market} options={markets} onChange={(value) => setDraft(updateAccount(draft, index, { market: value as AccountSnapshot['market'] }))} />
            <SelectField label="币种" value={row.currency} options={currencies} onChange={(value) => setDraft(updateAccount(draft, index, { currency: value as AccountSnapshot['currency'] }))} />
            <NumberField label="账户净值" value={row.netAsset} onChange={(value) => setDraft(updateAccount(draft, index, { netAsset: value }))} />
          </div>
          {row.warnings?.length ? <p className="warn-text">{row.warnings.join('；')}</p> : null}
        </article>
      ))}
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label>{label}<input value={value || ''} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" step="0.0001" value={Number.isFinite(value) ? value : 0} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function updateHolding(draft: SnapshotDraft, index: number, patch: Partial<SnapshotDraft['holdings'][number]>): SnapshotDraft {
  return { ...draft, holdings: draft.holdings.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) };
}

function updateAccount(draft: SnapshotDraft, index: number, patch: Partial<SnapshotDraft['accountSnapshots'][number]>): SnapshotDraft {
  return { ...draft, accountSnapshots: draft.accountSnapshots.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row) };
}

function removeHolding(draft: SnapshotDraft, index: number): SnapshotDraft {
  return { ...draft, holdings: draft.holdings.filter((_, rowIndex) => rowIndex !== index) };
}

function removeAccount(draft: SnapshotDraft, index: number): SnapshotDraft {
  return { ...draft, accountSnapshots: draft.accountSnapshots.filter((_, rowIndex) => rowIndex !== index) };
}

function validateDraft(draft: SnapshotDraft | null) {
  if (!draft) return ['没有识别草稿'];
  const errors: string[] = [];
  if (!draft.holdings.length && !draft.accountSnapshots.length) errors.push('至少需要 1 条持仓或账户净值');
  draft.holdings.forEach((row, index) => {
    if (!row.symbol) errors.push(`第 ${index + 1} 条持仓缺少代码`);
    if (!row.name) errors.push(`第 ${index + 1} 条持仓缺少名称`);
    if (!row.qty || row.qty <= 0) errors.push(`${row.symbol || `第 ${index + 1} 条持仓`} 数量必须大于 0`);
    if (!row.price || row.price <= 0) errors.push(`${row.symbol || `第 ${index + 1} 条持仓`} 现价必须大于 0`);
    if (!row.cost || row.cost <= 0) errors.push(`${row.symbol || `第 ${index + 1} 条持仓`} 成本必须大于 0`);
  });
  return errors.slice(0, 8);
}

type DraftProps = {
  draft: SnapshotDraft;
  setDraft: (draft: SnapshotDraft) => void;
};

function addSellQuantityWarnings(draft: SnapshotDraft, context: AppContext): SnapshotDraft {
  const activeSaleKeys = new Set(context.sellRecords.filter((record) => record.status === 'active').map(holdingKey));
  const currentQty = new Map(context.holdings.map((holding) => [holdingKey(holding), holding.qty]));
  let conflictCount = 0;
  const holdings = draft.holdings.map((row) => {
    const key = holdingKey(row);
    const previousQty = currentQty.get(key) ?? 0;
    if (!activeSaleKeys.has(key) || row.qty <= previousQty + 0.0000001) return row;
    conflictCount += 1;
    return {
      ...row,
      warnings: [
        ...(row.warnings ?? []),
        `识别数量 ${row.qty} 高于卖出后的当前数量 ${previousQty}；请确认这是最新截图，而不是卖出前的旧截图`,
      ],
    };
  });
  if (!conflictCount) return draft;
  return {
    ...draft,
    holdings,
    warnings: [...draft.warnings, `${conflictCount} 条持仓数量与现有卖出记录存在差异，确认保存后将以本次券商截图为准`],
  };
}
