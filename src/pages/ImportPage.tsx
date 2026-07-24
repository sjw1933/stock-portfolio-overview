import { useMemo, useState } from 'react';
import type React from 'react';
import { AlertTriangle, Check, FileSearch, History, Plus, RotateCcw, Search, Trash2, UploadCloud } from 'lucide-react';
import { PanelTitle } from '../components/PanelTitle';
import type { AppContext } from '../appContext';
import type { AccountSnapshot, Broker, Holding, SnapshotDraft } from '../types';
import { recognizeSnapshot } from '../utils/ocrSnapshot';
import { fetchSecurityQuote, normalizeSecuritySymbol } from '../utils/quotes';
import { holdingKey } from '../utils/sellTransactions';

const brokers = ['盈立证券', '致富证券', '星财富', 'Schwab', 'US Bancorp Advisors'] as const;
const markets = ['US', 'HK'] as const;
const holdingTypes = ['个股', 'ETF', '杠杆ETF'] as const;
const currencies = ['USD', 'HKD'] as const;

type ManualHolding = {
  id: string;
  type: Holding['type'];
  name: string;
  symbol: string;
  qty: string;
  price: string;
  cost: string;
  lookup: 'idle' | 'loading' | 'ready' | 'error';
  warning: string;
};

type ManualAccount = {
  id: string;
  broker: Broker;
  account: string;
  market: Holding['market'];
  currency: Holding['currency'];
  netAsset: string;
  holdings: ManualHolding[];
};

