# 股票持仓总览（Stock Portfolio Overview）交接文档

这是一套个人股票持仓监控 Web 看板，面向美股和港股持仓管理。当前版本是 MVP 前端骨架 + 轻量 Node 后端，主要能力包括账户总览、持仓列表、趋势查看、截图 OCR、手动持仓录入、买卖登记、持仓相关新闻和 AI 问询。

本文档用于接手修改代码。仓库已做脱敏处理，默认数据均为合成演示数据，不包含真实账号、密码、API Key、域名、服务器 IP 或真实持仓。

## 1. 技术栈

- 前端：Vite + React + TypeScript
- 图表：Recharts
- 图标：lucide-react
- 后端：Node.js 原生 HTTP 服务，入口为 `server/risk-analysis.mjs`
- 部署形态：前端静态文件 + 后端 API 服务 + Caddy/Nginx 反向代理

## 2. 本地启动

安装依赖：

```bash
npm install
```

启动前端开发服务器：

```bash
npm run dev
```

启动后端 API 服务：

```bash
npm run risk:server
```

构建前端：

```bash
npm run build
```

构建结果在 `dist/` 目录。

## 3. 目录说明

```text
src/App.tsx                    应用主状态、刷新逻辑、共享快照读取
src/pages/OverviewPage.tsx     总览页
src/pages/HoldingsPage.tsx     持仓页
src/pages/TrendsPage.tsx       趋势页
src/pages/AskPage.tsx          AI 问询页
src/pages/ImportPage.tsx       OCR、手动持仓录入和导入审计
src/components/                页面组件
src/utils/portfolio.ts         汇总、市值、盈亏计算
src/utils/quotes.ts            实时行情刷新
src/utils/marketHistory.ts     单标的趋势行情
src/utils/ocrSnapshot.ts       前端 OCR API 调用
src/utils/snapshotStorage.ts   本地/共享快照存取与增量合并
src/utils/buyTransactions.ts   买入、加权成本和安全撤销
src/utils/sellTransactions.ts  卖出、已实现盈亏和撤销
src/utils/holdingNews.ts       持仓相关新闻 API 调用
src/utils/askAnalysis.ts       AI 问询 API 调用
src/utils/aiConfig.ts          浏览器端 AI API 配置保存
src/data/mockPortfolio.ts      脱敏演示持仓数据
server/risk-analysis.mjs       后端 API、OCR、新闻、AI 问询、共享快照
Dockerfile.risk                后端 Docker 镜像
docker-compose.risk.yml        后端服务示例 compose
README_DEPLOY.md               部署说明
```

## 4. 当前功能边界

已实现：

- 总览、持仓、趋势、导入、AI 问询几个主入口
- 默认港币口径，可切换美元和人民币
- 10 秒刷新一次页面行情数据
- 首页展示持仓成本、持仓收益、总市值、剩余资产估算
- 总览层按标的合并，明细层按账户拆开
- OCR 截图导入，识别后逐行人工确认
- OCR 按账户维度增量更新，不会自动清空截图里没出现的账户
- 手动持仓按账户增量更新，数量按当前总持仓覆盖
- 买入登记、加权平均成本、买入记录和安全撤销
- 卖出登记、已实现盈亏、卖出记录和撤销
- 趋势图显示有效买入点和卖出点
- OCR 与手动持仓更新都有精简导入审计记录
- 服务端共享快照，多个浏览器读取同一份最新数据
- AI API Key 可在页面里配置，配置保存在当前浏览器 localStorage
- 持仓相关新闻从 Investing 相关来源抓取/匹配
- AI 问询结合当前持仓、行情和相关新闻回答

暂未实现：

- 多用户系统
- 数据库账号体系
- 订单流水识别
- 自动重算历史成本
- 券商真实交易接口
- 账户历史净值长期数据库
- 复杂技术指标和预测模型

## 5. 数据流

### 默认数据

默认演示数据在：

```text
src/data/mockPortfolio.ts
```

主要包含：

- `holdings`：持仓明细
- `accountSnapshots`：账户净值
- `baseRiskAlerts`：默认提示卡片

正式使用时，可以保留演示数据，也可以改成空数据或客户自己的初始化数据。

### OCR 与手动持仓数据

导入流程：

1. 用户上传券商截图
2. 前端调用 `/api/ocr-snapshot`
3. 后端调用 AI 视觉模型识别图片
4. 前端展示识别草稿
5. 用户逐行确认
6. 前端调用 `/api/snapshot` 保存共享快照
7. 后续所有浏览器优先读取共享快照

手动持仓使用同一套匹配键和增量合并逻辑。手动数量代表当前总持仓，不是新增数量；新增成交必须走“登记买入”。

