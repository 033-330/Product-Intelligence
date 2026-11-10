# PI 代码结构审查报告（复审）

- 首次审查：2026-10-26
- 本次复审：2026-10-30
- 最近复核：2026-11-02（按当前代码复核报告，并写入 V2.1 P0 改造任务，见 §7）
- 审查范围：根目录全部 `.js` / `.gs` / `site.html` / 配置文件，以及 `dev/`、`legacy/`、`tests/`
- 审查方式：静态阅读 + 引用关系检索 + `node --check` 语法检查；2026-11-02 追加 `npm run check` / `npm test`，并用真实 Crawl4AI 对 Logitech PRO X SUPERLIGHT 2 DEX 做过一次端到端验证
- 结论性质：结构复审。2026-10-30 轮未改动业务代码；2026-11-02 轮已落地 URL 核验第一批低风险改造（见 §3.1），并把 V2.1 P0 方案固化为实施任务（见 §7）

---

## 1. 总体结论

自首次审查以来，绝大多数 P0/P1 问题已修复：重复全局函数已消除、规格链路已接通、Review Search V2 已接线、产品详情已返回官方规格、安全校验已补齐、死代码已清理、历史/实验文件已归档。当前项目已从「代码存在但线上不可用」进入「主链路可用、剩余为体验与覆盖度打磨」阶段。

### 1.1 健康度判断（对比首次审查）

| 维度 | 首次状态 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| 文档自动处理 | 基本可用 | 基本可用 | 指纹、断点、续跑、分块、错误记录完整 |
| 产品/Topic/Feedback | 基本可用 | 基本可用 | 话题按产品隔离、AI 边界裁决已接入 |
| Review Search | 未达标 | 已达标 | V2 已接入 `Api.js`，旧检索已删除 |
| 官方规格采集 | 未达标 | 已达标 | 新表已注册、队列已触发、页面已展示 |
| 安全与权限 | 高风险 | 中风险 | 写 token / 域名校验已上线；`webapp.access=ANYONE` 仍需确认 |
| 可维护性 | 中高风险 | 中低风险 | 重复函数已消除、文件已归档、目录已整理 |

### 1.2 当前优先处理顺序（2026-11-02 更新）

1. **实施 V2.1 P0 五项改造**（定义见 §7）：产品创建与 URL 核验自动衔接、`canonical_name` 写入强校验、结构感知分块、`general_discussion` 落库、`DOCS_PER_RUN` 与动态运行预算。
2. **Events 彻底退出新 Pipeline**（§7.7）：先备份历史数据、停止新增写入、清理前端与 API 依赖，不得物理删除历史表。
3. **确认部署意图**：`appsscript.json` 的 `webapp.access` 仍为 `ANYONE`（§4.2）。

---

## 2. 当前代码结构

### 2.1 文件规模与归属

| 文件 | 领域 | 判断 |
| --- | --- | --- |
| `site.html` | 前端 | 保留 |
| `Config.js` | 配置 | 保留 |
| `Store.js` | 数据层 | 保留（已含全部 PRD 表） |
| `Api.js` | 查询/路由 | 保留（路由已统一） |
| `Page.js` | 物化视图 | 保留（已返回 `official_specs`） |
| `Pipeline.js` | 入库 | 保留 |
| `AutoSync.js` | 同步 | 保留（已触发规格入队） |
| `Gemini.js` | AI + Prompt | 保留（唯一 `callGemini` / `extractJson_`） |
| `OpenRouterClient.js` | 备用 AI | 保留为适配器 |
| `SpecificationTasks.js` | 规格 | 保留（主链路） |
| `ReviewSearch.js` | 检索 | 保留（已接线） |
| `features.js` | 产品名解析 + 比较 | 保留（已精简） |
| `Maintenance.js` | 数据治理 | 保留（含 `resetAllData_`） |
| `Menu.js` | 菜单 | 保留 |
| `Debug.js` | 诊断 | 保留 |
| `ProductUrlVerification.js` | URL 核验 | 保留 |
| `Crawl4AI.js` | 抓取适配 | 保留 |
| `TrendAnalysis.js` | 趋势 | 保留 |
| `SmokeTest.gs` | 冒烟 | 保留（2026-11-02 新增状态报告与触发器安装入口） |
| `Crawl4AISingleTest.gs` | 单产品 Crawl4AI 测试 | 新增（手动运行 `testCrawl4AIDex`） |
| `dev/PromptEval.js` | Prompt 实验 | 已归档到 dev |
| `dev/SpecAITest.gs.js` | 规格实验 | 已归档到 dev |
| `legacy/MouseSpecsScraper.js` | 旧规格 | 已归档到 legacy |
| `legacy/BrandExtractionRules.js` | 旧规格配置 | 已归档到 legacy |
| `legacy/UniversalCrawler.js` | 旧爬虫 | 已归档到 legacy |
| `tests/pure.test.js` | 纯函数测试 | 保留（`npm test`） |
| `tests/check-syntax.js` | 语法与重复函数检查 | 保留（`npm run check`） |
| `tests/crawl4ai.manual.js` | Crawl4AI 单次手动测试 | 新增（Node 直连，支持 `--self-test`） |
| `runclasp.js` / `runthis.js` | clasp 快捷脚本 | 本地工具，不参与 GAS 部署 |
| `fix_smoke.ps1` | 冒烟修复脚本 | 本地工具 |
| `samples/` | 真实报告样本 | 测试数据 |