export function ImportPage({ context }: { context: AppContext }) {
  const [mode, setMode] = useState<'ocr' | 'manual'>('ocr');
  const [files, setFiles] = useState<File[]>([]);
  const [draft, setDraft] = useState<SnapshotDraft | null>(null);
  const [manualAccounts, setManualAccounts] = useState<ManualAccount[]>([createManualAccount(context)]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetAcknowledged, setResetAcknowledged] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState('');

  const validation = useMemo(() => validateDraft(draft), [draft]);
  const manualValidation = useMemo(() => validateManualAccounts(manualAccounts), [manualAccounts]);

  function openResetDialog() {
    setResetAcknowledged(false);
    setResetError('');
    setResetDialogOpen(true);
  }

  async function confirmResetSnapshot() {
    if (!resetAcknowledged || resetPending) return;
    setResetPending(true);
    setResetError('');
    try {
      await context.resetSnapshot();
      setDraft(null);
      setFiles([]);
      setStatus('idle');
      setError('');
      setResetDialogOpen(false);
    } catch (reason) {
      setResetError(reason instanceof Error ? reason.message : '恢复默认快照失败，当前数据未修改');
    } finally {
      setResetPending(false);
    }
  }

  async function runOcr() {
    const controller = new AbortController();
    setStatus('loading');
    setError('');
    try {
      const recognized = await recognizeSnapshot(files, controller.signal, context.aiConfig);
      setDraft(addTransactionQuantityWarnings(recognized, context));
      setStatus('ready');
    } catch (reason) {
      setStatus('error');
      setError(reason instanceof Error ? reason.message : 'OCR 识别失败');
    }
  }

  function prepareManualReview() {
    if (manualValidation.length) return;
    const warnings: string[] = [];
    const draftHoldings = manualAccounts.flatMap((group) => group.holdings.map((row) => {
      const cost = Number(row.cost);
      const enteredPrice = Number(row.price);
      const price = enteredPrice > 0 ? enteredPrice : cost;
      const rowWarnings = row.warning ? [row.warning] : [];
      if (!(enteredPrice > 0)) rowWarnings.push('未填写当前价，保存后暂用成本价展示并等待行情刷新');
      return {
        broker: group.broker,
        account: group.account.trim(),
        market: group.market,
        type: row.type,
        name: row.name.trim(),
        symbol: normalizeSecuritySymbol(row.symbol, group.market),
        currency: group.currency,
        qty: Number(row.qty),
        price,
        cost,
        warnings: rowWarnings,
      };
    }));
    const accountSnapshots = manualAccounts.flatMap((group) => Number(group.netAsset) > 0 ? [{
      broker: group.broker,
      account: group.account.trim(),
      market: group.market,
      currency: group.currency,
      netAsset: Number(group.netAsset),
    }] : []);
    const accountsWithoutNetAsset = manualAccounts.filter((group) => (
      !(Number(group.netAsset) > 0)
      && !context.accountSnapshots.some((item) => accountKey(item) === accountKey(group))
    ));
    if (accountsWithoutNetAsset.length) warnings.push(`${accountsWithoutNetAsset.length} 个新账户未填写净值，暂不估算其剩余资产`);
    const manualDraft: SnapshotDraft = {
      source: 'manual',
      summary: `手动录入 ${draftHoldings.length} 条当前持仓`,
      holdings: draftHoldings,
      accountSnapshots,
      warnings,
    };
    setDraft(addTransactionQuantityWarnings(manualDraft, context));
    setStatus('ready');
    setError('');
  }

  async function saveDraft() {
    if (!draft || validation.length) return;
    setStatus('loading');
    setError('');
    try {
      await context.saveDraftSnapshot(draft, draft.source === 'ai-ocr' ? files.map((file) => file.name) : []);
      setStatus('idle');
      setDraft(null);
      setFiles([]);
      if (draft.source === 'manual') setManualAccounts([createManualAccount(context)]);
    } catch (reason) {
      setStatus('error');
      setError(reason instanceof Error ? reason.message : '快照保存失败');
    }
  }

  async function lookupManualHolding(accountId: string, holdingId: string) {
    const group = manualAccounts.find((item) => item.id === accountId);
    const row = group?.holdings.find((item) => item.id === holdingId);
    if (!group || !row?.symbol.trim()) return;
    patchManualHolding(setManualAccounts, accountId, holdingId, { lookup: 'loading', warning: '' });
    try {
      const quote = await fetchSecurityQuote(row.symbol, group.market);
      patchManualHolding(setManualAccounts, accountId, holdingId, {
        symbol: normalizeSecuritySymbol(row.symbol, group.market),
        name: row.name || quote.name || '',
        price: String(quote.price),
        lookup: 'ready',
        warning: '',
      });
    } catch (reason) {
      patchManualHolding(setManualAccounts, accountId, holdingId, {
        lookup: 'error',
        warning: reason instanceof Error ? reason.message : '行情查询失败，可继续手动填写',
      });
    }
  }

  return (
    <div className="page-stack">
      <div className="holding-view-tabs import-mode-tabs" aria-label="持仓导入方式">
        <button type="button" className={mode === 'ocr' ? 'active' : ''} onClick={() => { setMode('ocr'); setDraft(null); setError(''); }}>截图 OCR</button>
        <button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => { setMode('manual'); setDraft(null); setError(''); }}>手动录入持仓</button>
      </div>

      {mode === 'ocr' ? (
        <section className="panel import-panel">
          <PanelTitle icon={UploadCloud} title="持仓快照 OCR" action={context.savedSnapshot ? '增量更新' : '多图合并'} />
          <div className="upload-box ocr-upload-box">
            <FileSearch size={30} />
            <b>{status === 'loading' ? '正在识别截图' : '上传券商截图'}</b>
            <p>支持盈立证券、致富证券、星财富、Schwab、US Bancorp Advisors。确认后只更新本次明确识别到的账户和持仓。</p>
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 6))} />
            <div className="ocr-file-list">{files.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}</div>
            <button onClick={() => void runOcr()} disabled={!files.length || status === 'loading'}>{status === 'loading' ? '识别中' : '开始 OCR 识别'}</button>
            {context.savedSnapshot && <button type="button" className="secondary-action" onClick={openResetDialog}><RotateCcw size={16} />恢复默认快照</button>}
            {error && <p className="warn-text">{error}</p>}
          </div>
        </section>
      ) : (
        <section className="panel manual-import-panel">
          <PanelTitle icon={FileSearch} title="手动录入当前持仓" action="当前总量覆盖" />
          <p className="manual-import-note">这里填写的是账户当前总持仓，不是买入增量。未填写的账户和股票不会被清空。</p>
          <div className="manual-account-list">
            {manualAccounts.map((group, groupIndex) => (
              <article className="manual-account-group" key={group.id}>
                <div className="manual-account-head">
                  <div><b>账户 {groupIndex + 1}</b><span>{group.broker} · {group.account || '未命名账户'}</span></div>
                  {manualAccounts.length > 1 && <button type="button" className="icon-button danger-icon" onClick={() => setManualAccounts((rows) => rows.filter((item) => item.id !== group.id))} aria-label="删除账户"><Trash2 size={17} /></button>}
                </div>
                <div className="draft-fields manual-account-fields">
                  <SelectField label="券商" value={group.broker} options={brokers} onChange={(value) => patchManualAccount(setManualAccounts, group.id, { broker: value as Broker })} />
                  <TextField label="账户名称" value={group.account} onChange={(value) => patchManualAccount(setManualAccounts, group.id, { account: value })} />
                  <SelectField label="市场" value={group.market} options={markets} onChange={(value) => patchManualAccount(setManualAccounts, group.id, { market: value as Holding['market'], currency: value === 'HK' ? 'HKD' : 'USD' })} />
                  <SelectField label="结算币种" value={group.currency} options={currencies} onChange={(value) => patchManualAccount(setManualAccounts, group.id, { currency: value as Holding['currency'] })} />
                  <OptionalNumberField label="账户净值（选填）" value={group.netAsset} step="0.01" onChange={(value) => patchManualAccount(setManualAccounts, group.id, { netAsset: value })} />
                </div>
                <div className="manual-holding-list">
                  {group.holdings.map((row, rowIndex) => (
                    <div className="manual-holding-row" key={row.id}>
                      <div className="draft-row-head">
                        <b>持仓 {rowIndex + 1}{row.symbol ? ` · ${normalizeSecuritySymbol(row.symbol, group.market)}` : ''}</b>
                        {group.holdings.length > 1 && <button type="button" onClick={() => patchManualAccount(setManualAccounts, group.id, { holdings: group.holdings.filter((item) => item.id !== row.id) })} aria-label="删除持仓"><Trash2 size={16} /></button>}
                      </div>
                      <div className="draft-fields">
                        <label>股票代码<div className="input-with-action"><input value={row.symbol} onChange={(event) => patchManualHolding(setManualAccounts, group.id, row.id, { symbol: event.target.value.toUpperCase(), lookup: 'idle' })} /><button type="button" title="查询行情" onClick={() => void lookupManualHolding(group.id, row.id)} disabled={row.lookup === 'loading'}><Search size={15} /></button></div></label>
                        <TextField label="名称" value={row.name} onChange={(value) => patchManualHolding(setManualAccounts, group.id, row.id, { name: value })} />
                        <SelectField label="类型" value={row.type} options={holdingTypes} onChange={(value) => patchManualHolding(setManualAccounts, group.id, row.id, { type: value as Holding['type'] })} />
                        <OptionalNumberField label="当前总数量" value={row.qty} step="0.000001" onChange={(value) => patchManualHolding(setManualAccounts, group.id, row.id, { qty: value })} />
                        <OptionalNumberField label="券商成本价" value={row.cost} step="0.0001" onChange={(value) => patchManualHolding(setManualAccounts, group.id, row.id, { cost: value })} />
                        <OptionalNumberField label="当前价（选填）" value={row.price} step="0.0001" onChange={(value) => patchManualHolding(setManualAccounts, group.id, row.id, { price: value })} />
                      </div>
                      {row.lookup === 'ready' && <p className="lookup-ok">行情已匹配</p>}
                      {row.warning && <p className="warn-text">{row.warning}</p>}
                    </div>
                  ))}
                  <button type="button" className="secondary-action add-row-button" onClick={() => patchManualAccount(setManualAccounts, group.id, { holdings: [...group.holdings, createManualHolding()] })}><Plus size={16} />添加持仓</button>
                </div>
              </article>
            ))}
          </div>
          <button type="button" className="secondary-action manual-add-account" onClick={() => setManualAccounts((rows) => [...rows, createManualAccount(context)])}><Plus size={16} />添加账户</button>
          {manualValidation.length > 0 && <div className="change-summary"><b>请先补充</b>{manualValidation.slice(0, 6).map((item) => <p key={item}>{item}</p>)}</div>}
          <button type="button" className="primary-action" disabled={manualValidation.length > 0} onClick={prepareManualReview}><Check size={18} />预览本次更新</button>
        </section>
      )}

      {draft && (
        <section className="panel ocr-panel">
          <PanelTitle icon={FileSearch} title={draft.source === 'manual' ? '手动持仓变更确认' : '识别草稿复核'} action={draft.source === 'manual' ? '人工录入' : draft.model || 'AI OCR'} />
          <div className="ocr-account">
            <div><b>{draft.summary}</b><span>{draft.holdings.length} 只持仓 · {draft.accountSnapshots.length} 个账户净值 · 未出现在本次更新里的数据会保留</span></div>
            <span className={validation.length ? 'confidence' : 'confidence ok'}>{validation.length ? '需修正' : '可保存'}</span>
          </div>
          {draft.warnings.length > 0 && <p className="warn-text">{draft.warnings.join('；')}</p>}
          {draft.source === 'manual' && <ChangePreview draft={draft} context={context} />}
          <DraftHoldings draft={draft} setDraft={setDraft} />
          <DraftAccounts draft={draft} setDraft={setDraft} />
          {validation.length > 0 && <div className="change-summary"><b>保存前需修正</b>{validation.map((item) => <p key={item}>{item}</p>)}</div>}
          {error && <p className="warn-text">{error}</p>}
          <button className="primary-action" disabled={validation.length > 0 || status === 'loading'} onClick={() => void saveDraft()}><Check size={18} />{status === 'loading' ? '正在保存' : '确认增量更新'}</button>
        </section>
      )}

      <ImportAuditPanel context={context} />

      {resetDialogOpen && (
        <ResetSnapshotDialog
          acknowledged={resetAcknowledged}
          pending={resetPending}
          error={resetError}
          holdingCount={context.holdings.length}
          buyCount={context.buyRecords.filter((record) => record.status === 'active').length}
          sellCount={context.sellRecords.filter((record) => record.status === 'active').length}
          importLogCount={context.importLogs.length}
          onAcknowledgedChange={setResetAcknowledged}
          onCancel={() => !resetPending && setResetDialogOpen(false)}
          onConfirm={() => void confirmResetSnapshot()}
        />
      )}
    </div>
  );
}

