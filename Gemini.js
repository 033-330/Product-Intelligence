/* ============================================================
 * Gemini.gs — Gemini API 调用 + 三段 Prompt/Schema
 *   Pass 0:整期报告 → 拆分 Documents(Gemini 自动分段)
 *   Pass A:单 Document → 结构化抽取
 *   Resolve:产品实体消重
 * ============================================================ */

/**
 * 统一 AI 入口：按 AI_PROVIDER_ORDER 依次尝试 Gemini / OpenRouter。
 * Gemini 额度用尽、限流或不可用时自动回退到 OpenRouter。
 *
 * @param {string} prompt   提示词
 * @param {object} [schema] responseSchema(传入则要求 JSON 输出)
 * @param {object} [opts]   { maxTokens, provider }
 */
/** 最近一次 AI 调用的诊断信息：提供方 / 模型 / finishReason / token 用量。 */
var LAST_AI_DIAG_ = null;
function getLastAiDiag_() { return LAST_AI_DIAG_; }

/**
 * 思考预算配置。Gemini 3 系列的 maxOutputTokens 是「思考 + 正文」合并上限，
 * 默认思考会吃掉输出额度导致 JSON 被截断，所以抽取类调用把思考压到最低。
 * Gemini 2.5 用 thinkingBudget（0 = 关闭）。
 */
function geminiThinkingConfig_(model) {
  const name = String(model || '');
  const level = String(scriptProperty_('AI_THINKING_LEVEL') || CONFIG.AI_THINKING_LEVEL || 'low').toLowerCase();
  if (/gemini-3/i.test(name)) return { thinkingLevel: level };
  if (/gemini-2\.5/i.test(name)) return { thinkingBudget: 0 };
  return null;
}

function callAI(prompt, schema, opts) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('callAI: prompt 为空。请通过业务入口调用，不要在编辑器中直接运行。');
  }
  opts = opts || {};
  let order = opts.provider ? [String(opts.provider).toLowerCase()] : aiProviderOrder_();
  const errors = [];
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    if (!aiProviderKey_(provider)) {
      errors.push(provider + ': 未配置 API Key');
      continue;
    }
    try {
      return provider === 'gemini'
        ? callGeminiProvider_(prompt, schema, opts)
        : callOpenRouterProvider_(prompt, schema, opts);
    } catch (e) {
      errors.push(provider + ': ' + String(e.message || e).slice(0, 300));
      Logger.log('AI provider 失败，尝试下一个：' + provider + ' — ' + String(e));
    }
  }
  throw new Error('所有 AI 提供方均失败：' + errors.join(' | '));
}

function aiProviderOrder_() {
  const raw = scriptProperty_('AI_PROVIDER_ORDER')
    || (CONFIG.AI_PROVIDER_ORDER || []).join(',');
  const seen = {};
  const out = [];
  String(raw).split(',').forEach(function(name) {
    const p = String(name || '').trim().toLowerCase();
    if (['gemini', 'openrouter'].indexOf(p) >= 0 && !seen[p]) {
      seen[p] = true;
      out.push(p);
    }
  });
  return out.length ? out : ['gemini', 'openrouter'];
}

function aiProviderKey_(provider) {
  if (provider === 'gemini') return getApiKey_();
  if (provider === 'openrouter') return getOpenRouterKey_();
  return '';
}

/** 直接调用 Gemini（不作为统一入口的默认路径）。 */
function callGemini(prompt, schema, opts) {
  return callGeminiProvider_(prompt, schema, opts);
}