### 2.2 当前调用关系

```text
site.html
  └─ google.script.run.apiDispatch() / doGet
       ├─ 读：buildProductList_ / buildPage_（含 official_specs、events）/ buildTopicDetail_ / buildNeedsOverview_
       ├─ 读：searchProductReviewsV2_（Api.js:417）
       ├─ 读：buildEvents_ / listEvents（Api.js:284、:411）
       ├─ 读：compareProducts_（features.js:38）
       ├─ 写：refreshProductSpecifications_（唯一规格写入口）
       └─ 写：processSpecificationTasks_ / buildSpecificationTaskStatus_

AutoSync（6 小时触发器 / 60 秒续跑）
  ├─ collectWatchedFiles_ → syncFileById → processDriveFile_
  │    ├─ readFileText_
  │    ├─ buildDeterministicSegments_（6000 字机械切块）
  │    ├─ ensureIssue_ / upsertDocument_
  │    ├─ callAI(buildPassAPrompt_, PASS_A_SCHEMA)
  │    └─ writeDocumentExtraction_
  │         ├─ resolveProducts_ → createProduct_（不写 official_url）
  │         ├─ resolveTopicsBatch_（0.75 规则命中 + Gemini 边界裁决）
  │         └─ Feedback / UserNeeds / Competitors / Events
  ├─ applyOpenTopicMerges_（AutoSync.js:710）
  ├─ rebuildProductPages_
  ├─ enqueueMissingSpecificationTasks_（AutoSync.js:731）
  └─ processSpecificationTasks_(2)（AutoSync.js:734）

ProductUrlVerification（6 小时触发器，需安装，见 §3.1）
  ├─ verifyProductUrl_ → inspectOfficialProductUrl_（UrlFetch）
  │    └─ tryRenderedMatch_ → crawl4aiRenderPage_（SPA 空壳/反爬兜底）
  └─ verifyProductUrls_ → verified / check_failed / not_found / mismatch
       ├─ verified：回写 official_url + official_url_status
       └─ not_found / mismatch：清空 URL + status=quarantined（默认不删除）

SpecificationTasks
  ├─ 入队门禁：enqueueSpecificationTask_ 要求 isProductUrlVerified_
  ├─ 执行前门禁：ensureVerifiedProductUrl_（未通过直接抛错）
  ├─ 采集：extractOfficialSpecs_ → Crawl4AI /extract 或 urlfetch
  └─ 写表：saveOfficialSpecs_
```

---

## 3. 已修复问题清单

以下首次审查中的问题经本次复审确认已修复：

| 编号 | 原问题 | 修复依据 |
| --- | --- | --- |
| 4.1 | 重复 `callGemini` / `extractJson_` | `AIClient.js` 已删除；`Gemini.js` 唯一定义 |
| 4.1 | 重复 `refreshProductSpecifications_` | `features.js` 旧版已删除；`SpecificationTasks.js:260` 唯一定义 |
| 4.2 | `SHEET_DEFS` 缺规格表 | `Store.js:5` 已含 `ProductSpecificationsRaw` / `SpecificationDefinitions` / `SpecificationTasks` / `ProductCategories` / `ProductComponents` |
| 4.2 | `setupSheets()` 不初始化字典 | `Store.js:174` 已调用 `seedProductCategories_` / `seedSpecificationDefinitions_` |
| 4.2 | 同步后不触发规格入队 | `AutoSync.js:731` 调用 `enqueueMissingSpecificationTasks_`，`:734` 调用 `processSpecificationTasks_` |
| 4.2 | `applyOpenTopicMerges_` 未调用 | `AutoSync.js:710` 已接入 |
| 4.3 | Review Search V2 未接线 | `Api.js:417` 已调用 `searchProductReviewsV2_`；`features.js` 旧检索已删除 |
| 4.4 | `buildPage_` 不返回 `official_specs` | `Page.js:133-144` 已返回，`:165` 已输出 |
| 4.5 | `WRITE_TOKEN` 未定义 / 校验失效 | `Config.js:102` 从 Script Properties 读取，未配置时拒绝 |
| 4.5 | 无域名限制 | `Config.js:109` `assertAllowedUser_` + `Api.js:14`/`:401` 入口校验 |
| 4.5 | 写操作暴露在公开 GET | `Api.js:25-29` `isPublicReadAction_` 白名单限制 |
| 4.5 | `.clasprc.json` 留在项目目录 | 已移除；`.gitignore` / `.claspignore` 已排除 |
| 4.5 | 模型名未编码 | `Gemini.js:89` 已 `encodeURIComponent(model)` |
| 4.6 | `getMouseSpecComparison_` 悬空引用 | `Api.js` 已删除该分支 |
| 5.1 | 三套规格实现 | 已收敛为 `SpecificationTasks.js` 主链路；旧实现归档 `legacy/` |
| 5.2 | 两套路由返回结构不一致 | `doGet` 已统一转发 `apiDispatch`（`Api.js:30`）；`buildProductDetail_` 已合并为 `buildPage_` |
| 5.3 | 详情页两条读取路径 | `buildProductDetail_` → `buildPage_`（`Api.js:204`）；前端统一走 `getPage` |
| 5.4 | `buildPass0Prompt_` / `PASS_0_SCHEMA` 死代码 | `Gemini.js` 已删除，改为 `buildDeterministicSegments_` |
| 5.4 | `buildNeedsList_` 重复 | 已删除，仅保留 `buildNeedsOverview_` |
| 5.4 | `feedbackInWindow_` / `purgeRows_` 未使用 | 已删除 |
| 5.5 | 历史/实验文件混在生产目录 | 已移入 `dev/`、`legacy/` |
| 5.6 | `AUTO_SYNC_HOURS` 与读取不一致 | `AutoSync.js:807` 已用 `CONFIG.AUTO_SYNC_HOURS` |
| 5.6 | `BRAND_SYNONYMS` 未定义 | `Config.js:56` 已定义 |
| 5.7 | 无版本控制 | 已是 git 仓库，`.gitignore` 就位 |
| 5.7 | 无 `package.json` / 测试目录 | `package.json` + `tests/` 已存在 |
| 5.8 | 前端硬编码只保留 Logitech | `site.html` 该过滤已移除 |
| 6.2 | `Reset.js` 重复 | 已删除；`resetAllData_` 在 `Maintenance.js:224` |

