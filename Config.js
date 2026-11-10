/* ============================================================
 * Config.gs — 全自动 · 累计模式配置
 * ============================================================ */
const CONFIG = {
  SPREADSHEET_ID: '1ShGmouKISx7AL3CwlYxOqJB9MkcNcHo0o33XyCQMlc8',

  /* --- AI 提供方 ---
   * 密钥只存放在 Script Properties：
   *   GEMINI_API_KEY / OPENROUTER_API_KEY
   * 默认按 AI_PROVIDER_ORDER 依次尝试；Gemini 额度用尽时会自动回退到 OpenRouter。
   * 可用 Script Property AI_PROVIDER_ORDER 覆盖顺序，例如 "openrouter,gemini"。 */
  GEMINI_MODEL: 'gemini-3.1-flash-lite',
  GEMINI_BASE: 'https://generativelanguage.googleapis.com/v1beta/models/',
  // 可用 Script Property OPENROUTER_MODEL 覆盖主模型（不改代码即可换模型）。
  // openrouter/free：Free Models Router，按请求所需能力（含 structured outputs）自动路由到可用免费模型。
  OPENROUTER_MODEL: 'openrouter/free',
  // 主路由失效时按顺序换下一个；仅使用 :free 模型，避免回退到付费模型产生费用。
  OPENROUTER_FALLBACK_MODELS: ['nvidia/nemotron-3.5-super-vl:free', 'minimax/minimax-m3.1-flash:free'],
  OPENROUTER_BASE: 'https://openrouter.ai/api/v1/chat/completions',
  // OpenRouter（nemotron-3.5-super-vl）优先，失败/限流时回退 Gemini。
  // 可用 Script Property AI_PROVIDER_ORDER 调整，例如 'openrouter' 或 'gemini,openrouter'。
  AI_PROVIDER_ORDER: ['openrouter', 'gemini'],

  /* --- 输出上限 ---
   * PASS_A 抽取的 JSON 很容易撞上限而被截断。分块后 16384 足够；
   * 可用 Script Property AI_MAX_OUTPUT_TOKENS 覆盖。 */
  AI_MAX_OUTPUT_TOKENS: 32768,

  /* --- 思考预算 ---
   * Gemini 3 的 maxOutputTokens 是「思考 + 正文」合并上限，默认思考会挤掉 JSON 输出。
   * 抽取类任务用最低档（minimal / low）；可用 Script Property AI_THINKING_LEVEL 覆盖。 */
  AI_THINKING_LEVEL: 'low',

  /* --- Drive 监控源 --- */
  // 方式 A:监控一个文件夹,每周把报告丢进去即可
  DRIVE_FOLDER_ID: '1R6MNwUCn0_C7NurzLmwNUErfCkbI203r',
  // 方式 B:监控指定文件(已预填你当前这期;可放多个)
  DRIVE_EXTRA_FILE_IDS: ['16Q4lV3kDVst1fXW1xAf2VCIol9Z9i_Hq'],

  /* --- 自动同步 --- */
  AUTO_SYNC_HOURS: 6,        // 触发器间隔(小时)
  CACHE_SECONDS: 3600,

  /* --- 产品官网 URL 核验 ---
   * 每个有效产品都必须能溯源到匹配的官网产品页；无法溯源/不匹配的产品默认隔离
   * （status=quarantined），不删除；如需级联删除须显式传 quarantineOnly:false。
   * 网络/HTTP 临时失败只标记 check_failed，下一轮重试。 */
  PRODUCT_URL_VERIFY_MAX_PER_RUN: 10,   // 每轮最多核验多少个产品
  PRODUCT_URL_VERIFY_REFRESH_DAYS: 7,   // 已核验 URL 多少天后重新核验

  /* --- V2.1 P0：URL 验证任务队列 --- */
  URL_VERIFY_TASKS_PER_RUN: 3,          // 每轮最多执行多少个验证任务
  URL_VERIFY_TASK_MAX_ATTEMPTS: 3,      // 单任务最多尝试次数

  /* --- V2.1 P0：文档处理与分块 ---
   * DOCS_PER_RUN 控制单轮处理多少个文档单元；DOC_RUN_BUDGET_MS 是主动停止阈值，
   * 小于 Apps Script 的 6 分钟上限，给回写和续跑留余量。 */
  DOCS_PER_RUN: 2,
  DOC_RUN_BUDGET_MS: 240000,
  SEGMENTER_VERSION: 'v2',
  SEGMENT_TARGET_CHARS: 4500,
  SEGMENT_MAX_CHARS: 6000,
  SEGMENT_TARGET_TOKENS: 2200,
  SEGMENT_MAX_TOKENS: 3000,
  SEGMENT_OVERLAP_CHARS: 120,

  /* --- V2.1 P0：端到端验证入口限额 --- */
  FULL_PIPELINE_MAX_SEGMENTS: 3,
  FULL_PIPELINE_MAX_PRODUCTS: 3,
  FULL_PIPELINE_MAX_SPECS: 2,

  /* --- 默认时间窗 ---
   * 0  = 累计全部历史数据(Top N = 历史提及最多的 N 个) ← 默认
   * 30 = 最近 30 天窗口(按 Documents.published_at 过滤) */
  DEFAULT_DAYS: 0,

  /* --- 品牌归一 --- */
  BRAND_SYNONYMS: {
    '罗技': 'Logitech',
    '罗技G': 'Logitech',
    '雷蛇': 'Razer',
    '赛睿': 'SteelSeries',
    '海盗船': 'Corsair',
    '华硕': 'ASUS',
    '玩家国度': 'ROG',
    '败家之眼': 'ROG',
    '索尼': 'Sony',
    '微软': 'Microsoft',
    '苹果': 'Apple',
    '三星': 'Samsung',
    '森海塞尔': 'Sennheiser',
    '拜雅': 'Beyerdynamic',
    '漫步者': 'Edifier',
  },
};

function scriptProperty_(key) {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
  } catch (e) {
    return '';
  }
}

function getApiKey_() {
  return scriptProperty_('GEMINI_API_KEY');
}

function getOpenRouterKey_() {
  return scriptProperty_('OPENROUTER_API_KEY');
}

/** 是否配置了 Gemini / OpenRouter 任一密钥。 */
function hasConfiguredAIKey_() {
  return !!(getApiKey_() || getOpenRouterKey_());
}

/** 兼容旧调用：只判断 Gemini。 */
function hasConfiguredGeminiKey_() {
  return !!getApiKey_();
}

/** 只有配置了 WRITE_TOKEN 才允许外部写操作；未配置时明确拒绝。 */
function assertWriteToken_(token) {
  const expected = scriptProperty_('WRITE_TOKEN');
  if (!expected) throw new Error('WRITE_TOKEN 未配置，外部写操作已禁用');
  if (String(token || '') !== expected) throw new Error('invalid token');
}

/** 可选的域名白名单。未设置 ALLOWED_EMAIL_DOMAIN 时不启用域名过滤。 */
function assertAllowedUser_(requireUser) {
  const domain = scriptProperty_('ALLOWED_EMAIL_DOMAIN').replace(/^@/, '').toLowerCase();
  let email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').trim();
  } catch (e) {
    email = '';
  }
  if (domain) {
    if (!email) throw new Error('需要登录 Google 账号后访问');
    const actual = email.split('@').pop().toLowerCase();
    if (actual !== domain) throw new Error('当前账号无权访问');
  }
  if (requireUser && !email) throw new Error('写操作需要登录 Google 账号');
  return email;
}