function callGeminiProvider_(prompt, schema, opts) {
  const key = getApiKey_();
  if (!key) throw new Error('缺少 GEMINI_API_KEY，请在 Script Properties 中配置');
  const model = String(CONFIG.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();
  const url = String(CONFIG.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/')
    + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: (opts && opts.maxTokens) || Number(CONFIG.AI_MAX_OUTPUT_TOKENS) || 8192,
    },
  };
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }
  const thinking = geminiThinkingConfig_(model);
  if (thinking) body.generationConfig.thinkingConfig = thinking;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      const text = res.getContentText();
      // 模型/接口不认 thinkingConfig 时就去掉它重试，不要因一个可选参数拖垮整条链路。
      if (code === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(text)) {
        Logger.log('Gemini 不接受 thinkingConfig，已去掉该参数重试：' + text.slice(0, 160));
        delete body.generationConfig.thinkingConfig;
        attempt--;
        continue;
      }
      if (code >= 200 && code < 300) {
        const json = JSON.parse(text);
        const parts = json && json.candidates && json.candidates[0]
          && json.candidates[0].content && json.candidates[0].content.parts;
        if (!parts || !parts.length) {
          throw new Error('Gemini 返回空内容：' + text.slice(0, 300));
        }
        const out = parts.map(function(p) { return p.text || ''; }).join('\n');
        if (!schema) return out;
        const finish = (json.candidates[0] && json.candidates[0].finishReason) || '';
        const usage = json.usageMetadata || {};
        LAST_AI_DIAG_ = {
          provider: 'gemini', model: model, finishReason: finish,
          thoughts: usage.thoughtsTokenCount || 0,
          outputTokens: usage.candidatesTokenCount || 0,
          inputTokens: usage.promptTokenCount || 0,
          truncated: false
        };
        try {
          return extractJson_(out);
        } catch (parseError) {
          // 输出撞上 maxOutputTokens 时 JSON 会被切断：抢救已完整的条目，不要让整份文档失败。
          if (finish === 'MAX_TOKENS' || /JSON 不完整/.test(String(parseError.message))) {
            const salvaged = repairTruncatedJson_(out);
            LAST_AI_DIAG_.truncated = true;
            Logger.log('Gemini 输出被截断（finishReason=' + finish + '，思考 ' + LAST_AI_DIAG_.thoughts + ' tokens），已保留完整条目');
            return salvaged;
          }
          throw parseError;
        }
      }
      lastErr = new Error('Gemini HTTP ' + code + ': ' + text.slice(0, 400));
      if (code !== 429 && code < 500) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (e.message && /HTTP 4\d\d/.test(e.message) && !/HTTP 429/.test(e.message)) throw e;
    }
    if (attempt < 2) Utilities.sleep(1200 * (attempt + 1));
  }
  throw lastErr || new Error('Gemini 请求失败');
}

/** OpenRouter：把 schema 注入提示词并要求 JSON 输出，返回值与 Gemini 分支保持一致。 */
function callOpenRouterProvider_(prompt, schema, opts) {
  if (!schema) return callOpenRouter(prompt, opts).text;
  const jsonPrompt = [
    prompt,
    '',
    '只输出一个合法的 JSON 对象，不要输出 Markdown 代码块或解释文字。',
    '必须符合以下 JSON Schema：',
    JSON.stringify(schema),
  ].join('\n');
  const requestOpts = {};
  Object.keys(opts || {}).forEach(function(k) { requestOpts[k] = opts[k]; });
  requestOpts.jsonSchema = schema;
  // 抽取类任务不需要推理；推理模型默认会把思考算进 completion_tokens 吃掉输出额度。
  if (requestOpts.minimalReasoning === undefined) requestOpts.minimalReasoning = true;
  const result = callOpenRouter(jsonPrompt, requestOpts);
  LAST_AI_DIAG_ = {
    provider: 'openrouter', model: result.actualModel || result.requestedModel || '',
    finishReason: result.finishReason || '',
    thoughts: 0,
    outputTokens: (result.usage && result.usage.completion_tokens) || 0,
    inputTokens: (result.usage && result.usage.prompt_tokens) || 0,
    truncated: false
  };
  try {
    return extractJson_(result.text);
  } catch (parseError) {
    if (result.finishReason === 'length' || /JSON 不完整/.test(String(parseError.message))) {
      const salvaged = repairTruncatedJson_(result.text);
      LAST_AI_DIAG_.truncated = true;
      Logger.log('OpenRouter 输出被截断（finish_reason=' + result.finishReason + '），已保留完整条目');
      return salvaged;
    }
    throw parseError;
  }
}

/* ============================================================
 * 从任意文本中提取第一个完整 JSON 对象(无 schema 降级模式用)
 * ============================================================ */
function extractJson_(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch (ignore) {}
  const start = s.indexOf('{');
  if (start === -1) throw new Error('输出中无 JSON: ' + s.slice(0, 200));
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return JSON.parse(s.slice(start, i + 1));
      }
    }
  }
  throw new Error('JSON 不完整: ' + s.slice(0, 200));
}