### 3.1 2026-11-02 已落地改动（URL 核验第一批 + Crawl4AI 接入）

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| “删除/隔离”语义统一 | `ProductUrlVerification.js:10`、`Config.js:44-47` | 默认只隔离不删除；级联删除需显式 `{ deleteInvalid:true, quarantineOnly:false }` |
| 运行入口显式参数 | `ProductUrlVerification.js:532` | `runProductUrlVerification` 改为 `deleteInvalid:false` + `quarantineOnly:true`，不再传“哑参数” |
| 返回值硬编码修复 | `ProductUrlVerification.js:527` | 返回值 `quarantineOnly` 改为如实返回入参，而非恒为 `true` |
| 触发器幂等安装 | `ProductUrlVerification.js:545` / `:551` | `isProductUrlVerifyTriggerInstalled_` / `ensureProductUrlVerifyTrigger_`；旧入口不再“先删后建” |
| 状态报告增强 | `SmokeTest.gs:176` | 增加触发器状态、隔离原因分布、最近失败前 3 |
| 菜单入口 | `Menu.js:32` | 「7) 安装/检查 URL 核验触发器（6小时）」 |
| Crawl4AI 规格采集 | `Crawl4AI.js`、`SpecificationTasks.js` | `/extract` 与 `/render` 适配，含 429/5xx 重试；真实页面验证成功（7 条规格） |
| 单产品测试入口 | `Crawl4AISingleTest.gs` | `testCrawl4AIDex()`，在 Apps Script 编辑器手动运行 |
| 本地测试能力 | `tests/crawl4ai.manual.js`、`package.json` | `npm run test:crawl4ai`，含 `--self-test` 离线断言 |

已发现的遗留问题（均进入 §7 P0 范围）：

- Crawl4AI 返回的 7 条规格 `unit` 全为空，且 `raw_value` 等于裸数值，特征符合扁平兜底路径 `c4aiFlatToSpecs_`；`saveOfficialSpecs_` 不补单位。
- 异步核验此前依赖手动安装触发器，未安装时静默不生效（已通过 §3.1 的幂等入口与状态可见缓解）。
- 品牌白名单仍为代码硬编码，非白名单品牌无法核验通过。

---

## 4. 剩余问题

### 4.1 `compareProducts_` 未按品类分组与统一单位

- `features.js:38` 的 `compareProducts_` 仍直接合并全部 `spec_key`，未读取 `SpecificationDefinitions.comparison_group` 做分组。
- 未按 `normalization_rule` 统一单位（如重量统一 g、尺寸统一 mm）。
- 缺失值无统一文案，空值直接展示。

建议：比较时按 `comparison_group` 分组，用 `SpecificationDefinitions` 的 `unit` / `normalization_rule` 归一，缺失字段显示「—」或「未公布」。

### 4.2 `webapp.access` 仍为 `ANYONE`

- `appsscript.json:19` `access: ANYONE`，`executeAs: USER_ACCESSING`。
- `assertAllowedUser_` 在配置 `ALLOWED_EMAIL_DOMAIN` 后会拒绝非白名单账号，但未配置时任何人都能触发只读接口。
- 写接口已由 `assertWriteToken_` + `isPublicReadAction_` 保护，风险有限。

建议：明确部署意图。若仅内部使用，改为 `MYSELF` 或配置 `ALLOWED_EMAIL_DOMAIN`。

