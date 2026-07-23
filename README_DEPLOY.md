# 股票持仓总览部署说明

这是一个 Vite + React 静态前端项目，默认使用合成演示快照，并通过 `/api/quotes` 获取 10 秒刷新行情。持仓相关新闻、AI 问询和截图 OCR 由 `/api/holding-news`、`/api/risk-analysis`、`/api/ocr-snapshot` 提供。

## 本地构建

```bash
npm install
npm run build
```

构建结果在 `dist/` 目录。

## 静态部署

把 `dist/` 目录发布到 Web 服务器即可，例如 Caddy：

```caddyfile
portfolio.example.com {
    encode gzip zstd

    handle /api/quotes* {
        reverse_proxy https://qt.gtimg.cn {
            header_up Host qt.gtimg.cn
        }
    }

    handle /api/risk-analysis* {
        reverse_proxy gup-risk:8791
    }

    handle /api/ocr-snapshot* {
        reverse_proxy gup-risk:8791
    }

    handle /api/snapshot* {
        reverse_proxy gup-risk:8791
    }

    handle /api/holding-news* {
        reverse_proxy gup-risk:8791
    }

    handle /api/market-history* {
        reverse_proxy gup-risk:8791
    }

    handle {
        root * /path/to/dist

        @html path / /index.html
        header @html Cache-Control "no-cache, no-store, must-revalidate"
        header @html Pragma "no-cache"
        header @html Expires "0"

        @assets path /assets/*
        header @assets Cache-Control "public, max-age=31536000, immutable"

        try_files {path} {path}/ /index.html
        file_server
    }
}
```

## 后端服务

轻量后端入口为：

- `server/risk-analysis.mjs`

本地启动：

```bash
npm run risk:server
```

Docker 示例：

```bash
docker compose -f docker-compose.risk.yml up -d --build
```

建议设置环境变量：

- `OPENAI_API_KEY`：服务端默认 AI Key，可不填，用户也可在页面右上角自行配置
- `OPENAI_BASE_URL`：OpenAI 兼容接口地址，默认 `https://api.openai.com/v1`
- `RISK_MODEL` / `OPENAI_MODEL`：默认模型
- `ANTHROPIC_API_KEY`：Anthropic Key，可选
- `SNAPSHOT_FILE`：共享快照 JSON 路径，默认 `/app/data/snapshot.json`

共享快照需要持久化目录，例如：

```yaml
volumes:
  - ./data/gup-risk:/app/data
```

## 数据位置

默认持仓快照在：

- `src/data/mockPortfolio.ts`

生产运行后，确认导入的数据会优先保存在服务端共享快照：

- `/api/snapshot`
- `SNAPSHOT_FILE` 指向的 JSON 文件

要替换默认数据，优先修改：

- `holdings`
- `accountSnapshots`

## 注意

- 当前代码已包含服务端 AI OCR 快照识别、持仓相关新闻和 AI 问询；登录保护需要在 Caddy、Nginx 或 Cloudflare Access 中配置。
- 确认导入后的持仓快照会写入服务端 `/api/snapshot`，其它浏览器打开时会优先读取共享快照；本地 localStorage 只作为离线缓存。
- 页面右上角钥匙按钮可配置 AI API。配置只保存在当前浏览器 localStorage，源码包和服务端不会内置个人 API Key。
- 如果不在页面配置 AI API，后端会继续使用服务器环境变量里的 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。
- 行情源为公开接口，适合个人监控，不等同券商交易报价。
- 趋势页已接入港股分时和美股 Nasdaq 日/周/月历史行情；未覆盖标的会显示待接入。
- 下单、对账、最终资产确认仍以券商 App 为准。