/**
 * 抢救被 maxOutputTokens 截断的 JSON：找到最后一个「结构完整的逗号」，
 * 从那里截断并补齐未闭合的括号。只保留确实已经完整输出的条目，不补造内容。
 * 返回的对象带 __truncated=true，调用方可以据此提示「输出被截断」。
 */
function repairTruncatedJson_(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) throw new Error('输出中无 JSON: ' + s.slice(0, 200));
  const src = s.slice(start);
  const stack = [];
  const cuts = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { stack.push('}'); continue; }
    if (c === '[') { stack.push(']'); continue; }
    if (c === '}' || c === ']') {
      stack.pop();
      if (!stack.length) return JSON.parse(src.slice(0, i + 1));
      continue;
    }
    if (c === ',' && stack.length) {
      cuts.push({ idx: i, closers: stack.slice().reverse().join('') });
    }
  }
  for (let k = cuts.length - 1; k >= 0; k--) {
    try {
      const obj = JSON.parse(src.slice(0, cuts[k].idx) + cuts[k].closers);
      if (obj && typeof obj === 'object') {
        obj.__truncated = true;
        return obj;
      }
    } catch (ignore) {}
  }
  throw new Error('模型输出被截断且无法抢救完整条目: ' + src.slice(0, 200));
}

/* ---------- 诊断:验证当前 AI 提供方可用性(运行后看 查看→日志) ---------- */
function testGemini() {
  const results = { provider_order: aiProviderOrder_() };
  try {
    const t = callAI('用一句话回答:1+1等于几?');
    results.plain = 'OK: ' + String(t).slice(0, 60);
  } catch (e) { results.plain = 'FAIL: ' + String(e).slice(0, 200); }
  try {
    const j = callAI('输出 JSON:{"ok":true}', { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } });
    results.schema = 'OK: ' + JSON.stringify(j);
  } catch (e) { results.schema = 'FAIL: ' + String(e).slice(0, 200); }
  Logger.log('AI 提供方顺序: ' + aiProviderOrder_().join(',') + '\n' + JSON.stringify(results, null, 2));
  return results;
}

/* ============================================================
 * Pass A:单 Document → 结构化抽取
 * ============================================================ */

const PASS_A_SCHEMA = {
  type: 'OBJECT',
  properties: {
    products: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name_as_written: { type: 'STRING' },
          canonical_guess: { type: 'STRING' },
          brand_guess:     { type: 'STRING' },
          category_guess:  { type: 'STRING' }, // mouse/keyboard/headset/accessory/unknown
          topics: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name:           { type: 'STRING' },
                topic_summary:  { type: 'STRING' }, // 该话题的内容摘要(2-3句)
                mention_count:  { type: 'INTEGER' },
                count_type:     { type: 'STRING' }, // verbatim / qualitative
                sentiment:      { type: 'STRING' }, // positive / neutral / negative
                evidence:       { type: 'STRING' },
                feedback: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      quote:      { type: 'STRING' },
                      sentiment:  { type: 'STRING' }, // positive / negative / neutral / unknown
                      confidence: { type: 'STRING' }, // high / medium / low
                    },
                  },
                },
              },
              required: ['name'],
            },
          },
          user_needs: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                category:    { type: 'STRING' },
                need_type:   { type: 'STRING' }, // need=诉求/痛点 evaluation=卖点评价
                description: { type: 'STRING' },
                evidence:    { type: 'STRING' },
              },
              required: ['category', 'description', 'evidence'],
            },
          },
          competitor_mentions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name_as_written:  { type: 'STRING' },
                dimensions:       { type: 'ARRAY', items: { type: 'STRING' } },
                competitor_summary:{ type: 'STRING' }, // 本次比较的一句话结论
                stance:           { type: 'STRING' },
                evidence:         { type: 'STRING' },
              },
              required: ['name_as_written', 'dimensions', 'competitor_summary', 'evidence'],
            },
          },
        },
        required: ['name_as_written', 'topics'],
      },
    },
    general_discussion: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          topic:   { type: 'STRING' },
          summary: { type: 'STRING' },
          evidence:{ type: 'STRING' },
        },
      },
    },
  },
  required: ['products'],
};