### 买入和卖出流水

买入记录保存在 `buyRecords`，卖出记录保存在 `sellRecords`。买入按原持仓成本、成交金额和费用计算加权平均成本。后续导入券商快照时，券商数量和成本成为当前真值，历史交易记录不会再次叠加。

如果一笔买入之后已经存在新快照或同标的交易，撤销只改变该记录状态，不自动回退当前持仓，避免破坏最新券商数据。

增量合并规则在：

```text
src/utils/snapshotStorage.ts
```

持仓匹配键：

```text
broker + account + market + symbol
```

账户匹配键：

```text
broker + account + market
```

## 6. 常见修改点

### 增加券商

需要同步改三处：

```text
src/pages/ImportPage.tsx       OCR 复核页下拉选项
src/types.ts                   Holding 类型里的 broker 联合类型
server/risk-analysis.mjs       supportedBrokers 白名单和 OCR 归一化
```

默认券商列表在演示代码中保留为常见券商名称，实际项目可以替换成自己的券商白名单。

### 修改首页指标

首页和汇总卡片主要在：

```text
src/pages/OverviewPage.tsx
src/components/PortfolioSummaryCard.tsx
src/utils/portfolio.ts
```

成本、市值、盈亏、剩余资产估算的核心计算在 `src/utils/portfolio.ts`。

### 修改 OCR 提示词

OCR 提示词在：

```text
server/risk-analysis.mjs
```

搜索：

```text
请从这些券商截图中识别个人持仓快照
```

注意：提示词改完后需要重启后端服务。

### 修改 AI 问询回答风格

AI 问询的系统提示和数据拼接在：

```text
server/risk-analysis.mjs
src/utils/askAnalysis.ts
src/pages/AskPage.tsx
```

后端负责真正调用模型，前端负责展示对话窗口和保存浏览器本地对话记录。

### 修改行情刷新频率

前端定时刷新在：

```text
src/App.tsx
```

搜索：

```text
setInterval
```

当前是 10 秒刷新一次。

## 7. 后端 API

后端入口：

```text
server/risk-analysis.mjs
```

主要接口：

```text
GET    /api/snapshot          读取共享快照
POST   /api/snapshot          保存共享快照
DELETE /api/snapshot          删除共享快照
POST   /api/ocr-snapshot      OCR 识别券商截图
POST   /api/risk-analysis     风险/问询 AI 分析
POST   /api/holding-news      持仓相关新闻
GET    /api/market-history    单标的趋势行情
```

共享快照文件由环境变量控制：

```text
SNAPSHOT_FILE=/app/data/snapshot.json
```

如果用 Docker，记得挂载持久化目录，避免容器重建后快照丢失。

## 8. AI API 配置

支持两种方式：

1. 服务端环境变量配置默认 Key
2. 用户在页面右上角配置自己的 Key

常用环境变量：

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=
```

页面里配置的 API Key 只保存在当前浏览器 `localStorage`，不会写入源码包。

## 9. 部署建议

前端：

```bash
npm run build
```

把 `dist/` 发布到 Web 服务器目录。

后端：

```bash
docker compose -f docker-compose.risk.yml up -d --build
```

Caddy/Nginx 需要把这些路径反代到后端：

```text
/api/risk-analysis*
/api/ocr-snapshot*
/api/snapshot*
/api/holding-news*
/api/market-history*
```

行情代理 `/api/quotes*` 当前示例走腾讯公开行情接口。若部署环境无法访问，需要替换行情源。

## 10. 安全注意事项

- 不要把 `.env`、真实 API Key、服务器 SSH Key、真实持仓截图打进分发包
- 如果给别人部署，建议让对方自己在页面或 `.env` 中配置 AI API Key
- `data/` 目录可能包含共享快照，分发源码时不要包含
- 生产环境建议加 Basic Auth、Cloudflare Access 或其它登录保护
- 这套看板只做展示和辅助分析，不负责真实交易和最终对账

## 11. 交接验证清单

朋友修改后，至少跑下面几步：

```bash
npm install
npm run build
node --check server/risk-analysis.mjs
```

如果部署后页面打不开，优先检查：

1. 前端 `dist/` 是否发布到 Caddy/Nginx 实际读取目录
2. Caddy/Nginx 的 SPA 回退是否配置了 `try_files ... /index.html`
3. 后端容器是否启动
4. `/api/snapshot` 是否能返回 JSON
5. 浏览器是否缓存了旧 JS 文件

## 12. 发布仓库检查

提交到 GitHub 前应确认排除：

```text
node_modules/
dist/
.git/
.env
data/
历史 zip 包
```

仓库提供 `.env.example` 作为配置模板；真实 `.env`、共享快照和截图不得提交。
