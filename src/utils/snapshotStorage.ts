import type { AccountSnapshot, BuyRecord, Holding, ImportAuditRecord, SavedSnapshot, SellRecord, SnapshotDraft } from '../types';

export const savedSnapshotKey = 'gup-saved-snapshot-v1';

export function readSavedSnapshot(): SavedSnapshot | null {
  try {
    const raw = JSON.parse(localStorage.getItem(savedSnapshotKey) || 'null') as SavedSnapshot | null;
    if (!raw || !Array.isArray(raw.holdings) || !Array.isArray(raw.accountSnapshots)) return null;
    const snapshot = normalizeClientSnapshot(raw);
    return snapshot;
  } catch {
    return null;
  }
}

export async function fetchSharedSnapshot(signal?: AbortSignal): Promise<SavedSnapshot | null> {
  const response = await fetch('/api/snapshot', { signal, cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(payload.message ?? `snapshot fetch failed: ${response.status}`);
  if (!payload.data) return null;
  return persistSnapshot(normalizeClientSnapshot(payload.data as SavedSnapshot));
}

export async function pushSharedSnapshot(snapshot: SavedSnapshot, expectedRevision?: number, signal?: AbortSignal): Promise<SavedSnapshot> {
  const response = await fetch('/api/snapshot', {
    method: 'POST',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, expectedRevision }),
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || !payload.data) {
    const error = new Error(payload.message ?? `snapshot save failed: ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return persistSnapshot(normalizeClientSnapshot(payload.data as SavedSnapshot));
}

export async function clearSharedSnapshot(signal?: AbortSignal): Promise<void> {
  const response = await fetch('/api/snapshot', { method: 'DELETE', signal, cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(payload.message ?? `snapshot delete failed: ${response.status}`);
  clearSavedSnapshot();
}

export function persistSnapshot(snapshot: SavedSnapshot): SavedSnapshot {
  localStorage.setItem(savedSnapshotKey, JSON.stringify(snapshot));
  return snapshot;
}

export function saveSnapshotFromDraft(
  draft: SnapshotDraft,
  originalFileNames: string[],
  previousSnapshot: SavedSnapshot | null,
): SavedSnapshot {
  const nextHoldings = mergeHoldings(previousSnapshot?.holdings ?? [], draft);
  const nextAccounts = mergeAccounts(previousSnapshot?.accountSnapshots ?? [], draft);
  const now = new Date().toISOString();
  const accountPositionsUpdatedAt = { ...(previousSnapshot?.accountPositionsUpdatedAt ?? {}) };
  const touchedAccounts = new Set([
    ...draft.holdings.map(accountKey),
    ...draft.accountSnapshots.map(accountKey),
  ]);
  for (const key of touchedAccounts) accountPositionsUpdatedAt[key] = now;
  const saved: SavedSnapshot = {
    revision: previousSnapshot?.revision ?? 0,
    source: draft.source === 'manual' ? 'manual' : 'ocr',
    savedAt: now,
    positionsUpdatedAt: now,
    accountPositionsUpdatedAt,
    originalFileNames,
    warnings: draft.warnings || [],
    holdings: nextHoldings,
    accountSnapshots: nextAccounts,
    buyRecords: previousSnapshot?.buyRecords ?? [],
    sellRecords: previousSnapshot?.sellRecords ?? [],
    importLogs: [createImportLog(draft, now), ...(previousSnapshot?.importLogs ?? [])].slice(0, 80),
  };
  return saved;
}

export function clearSavedSnapshot() {
  localStorage.removeItem(savedSnapshotKey);
}

export function sanitizeHoldings(holdings: Holding[]): Holding[] {
  return holdings.filter((holding) => holding.symbol && holding.qty > 0);
}

export function sanitizeAccounts(accounts: AccountSnapshot[]): AccountSnapshot[] {
  return accounts.filter((account) => account.account && account.netAsset >= 0);
}

function toNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mergeHoldings(previousHoldings: Holding[], draft: SnapshotDraft): Holding[] {
  const merged = [...previousHoldings];

  for (const draftHolding of draft.holdings) {
    const holding: Holding = {
      broker: draftHolding.broker,
      account: draftHolding.account,
      market: draftHolding.market,
      type: draftHolding.type,
      name: draftHolding.name,
      symbol: draftHolding.symbol,
      currency: draftHolding.currency,
      qty: toNumber(draftHolding.qty),
      price: toNumber(draftHolding.price),
      cost: toNumber(draftHolding.cost),
      todayPnl: 0,
      totalPnl: (toNumber(draftHolding.price) - toNumber(draftHolding.cost)) * toNumber(draftHolding.qty),
    };
    const index = merged.findIndex((item) => holdingKey(item) === holdingKey(holding));
    if (index >= 0) {
      merged[index] = holding;
    } else {
      merged.push(holding);
    }
  }

  return sanitizeHoldings(merged);
}

function mergeAccounts(previousAccounts: AccountSnapshot[], draft: SnapshotDraft): AccountSnapshot[] {
  const merged = [...previousAccounts];

  for (const draftAccount of draft.accountSnapshots) {
    const account: AccountSnapshot = {
      broker: draftAccount.broker,
      account: draftAccount.account,
      market: draftAccount.market,
      currency: draftAccount.currency,
      netAsset: toNumber(draftAccount.netAsset),
    };
    const index = merged.findIndex((item) => accountKey(item) === accountKey(account));
    if (index >= 0) {
      merged[index] = account;
    } else {
      merged.push(account);
    }
  }

  return sanitizeAccounts(merged);
}

function holdingKey(holding: Pick<Holding, 'broker' | 'account' | 'market' | 'symbol'>) {
  return `${holding.broker}::${holding.account}::${holding.market}::${holding.symbol.toUpperCase()}`;
}

function accountKey(account: Pick<AccountSnapshot, 'broker' | 'account' | 'market'>) {
  return `${account.broker}::${account.account}::${account.market}`;
}

function normalizeClientSnapshot(snapshot: SavedSnapshot): SavedSnapshot {
  const savedAt = String(snapshot.savedAt || new Date().toISOString());
  const positionsUpdatedAt = String(snapshot.positionsUpdatedAt || savedAt);
  const accountPositionsUpdatedAt = { ...(snapshot.accountPositionsUpdatedAt ?? {}) };
  for (const item of [...(snapshot.holdings ?? []), ...(snapshot.accountSnapshots ?? [])]) {
    const key = accountKey(item);
    if (!accountPositionsUpdatedAt[key]) accountPositionsUpdatedAt[key] = positionsUpdatedAt;
  }
  return {
    ...snapshot,
    revision: Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : 0,
    savedAt,
    positionsUpdatedAt,
    accountPositionsUpdatedAt,
    holdings: Array.isArray(snapshot.holdings) ? snapshot.holdings : [],
    accountSnapshots: Array.isArray(snapshot.accountSnapshots) ? snapshot.accountSnapshots : [],
    buyRecords: Array.isArray(snapshot.buyRecords) ? snapshot.buyRecords as BuyRecord[] : [],
    sellRecords: Array.isArray(snapshot.sellRecords) ? snapshot.sellRecords as SellRecord[] : [],
    importLogs: Array.isArray(snapshot.importLogs) ? snapshot.importLogs as ImportAuditRecord[] : [],
  };
}

function createImportLog(draft: SnapshotDraft, savedAt: string): ImportAuditRecord {
  const accounts = new Set([
    ...draft.holdings.map((item) => `${item.broker} · ${item.account}`),
    ...draft.accountSnapshots.map((item) => `${item.broker} · ${item.account}`),
  ]);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: draft.source === 'manual' ? 'manual' : 'ocr',
    savedAt,
    summary: draft.summary.trim().slice(0, 160),
    holdingCount: draft.holdings.length,
    accountCount: draft.accountSnapshots.length,
    accounts: Array.from(accounts).slice(0, 20),
    warningCount: draft.warnings.length,
  };
}