### 4.3 `GEMINI_MODEL` 可能非 API model id

- `Config.js:12` 值为 `gemini-3.1-flash-lite`，看起来是展示名。若该 ID 在 Gemini API 不存在，`callGeminiProvider_` 会持续失败并回退 OpenRouter。
- 代码层面已 `encodeURIComponent`，无编码问题。

建议：确认实际可用的 model id，或依赖 `AI_PROVIDER_ORDER` 回退即可。

### 4.4 前端分页已实现（原问题关闭）

- `site.html:630` `reviewState`，`:639` 传 `page` / `pageSize`，`:645` / `:647` 已有「上一页 / 下一页」按钮，`:659` 有事件绑定。
- 后端 `searchProductReviewsV2_` 支持分页。该项从剩余问题中移除。

### 4.5 测试覆盖仍有限

- 现有：`npm test`（pure + AI fallback）、`npm run check`（语法 + 重复函数）、`tests/crawl4ai.manual.js --self-test`（离线断言）。
- 缺：GAS 端到端检查清单、P0 专项测试矩阵（§7.8），以及分块、名称校验、三路验证冲突、多文档单轮的自动化覆盖。

建议：P0 实施时按 §7.8 的用例逐项补测试，并保留一份手动端到端清单（同步 → 检索 → 规格入队 → 页面展示）。

### 4.6 V2.1 P0 技术债（待实施，详见 §7）

| 编号 | 问题 | 当前代码位置 | 影响 |
| --- | --- | --- | --- |
| P0-1 | 产品创建后没有 URL 核验任务，靠独立触发器事后兜底 | `Pipeline.js:179`、`ProductUrlVerification.js` | 新产品 `official_url` 为空，规格采集被门禁挡住 |
| P0-2 | AI 输出的 `canonical_name` 基本被信任 | `Pipeline.js:194`、`:243-248` | 错误名称会污染字典、别名、话题与反馈归属 |
| P0-3 | 6000 字机械切块，非语义分块 | `Pipeline.js:542` | 跨块的主题、产品与评论上下文被切断 |
| P0-4 | `general_discussion` 抽了但不落库 | `Gemini.js:373`、`Pipeline.js:393` | 已消耗 Token 的信息被直接丢弃 |
| P0-5 | `CONFIG.DOCS_PER_RUN` 未定义，实际每轮只处理 1 个 | `AutoSync.js:465` | 吞吐低、触发器调度次数与运行管理成本升高 |
| P0-6 | Events 仍在生成、写入和展示 | `Gemini.js:359`、`Pipeline.js:528`、`Api.js:284`/`:411`、`Page.js:150`、`site.html` | 用户已决定彻底删除，需先停写并保留历史 |

---

## 5. 重点文件索引（当前有效位置）

| 主题 | 位置 |
| --- | --- |
| AI 统一入口 | `Gemini.js:33` `callAI` |
| `callGemini` / `extractJson_` 唯一定义 | `Gemini.js:80` / `:201` |
| Pass A prompt / schema | `Gemini.js:388` / `:290` |
| 评论检索（V2） | `ReviewSearch.js`，接线 `Api.js:417` |
| 写 token 校验 | `Config.js:102` |
| 域名白名单校验 | `Config.js:110`，入口 `Api.js:14` / `:401` |
| 公开 GET 白名单 | `Api.js:36` |
| 规格表定义 | `Store.js:5` |
| 规格字典初始化 | `SpecificationTasks.js:225` / `:232`，接入 `Store.js:175-176` |
| 规格入队 | `AutoSync.js:731`，门禁 `SpecificationTasks.js:241-253` |
| 规格采集 / 写入 | `SpecificationTasks.js:196` / `:278` |
| 规格队列执行 | `AutoSync.js:734` / `SpecificationTasks.js:300` |
| 产品详情返回规格 | `Page.js:165` |
| URL 核验（单产品） | `ProductUrlVerification.js:203` |
| URL 核验（批量） | `ProductUrlVerification.js:375` |
| 核验触发器幂等安装 | `ProductUrlVerification.js:551` |
| Crawl4AI 抽取 / 渲染 | `Crawl4AI.js:56` / `:165` |
| 文本分块 | `Pipeline.js:542` |
| 文档明细写入 | `Pipeline.js:393` |
| Events 写入 / 读取 | `Pipeline.js:528` / `Api.js:284` |
| 同步间隔配置 | `Config.js:41`，使用 `AutoSync.js:807` |
| Web App 部署 | `appsscript.json:16-20` |

---

## 6. 审查附注

- 2026-10-30 轮未执行删除/合并操作；2026-11-02 轮只落地了 URL 核验第一批低风险改造（§3.1），未改动抓取判定逻辑。
- 当前主链路可用，但**数据质量与吞吐存在结构性缺陷**（§4.6），因此下一步不是体验打磨，而是按 §7 实施 V2.1 P0。
- 建议实施顺序：P0-4（零新增 AI 调用、最快见效）→ P0-5（解锁吞吐）→ P0-2（名称安全）→ P0-1 → P0-3（后两者改动面最大）。
- 行号以 2026-11-02 的代码快照为准；实施前请重新核对，避免因后续修改产生漂移。

