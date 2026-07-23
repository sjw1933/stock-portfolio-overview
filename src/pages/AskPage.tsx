import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, RefreshCw, Send, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import type { AppContext } from '../appContext';
import type { AggregatedHolding, Currency, Holding, PortfolioSummary } from '../types';
import { fetchAskAnalysis } from '../utils/askAnalysis';
import { aiConfigPayload } from '../utils/aiConfig';
import { convert, money, signed } from '../utils/currency';

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  meta?: string;
};

const askChatStorageKey = 'gup-ask-chat-v1';
const maxSavedMessages = 80;

export function AskPage({ context }: { context: AppContext }) {
  const [draft, setDraft] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const dataProfile = useMemo(() => buildDataProfile(context), [context]);
  const suggestedPrompts = useMemo(() => buildSuggestedPrompts(dataProfile), [dataProfile]);
  const [messages, setMessages] = useState<ChatMessage[]>(() => readSavedMessages(dataProfile));
  const chatWindowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveMessages(messages);
    const chatWindow = chatWindowRef.current;
    if (chatWindow) chatWindow.scrollTop = chatWindow.scrollHeight;
  }, [messages]);

  async function sendQuestion(question: string) {
    const normalized = question.trim();
    if (!normalized || isAsking) return;

    const pendingId = `assistant-${Date.now()}`;
    setIsAsking(true);

    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: 'user', text: normalized },
      {
        id: pendingId,
        role: 'assistant',
        text: '正在分析当前持仓和市场数据，通常需要 10-45 秒。',
        meta: 'AI 分析中',
      },
    ]);
    setDraft('');

    try {
      const result = await fetchAskAnalysis({
        question: normalized,
        holdings: context.holdings,
        summary: context.summary,
        currency: context.currency,
        quoteStatus: context.quoteStatus,
        lastRefresh: context.lastRefresh,
        riskSummary: context.riskSummary,
        risks: context.risks.map((risk) => ({ level: risk.level, title: risk.title, text: risk.text })),
        newsSummary: context.newsSummary,
        newsItems: context.newsItems.slice(0, 8),
        ...aiConfigPayload(context.aiConfig),
      });
      setMessages((current) => current.map((message) => (
        message.id === pendingId
          ? { ...message, text: result.answer, meta: result.source === 'ai' ? `AI 接口 · ${result.model}` : `本地兜底 · ${result.model}` }
          : message
      )));
    } catch (error) {
      console.warn('ask analysis failed, using local fallback', error);
      setMessages((current) => current.map((message) => (
        message.id === pendingId
          ? { ...message, text: answerQuestion(normalized, dataProfile), meta: '接口失败 · 本地兜底' }
          : message
      )));
    } finally {
      setIsAsking(false);
    }
  }

  function resetChat() {
    if (messages.length > 1 && !window.confirm('确定清空当前问询记录，并重新读取当前看板数据吗？')) return;
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        role: 'assistant',
        text: buildWelcomeText(dataProfile),
        meta: '已重新读取当前看板数据',
      },
    ]);
  }

  return (
    <div className="page-stack ask-page">
      <section className="panel ask-panel">
        <div className="ask-header">
          <div>
            <div className="ask-title">
              <Bot size={20} />
              <h2>AI 问询</h2>
            </div>
            <p>基于你的账户净值、持仓、盈亏和风险预警做复盘分析。</p>
          </div>
          <button type="button" className="ask-reset" onClick={resetChat} aria-label="清空对话并重新读取当前看板数据">
            <RefreshCw size={17} />
            <span>新对话</span>
          </button>
        </div>

        <div className="ask-context-grid" aria-label="当前问询上下文">
          <div>
            <span>总资产净值</span>
            <b>{money(dataProfile.summary.total, context.currency, context.masked)}</b>
          </div>
          <div>
            <span>持仓盈亏</span>
            <b className={dataProfile.summary.totalPnl >= 0 ? 'pos' : 'neg'}>{signed(dataProfile.summary.totalPnl, context.currency, context.masked)}</b>
          </div>
          <div>
            <span>最大仓位</span>
            <b>{dataProfile.largestHolding ? `${dataProfile.largestHolding.symbol} · ${dataProfile.largestHolding.weight.toFixed(1)}%` : '暂无'}</b>
          </div>
        </div>

        <div className="ask-notice">
          <ShieldCheck size={16} />
          <span>仅基于当前看板结构化数据分析，不构成投资建议；交易前仍以券商 App 和你的交易计划为准。</span>
        </div>

        <div className="prompt-row" aria-label="推荐问题">
          {suggestedPrompts.map((prompt) => (
            <button type="button" key={prompt} onClick={() => void sendQuestion(prompt)} disabled={isAsking}>
              {prompt}
            </button>
          ))}
        </div>

        <div className="chat-window" aria-live="polite" ref={chatWindowRef}>
          {messages.map((message) => (
            <article className={`chat-message ${message.role}`} key={message.id}>
              <div className="chat-avatar" aria-hidden="true">
                {message.role === 'assistant' ? <Sparkles size={16} /> : <UserRound size={16} />}
              </div>
              <div className="chat-bubble">
                {message.meta && <span>{message.meta}</span>}
                <p>{message.text}</p>
              </div>
            </article>
          ))}
        </div>

        <form
          className="ask-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendQuestion(draft);
          }}
        >
          <label htmlFor="ask-input">输入你的问题</label>
          <div>
            <input
              id="ask-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="例如：我现在应该先看哪个风险？"
              autoComplete="off"
            />
            <button type="submit" disabled={!draft.trim() || isAsking} aria-label="发送问题">
              <Send size={18} />
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function readSavedMessages(profile: DataProfile): ChatMessage[] {
  try {
    const saved = JSON.parse(localStorage.getItem(askChatStorageKey) || 'null') as ChatMessage[] | null;
    if (Array.isArray(saved) && saved.length) {
      return saved
        .filter((message) => (message.role === 'assistant' || message.role === 'user') && typeof message.text === 'string')
        .map((message) => isPendingMessage(message)
          ? { ...message, text: '上一次请求因页面刷新中断，请重新发送问题。', meta: '请求已中断' }
          : message)
        .slice(-maxSavedMessages);
    }
  } catch {
    // Ignore corrupted browser cache and rebuild the welcome message.
  }

  return [
    {
      id: 'welcome',
      role: 'assistant',
      text: buildWelcomeText(profile),
      meta: '基于当前看板快照',
    },
  ];
}

