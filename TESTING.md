# 测试与验收清单

## 本地自动检查

```powershell
npm test
npm run check
```

- `npm test`：纯函数测试 + AI provider fallback 顺序测试。
- `npm run check`：对根目录、`dev/`、`legacy/`、`tests/` 下所有 JS 执行 `node --check`。
- `site.html` 内联脚本需单独抽取后 `node --check`，或直接在浏览器控制台确认无语法错误。

## 部署前准备

1. 在 Apps Script Project Settings 中配置 Script Properties：
   - `CRAWL4AI_API_KEY`（规格爬虫推荐；配了它就自动走 Crawl4AI，无需再配 Gemini）
   - `GEMINI_API_KEY`
   - `OPENROUTER_API_KEY`
   - `WRITE_TOKEN`（外部 `sync` / `rebuildPages` / `runSpecTaskQueue` 必填）
   - 可选：`ALLOWED_EMAIL_DOMAIN`
   - 可选：`AI_PROVIDER_ORDER=gemini,openrouter`
   - 可选：`SPEC_CRAWLER=auto|crawl4ai|urlfetch`（默认 auto：有 CRAWL4AI_API_KEY 就用 Crawl4AI）
   - 可选：`CRAWL4AI_BASE`（自建实例时覆盖 `https://api.crawl4ai.com`）
   - 可选：`ENABLE_SEMANTIC_REVIEW_SEARCH=true`
2. 运行 `setupSheets()`，确认以下表存在：
   `ProductSpecificationsRaw`、`SpecificationDefinitions`、`SpecificationTasks`、`ProductCategories`、`ProductComponents`。
3. 确认 `appsscript.json` 已包含 Drive Advanced Service v3，并在关联 GCP 项目启用 Drive API。
4. 重新 `clasp login`（旧 `.clasprc.json` 凭证已泄露，必须先轮换）。

## 安全验收

- 未配置 `WRITE_TOKEN` 时，带 `action=sync` 的公开 GET 必须失败。
- 未登录用户通过 `google.script.run` 调用 `refreshProductSpecs`、`sync`、`rebuildPages`、`runSpecTaskQueue` 必须失败。
- `doGet` 公开白名单外的新 action 必须失败，尤其不能通过 GET 触发写表。
- 配置 `ALLOWED_EMAIL_DOMAIN` 后，非白名单域账号无法读取或写入。
- 仓库中不得出现 `.clasprc.json`。

## AI 与规格链路验收

0. 规格抓取器：配置 `CRAWL4AI_API_KEY` 后，`activeSpecCrawler_()` 返回 `crawl4ai`；不配置时回退 `urlfetch`。
   冒烟菜单「4.5) Crawl4AI 规格采集」应能对已核验官网的产品抓回非空规格，并把 `parser_name=crawl4ai_smoke` 写进 `ProductSpecificationsRaw`。
   「【实测】用第14期报告跑完整Pipeline」的弹窗摘要里应包含「规格抓取器：crawl4ai」以及「Crawl4AI 直采：成功 N，失败 M」两行。
1. 仅配置 `GEMINI_API_KEY`：`testGemini()` 成功；额度耗尽/429 时自动回退 OpenRouter。
2. 仅配置 `OPENROUTER_API_KEY`：`testGemini()` 使用 `nvidia/nemotron-3.5-super-vl:free`（1M 上下文 / 131k 输出）成功；该 ID 失效时会自动回退 `minimax/minimax-m3.1-flash:free`，再回退 `openrouter/auto`。
3. 两个 Key 都无效：`callAI` 抛出聚合错误，不能静默返回空结果。
4. 新建一个无规格产品，运行 `autoSync()`：
   - `SpecificationTasks` 出现 `queued`；
   - 执行后变 `done`，或失败后变 `retry` / `failed`；
   - `next_attempt_at` 按退避时间更新；
   - 失败时 `ProductSpecifications` 旧数据不被清空。
5. 产品详情页 `getPage` 返回 `official_specs`，缺值显示“暂无数据/待核验”，来源链接可追溯。

## 官网 URL 核验（Crawl4AI 渲染兜底）

1. `activeSpecCrawler_()` 为 `crawl4ai` 时：官网是 JS 渲染的 SPA 页面，UrlFetch 只能拿到空壳，此时应自动用 Crawl4AI 渲染后再做一次型号匹配，通过则 `official_url_status=verified`，`official_url_notes` 里带“Crawl4AI 渲染页面核验通过”。
2. HTTP 403/429/5xx 时也会走一次渲染兜底；404/410 不兜底，仍判 `invalid_http`。
3. 三个搜索引擎都搜不到候选时，会渲染搜索页兜底取链接（结果同样过域名白名单）。
4. 状态区分：渲染回来但型号不匹配 → `mismatch`（隔离）；渲染器自身失败（503/余额/反爬）→ `check_failed`（保留重试，不隔离），原因写进 `official_url_notes`。
5. 未配置 `CRAWL4AI_API_KEY` 时行为与改动前完全一致（只走 UrlFetch）。

## Review Search 验收

1. 默认 Tab 为 AI Review Search。
2. `battery life` 与 `connection issues` 能命中对应主题；同时命中多个主题的评论排名更高。
3. `dateFrom` / `dateTo` 生效。
4. `page` / `pageSize` 生效，前端上一页/下一页按钮可用。
5. 命中词高亮，来源链接可追溯，空结果不虚构。
6. 未启用语义检索或 AI 不可用时，关键词/同义词检索仍返回真实 Feedback。