/* ============================================================
 * Crawl4AI.js — 官方页面规格爬虫（Crawl4AI Cloud /extract）
 *
 * 接入点：SpecificationTasks.extractOfficialSpecs_() 在
 * activeSpecCrawler_() === 'crawl4ai' 时走这里。输出结构与本地
 * UrlFetch 路径完全一致（{name, brand, model, specs[], source_url,
 * fetched_at}），saveOfficialSpecs_() 无需任何改动。
 *
 * Crawl4AI 自带 LLM 抽取，因此不需要再调 Gemini；它同时能渲染
 * 需要 JS 执行的官网页面，这是 UrlFetch 路径抓不到的部分。
 *
 * Script Properties：
 *   CRAWL4AI_API_KEY   必填（启用后）
 *   SPEC_CRAWLER       auto（默认）| crawl4ai | urlfetch
 *   CRAWL4AI_BASE      可选，覆盖 API 基址（自建实例用）
 * ============================================================ */

var C4AI_DEFAULT_BASE_ = 'https://api.crawl4ai.com';
var C4AI_MAX_ATTEMPTS_ = 3;      // 429/503/5xx 与超时重试；402 不重试
var C4AI_TIMEOUT_MS_ = 40000;    // Apps Script 单次请求上限约 50s，留余量

function crawl4aiApiKey_() {
  return scriptProperty_('CRAWL4AI_API_KEY');
}

/**
 * 当前生效的规格页面抓取器。
 * auto：配了 CRAWL4AI_API_KEY 就用 Crawl4AI，否则回落到 UrlFetch。
 */
function activeSpecCrawler_() {
  var pref = String(
    scriptProperty_('SPEC_CRAWLER') ||
    (typeof CONFIG !== 'undefined' && CONFIG.SPEC_CRAWLER) ||
    'auto'
  ).toLowerCase();
  var hasKey = !!crawl4aiApiKey_();
  if (pref === 'urlfetch') return 'urlfetch';
  if (pref === 'crawl4ai') {
    if (!hasKey) throw new Error('SPEC_CRAWLER=crawl4ai 但未配置 CRAWL4AI_API_KEY');
    return 'crawl4ai';
  }
  return hasKey ? 'crawl4ai' : 'urlfetch';
}

/** 写 ProductSpecificationsRaw 时记录的解析器名，用于溯源。 */
function specParserName_() {
  return activeSpecCrawler_() === 'crawl4ai' ? 'crawl4ai_extract_v1' : 'official_page_ai_parser_v1';
}

/* ---------- Cloud /extract 客户端 ---------- */

/**
 * 调用 Crawl4AI Cloud /extract：instruction 描述抽取规则，schema 约束输出。
 * 返回解析后的对象；失败抛出带 HTTP 状态的错误，便于任务队列记录 last_error。
 */
function crawl4aiExtract_(url, instruction, schema) {
  var apiKey = crawl4aiApiKey_();
  if (!apiKey) throw new Error('缺少 Script Property: CRAWL4AI_API_KEY');
  var base = String(scriptProperty_('CRAWL4AI_BASE') || C4AI_DEFAULT_BASE_).replace(/\/+$/, '');
  var body = { url: url, instruction: instruction, schema: schema };

  for (var attempt = 1; attempt <= C4AI_MAX_ATTEMPTS_; attempt++) {
    var response;
    try {
      response = UrlFetchApp.fetch(base + '/extract', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + apiKey },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
        timeout: C4AI_TIMEOUT_MS_
      });
    } catch (e) {
      // 渲染型页面容易超时，重试一次即可，避免整个队列卡在 6 分钟上限上。
      if (attempt < C4AI_MAX_ATTEMPTS_) { Utilities.sleep(4000 * attempt); continue; }
      throw new Error('Crawl4AI 请求超时或网络错误（已重试 ' + C4AI_MAX_ATTEMPTS_ + ' 次）：' + (e && e.message ? e.message : e));
    }

    var status = response.getResponseCode();
    var text = response.getContentText();
    if (status >= 200 && status < 300) {
      var parsed;
      try { parsed = JSON.parse(text); }
      catch (parseError) { throw new Error('Crawl4AI 返回非 JSON：' + String(text).slice(0, 200)); }
      return unwrapC4Payload_(parsed);
    }
    if (status === 402) throw new Error('Crawl4AI 余额不足：' + String(text).slice(0, 200));
    // 429 限流：社区免费档 10 req/60s，响应带 retry_after_s，按提示等待后重试。
    if (status === 429 && attempt < C4AI_MAX_ATTEMPTS_) {
      var waitS = 5;
      try { var body429 = JSON.parse(text); if (body429.retry_after_s) waitS = Math.max(1, Number(body429.retry_after_s)); } catch (e429) {}
      Utilities.sleep(Math.min(30, waitS) * 1000);
      continue;
    }
    // 5xx / 503 busy 不计费，可安全重试
    if (attempt < C4AI_MAX_ATTEMPTS_ && (status === 503 || status >= 500)) {
      Utilities.sleep(4000 * attempt);
      continue;
    }
    throw new Error('Crawl4AI HTTP ' + status + '：' + String(text).slice(0, 200));
  }
}