function ResetSnapshotDialog({
  acknowledged,
  pending,
  error,
  holdingCount,
  buyCount,
  sellCount,
  importLogCount,
  onAcknowledgedChange,
  onCancel,
  onConfirm,
}: {
  acknowledged: boolean;
  pending: boolean;
  error: string;
  holdingCount: number;
  buyCount: number;
  sellCount: number;
  importLogCount: number;
  onAcknowledgedChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop reset-confirm-backdrop" role="presentation">
      <section className="reset-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title" aria-describedby="reset-confirm-description">
        <div className="reset-confirm-head">
          <span className="reset-confirm-icon"><AlertTriangle size={22} /></span>
          <div>
            <p className="eyebrow">高风险操作</p>
            <h2 id="reset-confirm-title">恢复默认快照？</h2>
          </div>
        </div>
        <p id="reset-confirm-description" className="reset-confirm-copy">这会删除服务器共享快照，并把看板恢复为源码内的演示数据。操作完成后无法在页面内撤销。</p>
        <ul className="reset-impact-list" aria-label="将被清除的数据">
          <li><span>当前持仓</span><b>{holdingCount} 只</b></li>
          <li><span>有效买入记录</span><b>{buyCount} 条</b></li>
          <li><span>有效卖出记录</span><b>{sellCount} 条</b></li>
          <li><span>导入审计记录</span><b>{importLogCount} 条</b></li>
        </ul>
        <label className="reset-confirm-check">
          <input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => onAcknowledgedChange(event.target.checked)} />
          <span>我已了解上述数据将被清除，并已确认不再需要当前快照。</span>
        </label>
        {error && <p className="reset-confirm-error" role="alert">{error}</p>}
        <div className="reset-confirm-actions">
          <button type="button" className="secondary-action" autoFocus disabled={pending} onClick={onCancel}>取消</button>
          <button type="button" className="reset-confirm-danger" disabled={!acknowledged || pending} onClick={onConfirm}><RotateCcw size={16} />{pending ? '正在恢复' : '确认恢复默认快照'}</button>
        </div>
      </section>
    </div>
  );
}

