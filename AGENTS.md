# AGENTS.md

## 项目概览

这是一个手机和折叠屏优先的个人股票持仓看板，技术栈为 Vite、React、TypeScript、Recharts 和 Node.js 原生 HTTP 服务。

仓库内只能保留合成演示数据。不要提交真实持仓、券商截图、账号密码、服务器地址、SSH 密钥、`.env`、API Token 或生产 `data/` 目录。

## 常用命令

```bash
npm install
npm run dev
npm run risk:server
npm run build
node --check server/risk-analysis.mjs
```

前端默认运行在 `http://localhost:5173`，并把 `/api` 代理到 `http://127.0.0.1:8791`。后端共享快照路径由 `SNAPSHOT_FILE` 控制。

## 关键入口

- `src/App.tsx`：应用状态、行情刷新、共享快照同步和交易提交
- `src/pages/ImportPage.tsx`：OCR 与手动持仓增量录入
- `src/pages/HoldingsPage.tsx`：当前持仓、买入记录和卖出记录
- `src/pages/TrendsPage.tsx`：单标的趋势和买卖标记
- `src/utils/snapshotStorage.ts`：快照增量合并和导入审计
- `src/utils/buyTransactions.ts`：买入、加权成本和安全撤销
- `src/utils/sellTransactions.ts`：卖出、已实现盈亏和撤销
- `src/utils/portfolio.ts`：市值、成本、剩余资产和收益汇总
- `server/risk-analysis.mjs`：共享快照、OCR、行情历史、新闻和 AI API

## 数据规则

- 当前持仓匹配键为 `broker + account + market + symbol`。
- OCR 和手动持仓都是账户级增量快照，只覆盖明确提交的持仓。
- 手动持仓数量代表当前总量；买入和卖出才是交易增量。
- 券商快照是当前持仓真值，历史买卖记录继续保留。
- 买入成本使用加权平均并计入费用；卖出盈亏锁定提交时成本。
- 有后续快照或同标的交易时，撤销旧买入只能撤销历史状态，不反向修改当前持仓。
- 所有共享快照写入必须携带 `expectedRevision`，冲突时先刷新再重试。

## 修改约束

- 保持手机优先，并检查约 390px、720px 和桌面宽度。
- 复用现有 8px 圆角、lucide 图标和高信息密度布局。
- 不在前端内置 API Key，不把生产快照复制到源码。
- 修改数据结构时同时更新客户端归一化和 `server/risk-analysis.mjs` 的服务端归一化。
- 完成后至少执行 `npm run build`、`node --check server/risk-analysis.mjs` 和 `git diff --check`。