---

## 7. V2.1 P0 核心改造任务（2026-11-02 已实施）

> **状态**：已实施并推送 Apps Script（22 个文件）。端到端验证入口见 §7.11。本节保留任务定义作为验收基准；实施结果以 §7.11 为准。

### 7.0 范围与必须遵守的原则

本次只实施 **P0**，不扩展 P1/P2：

1. 产品创建与 URL 验证自动衔接（P0-1）。
2. `canonical_name` 写入强制校验（P0-2）。
3. 结构感知分块（P0-3）。
4. `general_discussion` 落库（P0-4）。
5. 单轮处理数量与动态预算（P0-5）。
6. Events 彻底退出新 Pipeline（§7.7，用户已决策）。

项目原则：

- 不推倒重建，优先在现有架构上做最小必要修改。
- 保留现有数据结构与功能，除非任务明确要求修改。
- 不得破坏断点续跑、幂等、去重、PendingQueue、定时触发器。
- 所有新增逻辑必须考虑 Apps Script 执行时间与配额。
- 减少 Gemini Token，但不能牺牲抽取准确率、信息完整性、Evidence 可追溯性。
- 优先代码规则与缓存，只有确定性规则无法解决时才调用 Gemini。
- 不得未经检查就假设函数、Sheet、字段存在。
- 不得直接删除或覆盖生产历史数据。
- 只做 P0，不擅自扩展。

### 7.1 P0-1：产品创建与 URL 验证自动衔接

**现状（已核实）**

- `createProduct_()`（`Pipeline.js:179`）只写基础字段，`official_url` 允许为空。
- 独立核验链路已存在：`verifyProductUrl_`（`ProductUrlVerification.js:203`）、`verifyProductUrls_`（`:375`）、`inspectOfficialProductUrl_`、`tryRenderedMatch_`，以及 6 小时触发器 `runProductUrlVerification`（安装函数 `:551`）。
- 采集侧已有两道门禁：入队 `enqueueSpecificationTask_` 要求 `isProductUrlVerified_`（`SpecificationTasks.js:253`）；执行前 `ensureVerifiedProductUrl_` 再拦一次（`ProductUrlVerification.js:560`）。

**目标**

- 创建产品后自动进入待验证状态并产生验证任务，由异步 Worker 执行。
- **禁止**在 `createProduct_()` 内同步等待网络抓取或 AI。
- 验证通过后更新产品状态；只有 Verified 的产品才能进入规格采集。

**三路验证协同（不是多数投票）**

| 方式 | 职责 |
| --- | --- |
| HTTP（程序） | 状态码、重定向链、最终 URL、Title、是否存在有效产品信息；识别 403/404/429/5xx |
| Crawl4AI | 提取正文、产品名/品牌/型号、判断产品身份信息是否足够，并为 Gemini 提供页面证据 |
| Gemini | 判断内容与名称/品牌/类别是否匹配，识别同名产品、系列页、分类页、无关页；输出判断、理由、置信度 |

判定原则：

- HTTP 200 不等于验证成功。
- 页面可打开但产品名不匹配 → 不通过。
- Gemini 判匹配但页面为空或已跳转到无关页 → 不通过。
- 三方冲突 → 待复核，不强行通过。

**分层与缓存（Token 优化）**

1. 先 HTTP 检查。
2. 可访问后再按需 Crawl4AI。
3. 确定性规则无法确认产品身份时才调用 Gemini。
4. URL 未变、内容 Hash 未变且已有有效结果 → 复用缓存。
5. URL、内容或结果状态变化时才重新执行必要检查。

**必须交付**

- 产品创建与验证任务的自动衔接。
- URL 验证状态字段（待验证 / verified / check_failed / not_found / mismatch / 待复核）。
- 异步任务的创建、执行、重试、失败处理。
- Verified 后才能进入规格采集的门禁。
- 验证日志与失败原因。
- 对现有核验能力的兼容方案（不新建第二套验证体系）。

**实施前待确认**

- 异步任务载体：复用 `PendingQueue`，还是新建 `UrlVerificationTasks` 表。
  - 建议：新增轻量任务表并复用现有 `verifyProductUrls_` 的执行逻辑，避免把长任务塞进 `PendingQueue` 的通用语义。
- 现有批量核验触发器是否保留：建议保留，只把“创建后立即入队”补上。

### 7.2 P0-2：`canonical_name` 写入强制校验

**现状（已核实）**

- `resolveProducts_()`（`Pipeline.js:194`）在新建产品时使用 `ai.canonical_name || ai.canonical_guess`（`:243`）。
- 写入层只做标注后缀剥离、空名回退（`:245-248`），没有独立校验，也不进 PendingQueue。
- 已有产品命中别名时直接复用，不改名，这部分已符合规则 1。

**规则**