/** /extract 的返回结构有几种历史形态，统一取出对象本体。 */
function unwrapC4Payload_(payload) {
  var candidates = [
    payload && payload.result,
    payload && payload.extracted,
    payload && payload.extracted_content,
    payload && payload.data,
    payload
  ];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (!c) continue;
    if (typeof c === 'string') {
      try { return JSON.parse(c); } catch (e) { continue; }
    }
    if (typeof c === 'object') {
      if (Array.isArray(c)) { if (c.length) return c[0]; continue; }
      if ('page_match' in c || 'specs' in c) return c;
      // 有些实现把抽取结果再包一层 data
      if (c.data && typeof c.data === 'object') return c.data;
      return c;
    }
  }
  throw new Error('Crawl4AI 返回结构无法识别：' + String(JSON.stringify(payload)).slice(0, 200));
}

/* ---------- 页面渲染（URL 核验用） ---------- */

/** 核验链路是否可以用 Crawl4AI 兜底渲染。 */
function crawl4aiCanRender_() {
  try { return activeSpecCrawler_() === 'crawl4ai'; } catch (e) { return false; }
}

function c4aiRenderSchema_() {
  return {
    type: 'object',
    properties: {
      page_title: { type: ['string', 'null'] },
      page_h1: { type: ['string', 'null'] },
      product_name_on_page: { type: ['string', 'null'] },
      page_excerpt: { type: ['string', 'null'] }
    },
    required: ['page_title']
  };
}

function c4aiPageInstruction_(productName, url) {
  return 'Open this page in a real browser and report what it actually renders. '
    + 'Copy text VERBATIM from the page: do not translate, summarize, rewrite or infer. '
    + 'page_title = the browser tab title. page_h1 = the main heading, or null. '
    + 'product_name_on_page = the full product name shown on the page (brand + model), or null if the page is not a single product detail page. '
    + 'page_excerpt = up to 1500 characters of visible text copied from the top of the page and from the specification / tech-specs section, verbatim. '
    + 'If the page is empty, blocked or asks for a captcha, set page_title to null. '
    + 'Product we are checking: ' + productName + '. Source URL: ' + url;
}

/**
 * 用 Crawl4AI 渲染页面并取回标题/主标题/产品名/正文片段。
 * 返回结构故意与 extractPageIdentity_() 对齐：strongText + fullText，
 * 让 URL 核验继续用确定性匹配，不把真伪判断交给模型。
 */
function crawl4aiRenderPage_(url, productName) {
  var payload = crawl4aiExtract_(url, c4aiPageInstruction_(productName, url), c4aiRenderSchema_());
  var title = String(payload.page_title || '').trim();
  if (!title) throw new Error('Crawl4AI 未能渲染出页面内容（可能是反爬或需要验证码）');
  var strongText = [title, payload.page_h1 || '', payload.product_name_on_page || ''].join(' | ');
  return {
    title: title,
    strongText: strongText,
    fullText: String(payload.page_excerpt || ''),
    product_name_on_page: String(payload.product_name_on_page || '')
  };
}

/**
 * 搜索引擎抓取失败时的 Crawl4AI 兜底：渲染搜索结果页并取回链接。
 * 只返回通过域名白名单的 URL，不做任何推断。
 */
function crawl4aiDiscoverOfficialUrls_(query) {
  var searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  var schema = {
    type: 'object',
    properties: {
      links: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: ['string', 'null'] }
          },
          required: ['url']
        }
      }
    },
    required: ['links']
  };
  var instruction = 'Render this search results page and list ONLY the organic result links it actually shows. '
    + 'Copy each href exactly as displayed, do not invent or guess URLs. Return up to 10 links in page order.';
  var payload = crawl4aiExtract_(searchUrl, instruction, schema);
  var links = Array.isArray(payload.links) ? payload.links : [];
  var out = [], seen = {};
  links.forEach(function(l) {
    var target = String((l && l.url) || '').replace(/&amp;/g, '&').split('#')[0].trim();
    if (!/^https?:\/\//i.test(target)) return;
    if (!isAllowedOfficialProductUrl_(target)) return;
    if (seen[target]) return;
    seen[target] = 1;
    out.push(target);
  });
  return out.slice(0, 10);
}