function buildPassAPrompt_(doc, text) {
  return [
    '你是「产品情报结构化引擎」。输入是一个已拆分的文档单元(来自产品跟踪 Newsletter),请只根据文中实际出现的内容抽取信息,不要补充外部知识。',
    '',
    '【抽取规则】',
    '1. products:文中明确讨论到的每一款产品。name_as_written 必须是文中逐字出现的写法(保留原文大小写与标点,如「PRO X3 SUPERSTRIKE」「GPW5 Ultra」)。canonical_guess 只能基于原文出现的内容做最小整理(去多余空格、统一大小写),禁止用外部知识替换/补全/修正原文产品名,禁止加 (Hypothetical)/(假设)/(推测) 等任何标注后缀;不确定时直接用 name_as_written。brand_guess 用标准品牌名(Logitech/Razer/Sony/Beyerdynamic/PixArt/其他);category_guess 只能取 mouse/keyboard/headset/accessory/unknown。',
    '2. topics:该产品在本文中被讨论的话题。命名要短(不超过12字),聚焦用户讨论点,例如「首发定价争议」「8K续航实测」「电磁微动手感分歧」。 2a. topic_summary:这是网站 Topic 摘要面板的直接数据源,要求像分析师写话题摘要:用 2-3 句中文概括该话题在本文中的讨论全貌,必须覆盖不同立场与分歧(如支持者与反对者、创作者观点与用户反馈的差异)。严禁照抄或轻度改写 evidence 引文——引文只出现在 evidence 字段,摘要里不许出现与引文几乎相同的句子。示例:话题「首发定价争议」合格摘要:「1699 元首发价被不少用户认为偏高;部分用户觉得从前代升级的变化有限,也有人认可微动与重心优化。」不合格摘要:「1699元单鼠标真的很神」——这只是引文复述。 2b. topics 数组必须按「该话题对本文中该产品的讨论重要程度」降序排列(最重要的话题放最前面)。',
    '2c. feedback:该话题在本文中的独立反馈列表(每话题最多 8 条)。每条是一个具体观点/评价/情绪,逐字摘录,逐条判定 sentiment(positive/negative/neutral/unknown——无法判断明确标 unknown,不要硬归 neutral)与置信度 confidence(high/medium/low)。这些用于情绪分布统计:分母只含非 unknown 条目。',
    '3. mention_count:该话题在本文中被明确讨论的段落数,不是关键词字面出现次数,至少为 1。text 是原文逐字摘录,因此 count_type 用 verbatim。',
    '4. sentiment:该话题在本文中的整体情感,只能取 positive / neutral / negative。',
    '5. evidence:必须是 text 中原文的逐字摘录(不超过80字),用于支撑该话题与情感。禁止改写、禁止编造。找不到原文证据的话题不要输出。',
    '6. user_needs:只抽「真正的用户诉求 / 痛点 / 购买顾虑」——用户想要什么、担心什么、什么阻碍了他购买或使用(如:希望降价、预算有限、担心误触、需要更轻、不适应某手感、担心质量)。严格判别:如果一句话是在评价产品现有功能的表现好坏(如「续航实测掉电14%」「手感扎实」「听声辨位准」),这是卖点评价,属于 topics(已带 sentiment),不要放进 user_needs。每条加 need_type:need=诉求;万一抽到卖点评价标 evaluation。',
    '7. competitor_mentions:文中将本产品与其他产品做比较时填写。dimensions 从 [价格,性能,手感,设计,续航,品控,重量,传感器,麦克风,连接] 中选取;competitor_summary 用一句话写清本次比较的结论(如「续航与重量均被质疑,价格更贵」)。被比较的产品即使是竞品品牌也要填写。',
    '8. general_discussion:无法归属到任何具体产品的一般性讨论(行业趋势、技术路线、市场现象、非产品专属话题)。每条必须有原文 evidence;topic 是短标题,summary 用 1-2 句概括。不要硬塞给某个产品。',
    '9. 以【上文衔接，仅供理解，不要重复抽取】开头的内容只作上下文理解,禁止从中抽取产品或反馈。',
    '10. 若全文没有可抽取内容,返回空 products 数组,不要编造。',
    '',
    '【文档信息】',
    '标题:' + doc.title,
    '平台:' + doc.platform,
    '作者:' + (doc.author || ''),
    '',
    '【正文】',
    '<<<TEXT',
    text,
    'TEXT',
  ].join('\n');
}