1. **已有产品**：必须使用 Products 表 `canonical_name`；AI 输出的其他名称只能作为 Alias 候选，不得覆盖。
2. **新产品**：优先 `name_as_written`；`canonical_guess` 只作建议；原文名称无法确认时进入 PendingQueue，不创建猜测名称。
3. **写入前强制校验**：
   - 名称为空；
   - 名称是否真实出现在原文，或有明确可追溯的标准化依据；
   - 是否误把品牌、品类、功能、技术名当产品；
   - 是否与现有产品重复；
   - 是否包含 AI 编造的型号、后缀、版本；
   - 是否存在明显实体类型错误。
4. **校验失败**：不写 Products，写 PendingQueue，记录原文名称、AI 建议名称、失败原因、来源 Evidence。
5. **名称变更必须有记录**，不能静默覆盖。

**可信等级**

原文名称 > 规则标准化名称 > 已有字典 `canonical_name` > AI 建议名称。不得用简单字符串清洗代替可信度判断。

**必须交付**

- 独立校验函数（建议 `validateProductNameBeforeWrite_`）。
- `createProduct_()` 与解析流程修改。
- 已有产品 / 新产品不同策略。
- 异常名称进 PendingQueue。
- 名称变更留痕。

### 7.3 P0-3：结构感知分块

**现状（已核实）**

- `buildDeterministicSegments_()`（`Pipeline.js:542`）按 6000 字机械切块，优先在块后 40% 范围内找换行。
- 每块 `title = 文件名｜原文分块 NNN`，`url = 文件 URL`；`docKey_ = normalize(url|title)`（`:663`）是断点续跑的唯一键。

**目标**

- 优先识别：文档标题、章节标题、段落、产品讨论区、评论区、表格、列表、独立讨论主题。
- 在结构边界内按 Token 预算二次切分。
- 每个 Segment 保留：`segment_id`、`parent_section`、`source_document_id`、`start_offset`、`end_offset`、`content_hash`、必要上下文。
- 跨块内容：保留适量前后文重叠；避免重复抽取；明确主内容与上下文补充；不产生重复 Evidence。
- 不调用 Gemini 做语义预切块；结构识别用代码；块大小由 Token 预算决定；重叠有上限；同 Hash 复用抽取结果；结构不规范时必须有确定性降级方案。

**兼容风险（实施重点）**

- 分块方式变化会导致历史 `docKey_` 失效：需引入 `segmenter_version`，并决定旧进度是迁移还是重置；不得把新 Segment 误判为已完成。
- 新旧分块并存可能重复写入：去重键需要包含 `content_hash`。

**必须交付**

- 改造 `buildDeterministicSegments_()`。
- 保留断点续跑。
- Segment ID / Hash 稳定。
- 历史处理状态不错误跳过新 Segment。
- 跨块产品讨论、评论、表格的测试。

### 7.4 P0-4：`general_discussion` 落库

**现状（已核实）**

- Schema 与 Prompt 都要求输出 `general_discussion`（`Gemini.js:373-383`、`:402`）。
- `writeDocumentExtraction_()`（`Pipeline.js:393-540`）没有任何落库分支，数据被丢弃。

**目标**

- 新增 `General_Discussions` Sheet，并完成写入。
- 直接复用 Pass A 已生成的结果，**不再调用 Gemini 重新总结**。
- 保留原始 Evidence；允许与产品无关；能明确关联时才填 `related_product_id`；不强行归属；去重；保留 issue 与 source document；无有效 Evidence 不写。

**建议字段**（按现有表风格对齐，实施时以现有字段为准，避免重复）

| 字段 | 用途 |
| --- | --- |
| `discussion_id` | 唯一 ID |
| `issue_no` | Newsletter 期号 |
| `document_id` | 来源文档 |
| `discussion_type` | 讨论类型 |
| `title` | 讨论标题 |
| `summary` | 讨论摘要 |
| `sentiment` | 情绪倾向 |
| `evidence` | 原文证据 |
| `evidence_id` | 关联 Evidence（若现有体系无此概念则留空） |
| `related_product_id` | 可选，明确关联的产品 |
| `created_at` | 创建时间 |

**必须交付**

- `Store.js` 表定义 + `setupSheets()` 初始化 + 写入分支 + 去重 + 测试。

### 7.5 P0-5：`DOCS_PER_RUN` 与动态运行预算

**现状（已核实）**

- `CONFIG.DOCS_PER_RUN` 全项目未定义；`AutoSync.js:465` 的 `Number(CONFIG.DOCS_PER_RUN) || 1` 恒为 1。
- 外层已有：`MAX_ROUNDS_PER_FILE = 5`、`MAX_RUN_MS = 4 分钟`、60 秒续跑触发器、脚本锁。

**目标**

- 明确定义 `DOCS_PER_RUN`，给出合理默认值（建议先 2，经真实样本再评估 3）。
- 每批处理前估算剩余预算（已用时间 + 单文档平均耗时）。
- 接近 5 分钟官方上限前主动停止，交给续跑。
- 保留锁、续跑、断点、失败进 PendingQueue。
- 防止并发重复写入。