function ChangePreview({ draft, context }: { draft: SnapshotDraft; context: AppContext }) {
  return (
    <div className="manual-change-preview">
      <b>变更预览</b>
      {draft.holdings.map((row) => {
        const previous = context.holdings.find((item) => holdingKey(item) === holdingKey(row));
        return <p key={holdingKey(row)}><span>{row.symbol} · {row.broker} · {row.account}</span><strong>{previous ? `${formatQty(previous.qty)} → ${formatQty(row.qty)}` : `新增 ${formatQty(row.qty)}`}</strong></p>;
      })}
    </div>
  );
}

function ImportAuditPanel({ context }: { context: AppContext }) {
  return (
    <section className="panel import-audit-panel">
      <PanelTitle icon={History} title="导入审计" action={`${context.importLogs.length} 条`} />
      {!context.importLogs.length && <div className="sell-record-empty"><b>暂无导入记录</b><span>OCR 和手动持仓更新会记录在这里。</span></div>}
      <div className="import-audit-list">
        {context.importLogs.slice(0, 8).map((log) => (
          <article key={log.id}><div><b>{log.source === 'manual' ? '手动录入' : '截图 OCR'}</b><span>{new Date(log.savedAt).toLocaleString('zh-CN', { hour12: false })}</span></div><p>{log.holdingCount} 条持仓 · {log.accountCount} 个账户净值 · {log.accounts.join('、') || '未记录账户'}</p>{log.warningCount > 0 && <em>{log.warningCount} 条提示</em>}</article>
        ))}
      </div>
    </section>
  );
}

