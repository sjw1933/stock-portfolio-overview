import { Eye, EyeOff, KeyRound, LogOut, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import type { AppContext } from '../appContext';
import type { AiApiConfig, Currency } from '../types';
import { clearAiConfig, defaultAiConfig, sanitizeAiConfig } from '../utils/aiConfig';

export function TopBar({ context }: { context: AppContext }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  function logout() {
    window.location.href = '/logout';
  }

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Stock Portfolio Overview</p>
        <h1>股票持仓总览</h1>
      </div>
      <div className="top-actions">
        <CurrencySwitch value={context.currency} onChange={context.setCurrency} />
        <button className="icon-button" onClick={() => context.setMasked(!context.masked)} title="隐藏金额">
          {context.masked ? <EyeOff size={20} /> : <Eye size={20} />}
        </button>
        <button className="icon-button" onClick={() => void context.refresh()} title="刷新行情">
          <RefreshCw size={20} />
        </button>
        <button className={`icon-button ${context.aiConfig.apiKey ? 'ai-ready-button' : ''}`} onClick={() => setSettingsOpen(true)} title="AI API 设置" aria-label="AI API 设置">
          <KeyRound size={20} />
        </button>
        <button className="icon-button logout-button" onClick={logout} title="退出登录" aria-label="退出登录">
          <LogOut size={20} />
        </button>
      </div>
      {settingsOpen && <AiSettingsDialog context={context} onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

function AiSettingsDialog({ context, onClose }: { context: AppContext; onClose: () => void }) {
  const [draft, setDraft] = useState<AiApiConfig>(context.aiConfig);

  function update(patch: Partial<AiApiConfig>) {
    const next = sanitizeAiConfig({ ...draft, ...patch });
    setDraft(next);
  }

  function save() {
    context.setAiConfig(sanitizeAiConfig(draft));
    onClose();
  }

  function reset() {
    clearAiConfig();
    context.setAiConfig(defaultAiConfig);
    setDraft(defaultAiConfig);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="ai-settings-modal" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <div className="ai-settings-head">
          <div>
            <p className="eyebrow">私有配置</p>
            <h2 id="ai-settings-title">AI API 设置</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭 AI API 设置">
            <X size={20} />
          </button>
        </div>

        <p className="ai-settings-note">配置只保存在当前浏览器本地。打包给别人部署时，对方可以填自己的 Key，不需要使用你的服务器密钥。</p>

        <label>
          服务商
          <select value={draft.provider} onChange={(event) => update({ provider: event.target.value as AiApiConfig['provider'], baseUrl: '', model: '' })}>
            <option value="openai">OpenAI / 兼容接口</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>

        <label>
          Base URL
          <input value={draft.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} placeholder={draft.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} />
        </label>

        <label>
          模型
          <input value={draft.model} onChange={(event) => update({ model: event.target.value })} placeholder={draft.provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.5'} />
        </label>

        <label>
          API Key
          <input type="password" value={draft.apiKey} onChange={(event) => update({ apiKey: event.target.value })} placeholder="sk-..." autoComplete="off" />
        </label>

        <div className="ai-settings-actions">
          <button type="button" className="secondary-action" onClick={reset}>清除</button>
          <button type="button" className="primary-action" onClick={save}>保存</button>
        </div>
      </section>
    </div>
  );
}

function CurrencySwitch({ value, onChange }: { value: Currency; onChange: (currency: Currency) => void }) {
  return (
    <div className="segmented" aria-label="币种切换">
      {(['HKD', 'USD', 'CNY'] as Currency[]).map((item) => (
        <button key={item} className={value === item ? 'active' : ''} onClick={() => onChange(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}