function isPendingMessage(message: ChatMessage) {
  return message.role === 'assistant'
    && (message.meta === 'API 请求中'
      || message.meta === 'AI 分析中'
      || message.text.startsWith('正在调用 AI 接口')
      || message.text.startsWith('正在分析当前持仓'));
}

function saveMessages(messages: ChatMessage[]) {
  try {
    localStorage.setItem(askChatStorageKey, JSON.stringify(messages.slice(-maxSavedMessages)));
  } catch (error) {
    console.warn('failed to save ask chat history', error);
  }
}

function buildSuggestedPrompts(profile: DataProfile) {
  const largest = profile.largestHolding;
  const loss = profile.largestLoss;
  const marketLeader = [...profile.marketWeights].sort((a, b) => b.weight - a.weight)[0];
  const marketLabel = marketLeader?.market === 'US' ? '美股' : marketLeader?.market === 'HK' ? '港股' : '市场';
  const refreshLabel = profile.quoteStatus === 'live' ? '实时行情' : profile.quoteStatus === 'refreshing' ? '刷新中' : '截图价';

  return [
    largest ? `${largest.symbol} 占 ${largest.weight.toFixed(1)}%，现在最大风险是什么？` : '当前持仓里最大风险是什么？',
    loss ? `${loss.symbol} 亏损 ${formatSigned(loss.pnl, profile.currency)}，要关注什么？` : '当前有没有亏损标的需要复盘？',
    marketLeader ? `${marketLabel}约 ${marketLeader.weight.toFixed(1)}%，仓位是否失衡？` : '美股和港股仓位是否失衡？',
    `${refreshLabel}下，下一步该核对什么？`,
  ];
}

type HoldingProfile = {
  symbol: string;
  name: string;
  market: Holding['market'];
  type: Holding['type'];
  value: number;
  pnl: number;
  todayPnl: number;
  weight: number;
};

type DataProfile = {
  currency: Currency;
  summary: PortfolioSummary;
  holdingCount: number;
  lastRefresh: string;
  quoteStatus: AppContext['quoteStatus'];
  largestHolding: HoldingProfile | null;
  largestLoss: HoldingProfile | null;
  marketWeights: Array<{ market: Holding['market']; value: number; weight: number }>;
  highRisks: string[];
};

function buildDataProfile(context: AppContext): DataProfile {
  const total = Math.max(context.summary.total, 1);
  const profiles = context.aggregated.map((item) => toHoldingProfile(item, context.currency, total));
  const marketMap = new Map<Holding['market'], number>();

  profiles.forEach((item) => {
    marketMap.set(item.market, (marketMap.get(item.market) ?? 0) + item.value);
  });

  return {
    currency: context.currency,
    summary: context.summary,
    holdingCount: context.aggregated.length,
    lastRefresh: `最后更新 ${context.lastRefresh}`,
    quoteStatus: context.quoteStatus,
    largestHolding: profiles[0] ?? null,
    largestLoss: [...profiles].sort((a, b) => a.pnl - b.pnl)[0] ?? null,
    marketWeights: Array.from(marketMap.entries()).map(([market, value]) => ({ market, value, weight: (value / total) * 100 })),
    highRisks: context.risks.filter((risk) => risk.level === '高').map((risk) => `${risk.title}：${risk.text}`),
  };
}

function toHoldingProfile(item: AggregatedHolding, currency: Currency, total: number): HoldingProfile {
  const value = convert(item.marketValue, item.currency, currency);
  const pnl = convert(item.totalPnl, item.currency, currency);
  const todayPnl = convert(item.todayPnl, item.currency, currency);

  return {
    symbol: item.symbol,
    name: item.name,
    market: item.market,
    type: item.type,
    value,
    pnl,
    todayPnl,
    weight: (value / total) * 100,
  };
}

