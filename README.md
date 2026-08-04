# 股票持仓总览（Stock Portfolio Overview）

一个面向手机和折叠屏优化的美股、港股个人持仓看板。项目采用 React + TypeScript 前端和轻量 Node.js 后端，支持账户总览、持仓拆分、实时行情、趋势图、手动买卖登记、OCR 与手动持仓导入、持仓新闻、走势预判和 AI 问询。

> 仓库内只包含合成演示数据，不包含任何真实持仓、券商截图、账号、密码、服务器地址或 API Token。

## 功能

- 默认美元口径，可切换港币和人民币
- 总览层按标的合并，明细层按券商账户拆分
- 10 秒行情刷新、美股盘前 / 盘中 / 盘后切换查看与盈亏重算
- 合并持仓展示今日盈亏与仓位占比
- 手工登记买入、加权成本、卖出、已实现盈亏和撤销审计
- 券商截图 OCR 识别、逐行确认和账户级增量更新
- 按账户分组手动录入当前持仓，支持变更预览和导入审计
- K 线展示有效买入点和卖出点
- 按 ticker 聚合 Yahoo / Google 新闻，持仓关键词严格匹配；新闻面板可展开收起
- 总览「今日持仓走势预判」：默认规则引擎，可选接入 OpenAI 兼容 / Anthropic 模型增强
- AI 数据问询与风险分析
- 多浏览器共享快照与版本冲突保护
- 持仓页 CNN Fear & Greed 恐慌指数仪表盘
- 手机、折叠屏和电脑响应式布局

近期版本变更见 [CHANGELOG.md](./CHANGELOG.md)。

## OCR 支持的券商

目前已适配以下券商 App 的持仓截图：

- 盈立证券
- 致富证券
- 星财富
- Charles Schwab（系统内显示为 `Schwab`）
- U.S. Bancorp Advisors（系统内显示为 `US Bancorp Advisors`）

当前 OCR 只识别**持仓快照和账户净值**，不识别订单、成交或资金流水。识别完成后会按账户分组展示持仓，用户需要逐行确认代码、名称、数量、成本价、当前价等字段后才能保存。

OCR 保存采用账户级增量更新：只更新本次截图明确识别到的账户和持仓，不会自动清空没有出现在截图里的其他账户。

## 本地运行

```bash
npm install
npm run dev
```

另开一个终端启动后端：

```bash
cp .env.example .env
npm run risk:server
```

前端默认访问 `http://localhost:5173`。开发服务器会把 `/api` 请求代理到本地后端 `http://127.0.0.1:8791`。

## 构建

```bash
npm run build
node --check server/risk-analysis.mjs
```

构建产物位于 `dist/`，该目录不会提交到 Git。

## AI 配置

AI Key 有两种配置方式：

1. 在 `.env` 中配置服务端默认 Key。
2. 在页面右上角的钥匙按钮中填写个人 Key，该配置仅保存在当前浏览器的 `localStorage`。

不要把 `.env`、真实券商截图或 `data/` 目录提交到仓库。

## 部署

部署说明和 Caddy 示例见 [README_DEPLOY.md](./README_DEPLOY.md)，代码交接说明见 [HANDOFF_FOR_FRIEND.md](./HANDOFF_FOR_FRIEND.md)。

## 免责声明

本项目只用于个人资产展示和辅助分析。行情来自公开数据源，成本和净值以券商数据为准，不构成投资建议或交易依据。