function DraftHoldings({ draft, setDraft }: DraftProps) {
  return (
    <div className="draft-table"><div className="draft-section-title">持仓明细</div>{draft.holdings.map((row, index) => (
      <article className="draft-row" key={`${row.symbol}-${index}`}><div className="draft-row-head"><b>{row.name || row.symbol || `持仓 ${index + 1}`}</b><button onClick={() => setDraft(removeHolding(draft, index))} aria-label="删除持仓"><Trash2 size={16} /></button></div><div className="draft-fields">
        <SelectField label="券商" value={row.broker} options={brokers} onChange={(value) => setDraft(updateHolding(draft, index, { broker: value as Holding['broker'] }))} />
        <TextField label="账户" value={row.account} onChange={(value) => setDraft(updateHolding(draft, index, { account: value }))} />
        <SelectField label="市场" value={row.market} options={markets} onChange={(value) => setDraft(updateHolding(draft, index, { market: value as Holding['market'] }))} />
        <SelectField label="类型" value={row.type} options={holdingTypes} onChange={(value) => setDraft(updateHolding(draft, index, { type: value as Holding['type'] }))} />
        <TextField label="名称" value={row.name} onChange={(value) => setDraft(updateHolding(draft, index, { name: value }))} />
        <TextField label="代码" value={row.symbol} onChange={(value) => setDraft(updateHolding(draft, index, { symbol: value.toUpperCase() }))} />
        <SelectField label="币种" value={row.currency} options={currencies} onChange={(value) => setDraft(updateHolding(draft, index, { currency: value as Holding['currency'] }))} />
        <NumberField label="数量" value={row.qty} step="0.000001" onChange={(value) => setDraft(updateHolding(draft, index, { qty: value }))} />
        <NumberField label="现价" value={row.price} step="0.0001" onChange={(value) => setDraft(updateHolding(draft, index, { price: value }))} />
        <NumberField label="成本" value={row.cost} step="0.0001" onChange={(value) => setDraft(updateHolding(draft, index, { cost: value }))} />
      </div>{row.warnings?.length ? <p className="warn-text">{row.warnings.join('；')}</p> : null}</article>
    ))}</div>
  );
}