function buildWelcomeText(profile: DataProfile) {
  const largest = profile.largestHolding ? `${profile.largestHolding.symbol} 当前约占 ${profile.largestHolding.weight.toFixed(1)}%` : '暂无持仓';
  const loss = profile.largestLoss ? `${profile.largestLoss.symbol} 累计盈亏 ${formatSigned(profile.largestLoss.pnl, profile.currency)}` : '暂无亏损项';
  return `我已读取当前看板数据：总资产净值 ${formatMoney(profile.summary.total, profile.currency)}，持仓盈亏 ${formatSigned(profile.summary.totalPnl, profile.currency)}。目前最大仓位是 ${largest}，最大亏损线索是 ${loss}。你可以问我风险、仓位结构、单标的复盘或下一步检查清单。`;
}

function answerQuestion(question: string, profile: DataProfile) {
  const lower = question.toLowerCase();
  if (question.includes('亏损')) return answerLoss(profile);
  if (question.includes('美股') || question.includes('港股') || question.includes('失衡') || question.includes('仓位')) return answerAllocation(profile);
  if (question.includes('下一步') || question.includes('检查') || question.includes('怎么做')) return answerChecklist(profile);
  if (question.includes('风险') || question.includes('最大')) return answerRisk(profile);
  return answerGeneral(profile);
}

function answerRisk(profile: DataProfile) {
  const largest = profile.largestHolding;
  const highRisk = profile.highRisks[0] ?? '当前没有高等级硬预警，但仍需要关注行情刷新状态和截图数据一致性。';
  return `从当前数据看，第一优先级是持仓风险而不是收益表现。${largest ? `${largest.symbol}（${largest.name}）是最大仓位，占总资产约 ${largest.weight.toFixed(1)}%，` : ''}高等级预警为：${highRisk} 当前持仓盈亏为 ${formatSigned(profile.summary.totalPnl, profile.currency)}，今日盈亏为 ${formatSigned(profile.summary.todayPnl, profile.currency)}。我的判断是：先控制单标的和杠杆 ETF 的波动暴露，再看是否需要调整收益目标。`;
}

function answerLoss(profile: DataProfile) {
  const loss = profile.largestLoss;
  if (!loss) return '当前没有可识别的单标的亏损数据。建议先回到“导入”确认截图中的数量、现价、成本价和账户净值是否都已确认。';
  return `${loss.symbol}（${loss.name}）是当前最需要复盘的亏损线索，累计盈亏 ${formatSigned(loss.pnl, profile.currency)}，今日盈亏 ${formatSigned(loss.todayPnl, profile.currency)}，占总资产约 ${loss.weight.toFixed(1)}%。如果它是杠杆 ETF，核心不是只看亏了多少，而是看三个点：是否超过你预设仓位上限、是否和原本买入理由背离、是否能承受继续波动。第一版系统不重算历史成本，所以成本价以券商截图为准。`;
}

function answerAllocation(profile: DataProfile) {
  const allocation = profile.marketWeights.map((item) => `${item.market === 'US' ? '美股' : '港股'}约 ${item.weight.toFixed(1)}%`).join('，');
  const largest = profile.largestHolding;
  return `当前市场分布为：${allocation || '暂无可计算仓位'}。这不是简单看美股或港股谁多，而是看风险来源是否集中。${largest ? `最大单标的是 ${largest.symbol}，约占 ${largest.weight.toFixed(1)}%。` : ''} 若单一市场加单一标的同时偏高，回撤时会更难判断是市场问题、标的问题，还是杠杆产品的问题。第一版建议先把仓位结构稳定下来，再追踪收益表现。`;
}

function answerChecklist(profile: DataProfile) {
  const status = profile.quoteStatus === 'live' ? '行情刷新当前正常' : '行情可能仍在使用截图价或降级数据';
  return `下一步我建议按这个顺序检查：1. 先核对券商 App 的账户净值和看板总资产是否一致；2. 看最大亏损项和最大仓位是否是同一支；3. 检查杠杆 ETF 是否超过你能承受的仓位；4. 确认 ${status}；5. 再决定是否需要补充新的截图快照。当前总资产净值 ${formatMoney(profile.summary.total, profile.currency)}，剩余资产估算 ${formatMoney(profile.summary.cash, profile.currency)}。`;
}

function answerGeneral(profile: DataProfile) {
  const largest = profile.largestHolding;
  return `我先按复盘口径回答：当前总资产净值 ${formatMoney(profile.summary.total, profile.currency)}，持仓盈亏 ${formatSigned(profile.summary.totalPnl, profile.currency)}，今日盈亏 ${formatSigned(profile.summary.todayPnl, profile.currency)}。${largest ? `最大仓位是 ${largest.symbol}，约 ${largest.weight.toFixed(1)}%。` : ''} 你可以继续追问某只股票、某个账户，或者让我只看风险、仓位、收益其中一个维度。`;
}

function formatMoney(amount: number, currency: Currency) {
  return money(amount, currency, false);
}

function formatSigned(amount: number, currency: Currency) {
  return signed(amount, currency, false);
}