**必须交付**

- 配置字段、动态预算判断、多文档单轮测试。
- 记录每轮实际处理数量、耗时、Token 消耗。

### 7.6 全程 Token 效率与计量

必须满足：

1. 产品精确匹配优先 `ProductAliases`，不调 Gemini。
2. 已有产品 `canonical_name` 直接取字典。
3. 只有未匹配且存在歧义的候选才批量调 Gemini。
4. 相同 Segment Hash + Prompt Version + Schema Version + Model 复用抽取结果。
5. URL 未变且已有有效验证结果时复用缓存。
6. `General_Discussions` 直接复用 Pass A。
7. 分块用代码，不额外调 AI。
8. 代码能算的字段不让 Gemini 输出。

必须记录：每阶段 Gemini 调用次数、Input Tokens、Output Tokens、Cache Hit、每文档 Token、每轮 Token。

不得为省 Token 删除必要的产品信息、评论、讨论或 Evidence。

### 7.7 Events 彻底退出（用户已决策，必须遵守）

**现有依赖清单（2026-11-02 实测）**

| 位置 | 依赖 |
| --- | --- |
| `Gemini.js:359-372` | `PASS_A_SCHEMA.events` |
| `Gemini.js:400-401` | Prompt 第 8 条事件抽取 |
| `Pipeline.js:97` | `buildDedupSets_` 读取 Events |
| `Pipeline.js:399-410` | 事件产品名解析 |
| `Pipeline.js:522-539` | 写入 Events |
| `Api.js:38` | 公开只读 action 白名单含 `listEvents` |
| `Api.js:276-284` | `listEvents` 构建 |
| `Api.js:411` | 路由分发 |
| `Page.js:150` | 详情页读取 Events |
| `Page.js:167` | 详情返回 `events` |
| `site.html:207` | 「相关事件」面板 |
| `site.html:317` | `loadEvents()` 调用 |
| `site.html:339-341` | `loadEvents` 实现 |
| `site.html:373` | 重置事件面板 |
| `site.html:440-447` | 渲染事件与失败文案 |
| `Maintenance.js:61-63` | 重写 Events 表 |
| `ProductUrlVerification.js:334` | 级联删除关联表列表 |
| `SmokeTest.gs:448` | 级联删除检查 |
| `Store.js:34` | `Events` 表定义 |

**说明**：当前代码中**不存在** `Event_Products` / `Event_Topics` / `Event_Evidence` 副表依赖，只有单张 `Events`。

**实施要求**

- Pass A 不再生成 `events[]`；Schema 与 Prompt 同步移除。
- 不再执行事件产品解析；不再写入 Events。
- 不增加任何替代性事件实体。
- `General_Discussions` 只保存真正的行业讨论与非产品专属讨论；产品相关信息归入 Products、Topics、Feedback、UserNeeds、Competitors 或规格体系。
- 已有 Events 表：先检查代码和页面依赖、备份历史数据、停止新增写入；**不得未经授权物理删除**。

**兼容策略建议**

- 保留 `Events` 表与 `listEvents` 只读接口，避免历史页面报错，仅停止写入。
- 前端移除「相关事件」面板，或改为「已停用」占位。
- `ProductUrlVerification.js:334` 与 `SmokeTest.gs:448` 中的级联删除列表保留，历史表仍可被安全清理。

### 7.8 测试矩阵

**URL 验证**

- 正确官方产品页
- 404 页面
- 403 页面
- 重定向到其他产品
- HTTP 200 但内容不匹配
- Gemini 与 Crawl4AI 判断冲突
- URL 变化后重新验证
- 已验证且内容未变化时命中缓存

**产品名称**

- 已有产品匹配
- 原文名称与 AI 建议名称不同
- AI 添加不存在的型号后缀
- 品牌名误判为产品
- 品类名误判为产品
- 同一产品多个别名
- 无法确认名称时进入 PendingQueue

**文档分块**

- 超长段落
- 多产品连续讨论
- 评论区
- 表格
- 标题与正文
- 跨 Segment 上下文
- 相同 Segment Hash 缓存

**General_Discussions**

- 正常落库
- 重复讨论去重
- 无 Evidence 拒绝写入
- 产品关联为空
- 产品关联有效
- 不重复调用 Gemini

**单轮处理**

- 多个 Segment
- 多个文档
- 中途超时
- 续跑
- 并发锁冲突
- 已完成 Segment 跳过
- 单个 Segment 失败不影响其他任务

**Events 回归**

- Pass A 输出中不存在 `events` 字段
- 不存在 Events 写入
- 不再依赖 Event 关联表
- 不再调用事件产品解析逻辑
- 前端不再请求 `listEvents`

### 7.9 执行流程与生产安全边界

**执行顺序**

