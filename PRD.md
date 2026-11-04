# Product Intelligence — 产品需求文档

版本：V1.1（实现对照版）  
技术栈：Google Apps Script + Google Sheets + Google Drive + HTML/CSS/JavaScript

## 1. 产品目标

建立以产品为中心的产品情报工作台，将 Google Drive 中的产品跟踪文档转化为可检索、可追溯的 Products、Topics、Feedback、UserNeeds、Competitors、Events 和官方规格数据。核心用户为产品经理、产品设计师、用户研究人员和竞品分析人员。

原则：产品优先、证据优先、AI 辅助而非替代证据、尽可能自动化、未知数据不猜测、优先在现有 GAS + Sheets 架构内迭代。

## 2. 产品详情页信息架构

1. AI-Powered Review Search（默认第一个 Tab）
2. Topic Analysis
3. Competitor Comparison
4. Product Overview（含官方规格）
5. Topic Sentiment Analysis
6. All User Feedback

全站产品目录支持名称/别名搜索、品牌筛选、产品类别筛选和讨论量排序。产品数据仍以 Products 为主表，品牌、系列、组件不得错误地当作具体消费级产品参与统计。

## 3. AI-Powered Review Search（P0）

- 输入自然语言或关键词，例如 `Find reviews mentioning battery life and connection issues`。
- 查询拆分为多个主题组，默认匹配任一主题组；同时命中多个主题的评论优先排序。
- 首版使用可解释的关键词/同义词检索；语义检索是可选增强，必须通过脚本属性显式开启。
- 搜索范围限定为当前产品关联的真实 Feedback 记录。
- 支持情绪筛选、日期范围、分页。
- 展示原始评论、命中词高亮、匹配主题、匹配类型、匹配原因、情绪（如有）、来源、日期、平台和来源链接（如有）。
- 不生成虚构评论，不用 AI 改写文本冒充原文。语义检索只能引用候选 Feedback 原记录。
- 无匹配时显示真实空状态；AI 服务不可用时关键词检索继续工作。
- 前端必须对用户评论进行 HTML 转义，不能把原始评论作为不可信 HTML 执行。

## 4. 产品与 Topic 分析（P0/P1）

- 产品目录显示名称、品牌、类别、别名、讨论量和 Top Topics。
- 产品详情展示 Topic 摘要、提及次数、情绪（仅在有可靠标签时）、代表性反馈和来源。
- 展示用户需求/痛点、事件和竞品关联。
- Topic 与产品关联；聚合统计按 Feedback 独立记录计数，并避免重复计数。
- 情绪分析区分正面、负面、中性和未知，不得把未知强行归为中性。

## 5. 官方规格自动采集（P0/P1）

- 覆盖 Logitech / Logitech G 的全品类初始分类：鼠标、轨迹球、指向设备、键盘、键鼠套装、耳机/耳麦/耳塞、扬声器、网络摄像头、会议摄像头/系统、扬声器电话、麦克风、游戏控制器、赛车方向盘、飞行模拟设备、演示器、平板配件、灯光、鼠标垫、接收器、支架和其他配件。
- 新建有效的具体产品后，自动加入规格任务队列；重复提及不重复创建活动任务。
- 优先使用已登记的官方 URL；若缺失，可尝试发现公开官方页面，但必须校验域名。
- 优先使用确定性解析；当前通用回退使用 AI 从官方页面文本中提取明确规格。AI 提取结果必须保留来源并标记为待核验/已解析，不能视为人工认证。
- 标准规格、原始规格、规格定义和任务队列分表存储。
- 保存原始标签/值、标准化值、单位、来源 URL、采集时间、解析器和核验状态。
- 抓取失败、未找到、官方未公布和来源冲突是不同状态。
- 成功提取非空结果后才更新当前规格；失败不能清空旧有效数据。
- 竞品比较按品类选择可比参数，统一单位；缺失值显示“暂无数据/未公布/待核验”，不使用字符串 none 作为数值。
- `Mouse_Specs` 如仍存在，仅作为兼容表，迁移验证完成前不得删除。

## 6. 文档自动处理（P0）

- 轮询配置的 Drive 文件夹及指定文件；GAS 采用定时触发器，不承诺毫秒级实时监听。
- 识别新文件、更新文件、已处理文件和重复内容。
- 提取全文，长文档确定性分块，记录断点、进度和错误。
- 将分块交给 AI 抽取产品、Topic、用户需求、竞品、事件和证据。
- 保留文档、原文、实体和证据的关联；失败任务可恢复；不得静默丢弃文档尾部。
- 支持 Google Docs、Sheets、Slides 和文本格式；PDF/DOCX 转换需启用 Advanced Drive Service / Drive API，并确认所需授权。

## 7. 数据模型

现有核心表：Issues、Documents、Products、ProductAliases、Topics、Feedback、UserNeeds、Competitors、Events、PendingQueue、ProcessedFiles、PageTopics、PageCompetitors、ProductSpecifications。

新增表：ProductSpecificationsRaw、SpecificationDefinitions、SpecificationTasks、ProductComponents、ProductCategories。

所有表名、列名以 `Store.js` 中 `SHEET_DEFS` 为基准。运行 `setupSheets()` 是幂等的：创建缺表并补列，不删除现有数据。生产数据迁移前应备份工作簿。

## 8. 安全与运维

- API Key 仅存储在 Apps Script Script Properties，不进入代码仓库或前端。
- 可通过 `ALLOWED_EMAIL_DOMAIN` 脚本属性限制访问域名；未设置时不启用域名过滤。
- 写操作 URL 使用 `WRITE_TOKEN` 脚本属性保护；不得使用空 token。
- `.clasp.json` 只保留在本地，不提交版本库；不得分享 `.clasprc.json`。
- 不执行未经明确批准的 clasp push、部署、GitHub push 或线上数据清空。

## 9. 验收标准

- Review Search 为产品详情页第一个默认 Tab；查询能按产品范围返回真实评论。
- 查询中的电池续航与连接问题可分别匹配；同时命中多个主题的评论排名更高。
- 真实命中词高亮，来源链接可追溯，空结果不会虚构数据。
- 产品类别字典覆盖上述品类；新产品可加入规格任务队列。
- 规格任务支持失败状态、退避重试和状态查看；失败不会清空旧规格。
- 文档自动处理有文件指纹、进度、错误和续跑状态。
- 产品/Topic/事件/用户需求和证据关联可追溯。
- 本地语法和单元测试通过后，仍需在实际 GAS/Sheets 授权环境做端到端测试。