/* ---------- 规格提取 ---------- */

/** 统一字段目录（与 SpecificationTasks.SPEC_DEFINITION_SEEDS_ 对齐，含耳机类字段）。 */
var C4AI_SPEC_KEYS_ = [
  'weight_g', 'length_mm', 'width_mm', 'height_mm',
  'connectivity', 'wireless_protocol', 'bluetooth_version', 'battery_life_hours',
  'sensor', 'max_dpi', 'max_polling_rate_hz', 'buttons', 'switch_type', 'switch_lifecycle',
  'onboard_memory', 'software_requirement', 'layout', 'compatibility', 'msrp',
  'battery_life_listening_hours', 'battery_life_talk_hours', 'driver',
  'frequency_response_mic', 'sensitivity_db', 'microphone', 'charging'
];

function c4aiSpecSchema_() {
  return {
    type: 'object',
    properties: {
      page_match: { type: 'boolean' },
      product_name: { type: ['string', 'null'] },
      brand: { type: ['string', 'null'] },
      model: { type: ['string', 'null'] },
      specs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            spec_key: { type: 'string' },
            spec_label: { type: ['string', 'null'] },
            value: { type: ['string', 'number', 'null'] },
            unit: { type: ['string', 'null'] },
            raw_value: { type: ['string', 'null'] }
          },
          required: ['spec_key', 'value']
        }
      }
    },
    required: ['page_match', 'specs']
  };
}

function c4aiInstruction_(productName, url) {
  return 'First verify: does this page show the product "' + productName + '"? '
    + 'Set page_match=false if it is a different model, a homepage, a series/listing page, or an accessory page. '
    + 'If page_match is true, extract ONLY this product\'s declared specifications from the specification / tech-specs '
    + 'section. Ignore marketing copy, review quotes, comparison tables and recommended products. '
    + 'Never use memory or guess: if a value is not explicitly on the page, omit it. '
    + 'Strip units from the number and put the unit in "unit" ("54 g" -> value 54, unit "g"; "4,000 DPI" -> value 4000, unit "DPI"). '
    + 'Keep the original text in raw_value. '
    + 'Preferred spec_key values: ' + C4AI_SPEC_KEYS_.join(', ') + '. '
    + 'Weight in g, dimensions in mm, battery life in hours; keep the currency for price. '
    + 'Source URL: ' + url;
}

/** 兜底：部分模型会返回扁平对象（weight_g: 54）而不是 specs 数组。 */
function c4aiFlatToSpecs_(obj) {
  var meta = { page_match: 1, product_name: 1, brand: 1, model: 1, specs: 1 };
  var specs = [];
  Object.keys(obj || {}).forEach(function(k) {
    if (meta[k]) return;
    var v = obj[k];
    if (v === null || v === undefined || v === '') return;
    if (typeof v === 'object') return;
    specs.push({ spec_key: k, spec_label: k, value: String(v), unit: '', raw_value: String(v) });
  });
  return specs;
}

/**
 * 用 Crawl4AI 抽取单个产品的官方规格。
 * 输出与 extractOfficialSpecsViaFetch_ 一致，可直接交给 saveOfficialSpecs_()。
 */
function extractSpecsViaCrawl4AI_(productName, url) {
  if (!isAllowedOfficialProductUrl_(url)) throw new Error('不是允许访问的品牌官网：' + url);
  var payload = crawl4aiExtract_(url, c4aiInstruction_(productName, url), c4aiSpecSchema_());
  if (payload && String(payload.page_match).toLowerCase() === 'false') {
    throw new Error('页面与产品不匹配（Crawl4AI page_match=false）：' + url);
  }
  var raw = Array.isArray(payload.specs) ? payload.specs : c4aiFlatToSpecs_(payload);
  var specs = raw
    .filter(function(s) { return s && s.spec_key && String(s.value == null ? '' : s.value).trim() !== ''; })
    .map(function(s) {
      var value = String(s.value);
      return {
        spec_key: String(s.spec_key).trim(),
        spec_label: String(s.spec_label || s.spec_key).trim(),
        value: value,
        unit: String(s.unit || '').trim(),
        raw_value: String(s.raw_value || (s.unit ? value + ' ' + s.unit : value))
      };
    });
  return {
    name: String(payload.product_name || productName),
    brand: String(payload.brand || ''),
    model: String(payload.model || ''),
    official_url: url,
    source_url: url,
    specs: specs,
    fetched_at: new Date().toISOString(),
    crawler: 'crawl4ai',
    verification_status: 'ai_extracted_unverified'
  };
}