1. **Step 1 代码审计**：梳理真实调用关系，定位五个 P0 问题的具体位置，检查 Events 全部依赖，列出受影响的 Sheet 与页面。
2. **Step 2 改造计划**：列出要改的文件、要新增的函数与字段、要初始化或迁移的 Sheet、风险点、实施顺序。
3. **Step 3 分模块实施**：每完成一个模块立即运行对应测试，不一次性大规模重构。
4. **Step 4 完整回归**：现有 Pipeline 可运行、断点续跑与幂等、URL 门禁、General_Discussions 落库、多文档处理、Events 已退出。
5. **Step 5 交付报告**：按 §7.10 输出。

**未经明确授权，不允许**

- 修改线上 Google Sheets 数据。
- 删除历史数据。
- 修改生产环境 Script Properties。
- 修改生产触发器。
- 执行全量历史数据重抽取。
- 执行影响正式数据的批量迁移。

优先在测试副本中开发和验证；必须进行线上操作时，先列出操作内容、影响范围、回滚方案并等待授权。

### 7.10 交付报告要求

1. 修改了哪些文件。
2. 每个文件改了什么。
3. 新增了哪些函数。
4. 新增或修改了哪些 Sheet 和字段。
5. 哪些测试已通过。
6. 哪些测试尚未完成。
7. Token 消耗预计如何变化。
8. 是否存在需要人工处理的历史数据。
9. 如何部署。
10. 如何回滚。
### 7.11 实施记录（2026-11-02）

**改动文件**

| 文件 | 改动 |
| --- | --- |
| `Config.js` | 新增 `URL_VERIFY_TASKS_PER_RUN`、`URL_VERIFY_TASK_MAX_ATTEMPTS`、`DOCS_PER_RUN=2`、`DOC_RUN_BUDGET_MS`、`SEGMENTER_VERSION/SEGMENT_*`、`FULL_PIPELINE_MAX_*` |
| `Store.js` | `Documents` 增加 `segment_id/content_hash/parent_section/start_offset/end_offset/segment_type`；新增 `General_Discussions`、`UrlVerificationTasks` 表 |
| `Pipeline.js` | 结构感知分块 + 机械回退；`docKey_` 支持 segment_id；名称强校验；`createProduct_` 写 pending 并入队 URL 验证；`resolveProducts_` 支持原文校验；`general_discussion` 落库；移除 Events 去重/解析/写入；动态预算与 Token 统计 |
| `Gemini.js` | 移除 `PASS_A_SCHEMA.events` 与 Prompt 事件规则；强化 general_discussion；新增上文衔接规则；诊断补充 inputTokens |
| `ProductUrlVerification.js` | 新增 `enqueueUrlVerificationTask_`、`processUrlVerificationTasks_`；`runProductUrlVerification` 改为“任务队列优先，队列为空再批量扫描” |
| `AutoSync.js` | `processDriveFile_` 传入 `budgetMs`；`DOCS_PER_RUN` 生效 |
| `Api.js` / `Page.js` / `site.html` | `listEvents` 返回空并标记 retired；详情页不再读 Events；移除前端事件加载与面板 |
| `FullPipelineEntry.gs` | 新增端到端入口 `smoke_fullPipelineFromInputSheet` / `runFullPipelineFromText_` |
| `Menu.js` | 新增「4.6) 端到端：文本→分块→实体→URL→规格」 |
| `tests/p0.test.js` | 新增 20 项纯函数断言；`npm test` 已包含 |

**新增 Sheet/字段**

- `General_Discussions`：discussion_id、issue_no、document_id、discussion_type、title、summary、sentiment、evidence、evidence_id、related_product_id、content_hash、created_at。
- `UrlVerificationTasks`：task_id、product_id、url、status、priority、attempt_count、max_attempts、next_attempt_at、created_at、started_at、finished_at、last_error、result、notes、checked_at。
- `Documents` 新增 6 个分块字段，`setupSheets()` 幂等补列。

**端到端入口**

1. 表格打开「SmokeInput」，把文本粘贴到 `A2`。
2. 菜单「冒烟测试 → 4.6) 端到端：文本→分块→实体→URL→规格」。
3. 弹窗显示摘要，`SmokeInput!A3` 起显示逐阶段明细（含 Token、URL 状态、规格条数）。
4. 限额由 `FULL_PIPELINE_MAX_SEGMENTS/PRODUCTS/SPECS` 控制（默认 3/3/2）。

**已验证**

- `npm run check`：32 文件语法 + 227 根函数去重通过。
- `npm test`：既有 pure/AI fallback + 新增 20 项 P0 断言全部通过。
- `clasp push`：22 个文件推送成功。

**未验证（需线上人工跑）**

- 真实 AI + Crawl4AI 的端到端入口（受配额与执行时间影响）。
- 新表首次创建、补列与历史数据兼容。
- 多文档单轮与 60 秒续跑在真实同步中的表现。
- 前端移除事件面板后的实际渲染。

**回滚**

- 代码：`git` 恢复到 2026-11-02 快照（`3c04afd` 之后的 P0 提交）。
- 配置：把 `SEGMENTER_VERSION` 改回 `'v1'` 可恢复机械分块。
- 数据：新增表可保留，不影响旧逻辑；`setupSheets()` 只补列不删列。
- Events：历史表未删除，`listEvents` 仍保留只读兼容。