/* ============================================================
 * Resolve:产品实体消重
 * ============================================================ */

function buildResolvePrompt_(names, aliasRows) {
  const registry = aliasRows
    .map(r => r.product_id + ' | ' + r.alias)
    .join('\n');

  return [
    '你负责产品实体消重和产品官网 URL 核验。',
    '',
    '【一、现有产品库】',
    '以下是产品库中已有的产品及其别名，每行格式为 product_id | 别名：',
    registry || '(空)',
    '',
    '【二、待判断的产品名称】',
    names.map((n, i) => (i + 1) + '. ' + n).join('\n'),
    '',
    '【三、产品实体识别规则】',
    '1. product_id 只能填写现有产品库中真实存在的 ID，或 NEW。',
    '2. 只有在能够确认名称指向同一具体产品时，才允许匹配已有 product_id。',
    '3. 如果型号、代际、品类或产品变体无法确认，一律填 NEW，不得强行合并。',
    '4. 同一产品的缩写、昵称、谐音昵称、不同语言名称可以映射到同一产品，但必须有充分证据。',
    '5. 不得仅凭品牌相同或名称相似就认定为同一产品。',
    '6. 不同代际、不同型号、不同尺寸或不同硬件变体，默认视为不同产品，除非有明确证据证明它们是同一产品的别名。',
    '7. 对于 NEW，填写 canonical_name、brand、category。',
    '8. canonical_name 必须来自原文中逐字出现的产品名写法,只允许做最小整理(去多余空格、统一大小写)。禁止用外部知识替换或"修正"原文产品名(如把「PRO X3 SUPERSTRIKE」改成「Pro X Superlight 3」),禁止加 (Hypothetical)/(假设)/(推测)/(tentative) 等任何标注后缀。无法确定完整型号时,直接用原文写法,不要猜测。',
    '9. category 只能填写 mouse、keyboard、headset、accessory、unknown。',
    '',
    '【四、官网 URL 核验规则】',
    '1. 每个产品都需要单独判断官网 URL 状态，包括匹配已有产品的情况。',
    '2. official_url 必须指向该具体产品的官方产品详情页。',
    '3. 优先使用产品制造商官方网站。品牌首页、分类页、搜索结果页、新闻报道页和第三方电商页面都不能作为已验证的产品详情页。',
    '4. 必须有实际核验依据，确认页面中的产品名称、型号或其他标识与当前产品一致，才能将 url_status 设为 verified。',
    '5. 不得根据产品名称、常见 URL 格式或记忆推测 URL，不得编造网址。',
    '6. 不同型号、代际或硬件变体必须分别核实，不能直接沿用相似产品的 URL。',
    '7. 如果已经实际核验并确认对应官网产品页：填写 official_url，url_status 为 verified，url_product_match 为 true。',
    '8. 如果没有找到可靠的官方产品页：official_url 填空字符串，url_status 为 not_found，url_product_match 为 false。',
    '9. 如果有多个候选页面且无法确定对应关系：official_url 填空字符串，url_status 为 ambiguous，url_product_match 为 false。',
    '10. 如果当前环境无法实际访问或核验网页，不得声称已完成验证。official_url 填空字符串，url_status 为 not_found 或 ambiguous，url_product_match 为 false。',
    '11. url_source 记录实际核验来源或简短依据。没有实际核验依据时填写空字符串。',
    '12. 产品实体识别和 URL 核验是独立判断。确认产品身份不代表 URL 已经验证。',
    '13. 如果匹配已有 product_id，但未核验官网 URL，仍然必须如实返回 URL 核验状态，不得伪造 URL。',
    '',
    '【五、输出要求】',
    '1. 必须为输入中的每一个名称返回一条 mapping，不能遗漏或自行增加名称。',
    '2. name 必须与输入名称完全一致。',
    '3. product_id 为已有产品 ID 或 NEW。',
    '4. 对已有产品，尽可能返回已知的 canonical_name、brand 和 category；无法确认时使用空字符串或 unknown。',
    '5. 对 NEW 产品，如果身份信息不足，保守填写，不得编造型号。',
    '6. 只输出符合 JSON Schema 的 JSON，不要输出 Markdown、解释文字或代码围栏。'
  ].join('\n');
}


