# PI 代码结构审查报告（复审）

- 首次审查：2026-10-26
- 本次复审：2026-10-30
- 审查范围：根目录全部 `.js` / `.gs` / `site.html` / 配置文件，以及 `dev/`、`legacy/`、`tests/`
- 审查方式：静态阅读 + 引用关系检索 + `node --check` 语法检查
- 结论性质：结构复审。本轮未改动业务代码，仅更新报告以反映自首次审查后的修复情况。

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

### 1.2 本次复审建议优先处理的 3 件事

1. 确认 `appsscript.json` 的 `webapp.access`：当前为 `ANYONE`，配合 `executeAs=USER_ACCESSING` + `assertAllowedUser_` 可在配置 `ALLOWED_EMAIL_DOMAIN` 后收口，但建议明确部署意图。
2. `compareProducts_` 仍直接合并全部 `spec_key`，未按 `SpecificationDefinitions.comparison_group` 分组、未统一单位、未给出缺失值文案。
3. 补最小测试覆盖（`tests/pure.test.js` 已存在，但覆盖范围有限）。

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
| `SmokeTest.gs` | 冒烟 | 保留 |
| `dev/PromptEval.js` | Prompt 实验 | 已归档到 dev |
| `dev/SpecAITest.gs.js` | 规格实验 | 已归档到 dev |
| `legacy/MouseSpecsScraper.js` | 旧规格 | 已归档到 legacy |
| `legacy/BrandExtractionRules.js` | 旧规格配置 | 已归档到 legacy |
| `legacy/UniversalCrawler.js` | 旧爬虫 | 已归档到 legacy |
| `tests/` | 测试 | 保留 |

### 2.2 当前调用关系

```text
site.html
  └─ google.script.run.apiDispatch()
       ├─ buildProductList_ / buildTopicDetail_ / buildNeedsOverview_
       ├─ buildPage_（getProduct 已合并为调用 buildPage_）
       ├─ searchProductReviewsV2_        ← V2 已接线
       ├─ compareProducts_
       ├─ refreshProductSpecifications_  ← 唯一规格写入口
       └─ processSpecificationTasks_ / buildSpecificationTaskStatus_

AutoSync
  ├─ processDriveFile_ → callAI(PASS_A) → writeDocumentExtraction_
  ├─ applyOpenTopicMerges_              ← 已接入
  ├─ rebuildProductPages_
  └─ enqueueMissingSpecificationTasks_ → processSpecificationTasks_  ← 已接入

SpecificationTasks
  └─ 任务队列 + 字典初始化 + 官方页面抓取 + 写表，均已接通
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

---

## 4. 剩余问题

### 4.1 `compareProducts_` 未按品类分组与统一单位

- `features.js:78-79` 仍直接合并全部 `spec_key`，未读取 `SpecificationDefinitions.comparison_group` 做分组。
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

### 4.4 前端分页控件

- `site.html:630` 已有 `reviewState = { page: 1, pageSize: 20 }`，`:639` 已传 `page` / `pageSize`。
- 后端 `searchProductReviewsV2_` 已支持分页。
- 需确认前端是否有「下一页 / 加载更多」控件触发 `reviewState.page` 变化；若仅停留在 `page:1`，分页能力仍只停在参数层。

### 4.5 测试覆盖有限

- `tests/pure.test.js` 存在，但相对全量纯函数（`normalizeAlias`、`bigramSim_`、`isLikelyProductEntity_`、`resolveProductName_`、话题归并、日期窗口、分页）覆盖面有限。
- 无 GAS 端到端清单。

建议：补纯函数测试与一份手动端到端检查清单（同步 → 检索 → 规格入队 → 页面展示）。

---

## 5. 重点文件索引（当前有效位置）

| 主题 | 位置 |
| --- | --- |
| AI 统一入口 | `Gemini.js:33` `callAI` |
| `callGemini` / `extractJson_` 唯一定义 | `Gemini.js:80` / `:199` |
| 评论检索（V2） | `ReviewSearch.js`，接线 `Api.js:417` |
| 写 token 校验 | `Config.js:102` |
| 域名白名单校验 | `Config.js:109`，入口 `Api.js:14` / `:401` |
| 公开 GET 白名单 | `Api.js:36` `isPublicReadAction_` |
| 规格表定义 | `Store.js:5` |
| 规格字典初始化 | `SpecificationTasks.js:154` / `:161`，接入 `Store.js:174` |
| 规格入队 | `AutoSync.js:731` |
| 规格队列执行 | `AutoSync.js:734` / `SpecificationTasks.js:229` |
| 产品详情返回规格 | `Page.js:133` |
| 同步间隔配置 | `Config.js:41`，使用 `AutoSync.js:807` |
| Web App 部署 | `appsscript.json:17` |

---

## 6. 审查附注

- 本轮未执行删除/合并操作，仅更新报告。代码已处于「主链路可用」状态，剩余问题均为体验与覆盖度打磨，无阻塞性风险。
- 建议下一步从 §4.1（比较分组）和 §4.2（部署确认）入手，二者收益高、改动小。