function DraftAccounts({ draft, setDraft }: DraftProps) {
  if (!draft.accountSnapshots.length) return null;
  return (
    <div className="draft-table"><div className="draft-section-title">账户净值</div>{draft.accountSnapshots.map((row, index) => (
      <article className="draft-row" key={`${row.account}-${index}`}><div className="draft-row-head"><b>{row.account || `账户 ${index + 1}`}</b><button onClick={() => setDraft(removeAccount(draft, index))} aria-label="删除账户"><Trash2 size={16} /></button></div><div className="draft-fields">
        <SelectField label="券商" value={row.broker} options={brokers} onChange={(value) => setDraft(updateAccount(draft, index, { broker: value }))} />
        <TextField label="账户" value={row.account} onChange={(value) => setDraft(updateAccount(draft, index, { account: value }))} />
        <SelectField label="市场" value={row.market} options={markets} onChange={(value) => setDraft(updateAccount(draft, index, { market: value as AccountSnapshot['market'] }))} />
        <SelectField label="币种" value={row.currency} options={currencies} onChange={(value) => setDraft(updateAccount(draft, index, { currency: value as AccountSnapshot['currency'] }))} />
        <NumberField label="账户净值" value={row.netAsset} step="0.01" onChange={(value) => setDraft(updateAccount(draft, index, { netAsset: value }))} />
      </div></article>
    ))}</div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label>{label}<input value={value || ''} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, step, onChange }: { label: string; value: number; step: string; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" step={step} value={Number.isFinite(value) ? value : 0} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function OptionalNumberField({ label, value, step, onChange }: { label: string; value: string; step: string; onChange: (value: string) => void }) {
  return <label>{label}<input type="number" min="0" step={step} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function createManualAccount(context: AppContext): ManualAccount {
  const current = context.accountSnapshots[0] ?? context.holdings[0];
  return {
    id: createId('account'),
    broker: (current?.broker as Broker) ?? '盈立证券',
    account: current?.account ?? '',
    market: current?.market ?? 'US',
    currency: current?.currency ?? 'USD',
    netAsset: '',
    holdings: [createManualHolding()],
  };
}

function createManualHolding(): ManualHolding {
  return { id: createId('holding'), type: '个股', name: '', symbol: '', qty: '', price: '', cost: '', lookup: 'idle', warning: '' };
}

function createId(prefix: string) {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function patchManualAccount(setter: React.Dispatch<React.SetStateAction<ManualAccount[]>>, id: string, patch: Partial<ManualAccount>) {
  setter((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
}

function patchManualHolding(setter: React.Dispatch<React.SetStateAction<ManualAccount[]>>, accountId: string, holdingId: string, patch: Partial<ManualHolding>) {
  setter((rows) => rows.map((group) => group.id === accountId ? { ...group, holdings: group.holdings.map((row) => row.id === holdingId ? { ...row, ...patch } : row) } : group));
}

function validateManualAccounts(groups: ManualAccount[]) {
  const errors: string[] = [];
  groups.forEach((group, groupIndex) => {
    if (!group.account.trim()) errors.push(`账户 ${groupIndex + 1} 缺少账户名称`);
    if (!group.holdings.length) errors.push(`账户 ${groupIndex + 1} 至少需要一条持仓`);
    group.holdings.forEach((row, rowIndex) => {
      const label = `账户 ${groupIndex + 1} 持仓 ${rowIndex + 1}`;
      if (!row.symbol.trim()) errors.push(`${label} 缺少股票代码`);
      if (!row.name.trim()) errors.push(`${label} 缺少名称`);
      if (!(Number(row.qty) > 0)) errors.push(`${label} 数量必须大于 0`);
      if (!(Number(row.cost) > 0)) errors.push(`${label} 券商成本价必须大于 0`);
    });
  });
  return errors;
}

function validateDraft(draft: SnapshotDraft | null) {
  if (!draft) return ['没有识别草稿'];
  const errors: string[] = [];
  if (!draft.holdings.length && !draft.accountSnapshots.length) errors.push('至少需要 1 条持仓或账户净值');
  draft.holdings.forEach((row, index) => {
    if (!row.account) errors.push(`第 ${index + 1} 条持仓缺少账户`);
    if (!row.symbol) errors.push(`第 ${index + 1} 条持仓缺少代码`);
    if (!row.name) errors.push(`第 ${index + 1} 条持仓缺少名称`);
    if (!row.qty || row.qty <= 0) errors.push(`${row.symbol || `第 ${index + 1} 条持仓`} 数量必须大于 0`);
    if (!row.price || row.price <= 0) errors.push(`${row.symbol || `第 ${index + 1} 条持仓`} 现价必须大于 0`);
    if (!row.cost || row.cost <= 0) errors.push(`${row.symbol || `第 ${index + 1} 条持仓`} 成本必须大于 0`);
  });
  return errors.slice(0, 8);
}

type DraftProps = { draft: SnapshotDraft; setDraft: (draft: SnapshotDraft) => void };

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

function addTransactionQuantityWarnings(draft: SnapshotDraft, context: AppContext): SnapshotDraft {
  const activeTradeKeys = new Set([
    ...context.sellRecords.filter((record) => record.status === 'active').map(holdingKey),
    ...context.buyRecords.filter((record) => record.status === 'active').map(holdingKey),
  ]);
  const currentQty = new Map(context.holdings.map((holding) => [holdingKey(holding), holding.qty]));
  let conflictCount = 0;
  const holdings = draft.holdings.map((row) => {
    const previousQty = currentQty.get(holdingKey(row));
    if (previousQty === undefined || !activeTradeKeys.has(holdingKey(row)) || Math.abs(row.qty - previousQty) <= 0.0000001) return row;
    conflictCount += 1;
    return { ...row, warnings: [...(row.warnings ?? []), `当前记录数量为 ${formatQty(previousQty)}，本次将覆盖为 ${formatQty(row.qty)}；历史买卖流水会继续保留`] };
  });
  if (!conflictCount) return draft;
  return { ...draft, holdings, warnings: [...draft.warnings, `${conflictCount} 条持仓与交易记录推算数量存在差异，确认后以本次当前持仓为准`] };
}

function formatQty(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}

function accountKey(value: { broker: string; account: string; market: Holding['market'] }) {
  return `${value.broker}::${value.account.trim()}::${value.market}`;
}