const RESOLVE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mapping: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING'
          },
          product_id: {
            type: 'STRING'
          },
          canonical_name: {
            type: 'STRING'
          },
          brand: {
            type: 'STRING'
          },
          category: {
            type: 'STRING',
            enum: [
              'mouse',
              'keyboard',
              'headset',
              'accessory',
              'unknown'
            ]
          },
          official_url: {
            type: 'STRING',
            description: '已核验的官方产品详情页 URL；未核验时为空字符串'
          },
          url_status: {
            type: 'STRING',
            enum: [
              'verified',
              'not_found',
              'ambiguous'
            ]
          },
          url_source: {
            type: 'STRING',
            description: '实际核验的来源或依据；没有则为空字符串'
          },
          url_product_match: {
            type: 'BOOLEAN',
            description: '官网页面是否已核实为当前具体产品'
          }
        },
        required: [
          'name',
          'product_id',
          'canonical_name',
          'brand',
          'category',
          'official_url',
          'url_status',
          'url_source',
          'url_product_match'
        ]
      }
    }
  },
  required: ['mapping']
};

/* ============================================================
 * Resolve Topics:话题实体消重(与产品消重同款逻辑)
 * ============================================================ */

function buildTopicResolvePrompt_(names, topicRows, productName) {
  const registry = topicRows.map(t => t.topic_id + ' | ' + t.name).join('\n');
  return [
    '你在做「话题(Topic)实体消重」。话题是归属于特定产品的:下面的话题都属于产品「' + (productName || '') + '」,只在这个范围内比较(每行格式: topic_id | 话题名):',
    '',
    registry || '(空)',
    '',
    '抽取过程中出现了以下未自动匹配的话题名:',
    names.map((n, i) => (i + 1) + '. ' + n).join('\n'),
    '',
    '请判断每个话题名对应的话题:topic_id 必须是上面列表中出现过的 ID;若是新话题,topic_id 填 NEW。',
    '判断标准:只与上面列出的、同一产品的话题比较;同一讨论主题的不同措辞必须合并(如「8K续航实测争议」与「续航实测与宣传差异」、「OLED屏幕调参」与「OLED小屏幕便捷调参」、「石墨烯大动圈单元音质」与「石墨烯驱动单元音质」);明显不同的主题(如「价格」与「续航」)不要合并。宁可保守,不确定就填 NEW。',
  ].join('\n');
}

const TOPIC_RESOLVE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    mapping: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name:     { type: 'STRING' },
          topic_id: { type: 'STRING' }, // 已有 ID 或 NEW
        },
        required: ['name', 'topic_id'],
      },
    },
  },
  required: ['mapping'],
};


/* ============================================================
 * 话题边界裁决:相似度处于模糊地带(0.55-0.75)时,由 Gemini 做最终判定
 * ============================================================ */

function buildTopicVerifyPrompt_(pairs, productName) {
  return [
    '你在裁决「同一产品下的两个话题是否应该合并」。产品:「' + (productName || '') + '」。',
    '',
    '对每一对,判断话题 A(新出现)与话题 B(已有)是否指同一讨论主题:',
    '- 同一主题的不同措辞、不同侧重、简称/全称 → same: true(如「OLED屏幕调参」与「OLED小屏幕便捷调参」)',
    '- 主题确实不同(即便字面相近)→ same: false(如「价格」与「性价比」一般不同;「外观设计」与「佩戴舒适度」不同)',
    '- 宁可保守:只有较有把握时才 true。',
    '',
    pairs.map((p, i) => (i + 1) + '. A=' + p.name + '  |  B=' + p.candidate_name).join('\n'),
  ].join('\n');
}

const TOPIC_VERIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name:           { type: 'STRING' },  // 话题 A 的名字
          same:           { type: 'BOOLEAN' }, // 是否与候选 B 为同一主题
        },
        required: ['name', 'same'],
      },
    },
  },
  required: ['verdicts'],
};


