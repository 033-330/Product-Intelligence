/* ============================================================
 * ProductUrlVerification.js — 产品官网 URL 核验任务
 *
 * 目标：Products 中每个有效产品都必须能溯源到一个「真实可访问且
 * 页面内容与产品匹配」的品牌官网产品详情页，供后续规格录入使用。
 *
 * 规则：
 *   - 已登记 URL 与搜索结果都会实际抓取核验，不信任 AI 记忆或 URL 猜测；
 *   - 页面 <title>/<h1>/og:title 或正文必须包含产品型号，避免系列页/列表页；
 *   - 无 URL、URL 页面不匹配 → 默认只隔离（status=quarantined），不删除；
 *     仅当显式传入 { deleteInvalid: true, quarantineOnly: false } 时才级联删除；
 *   - 网络超时、403/429/5xx 等暂时失败 → 标记 check_failed，保留待重试。
 * ============================================================ */

var PRODUCT_URL_FETCH_UA_ = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

var PRODUCT_IDENTITY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    official_names: { type: 'ARRAY', items: { type: 'STRING' } },
    aliases: { type: 'ARRAY', items: { type: 'STRING' } },
    model_codes: { type: 'ARRAY', items: { type: 'STRING' } },
    brand_domains: { type: 'ARRAY', items: { type: 'STRING' } },
    search_queries: { type: 'ARRAY', items: { type: 'STRING' } },
    confidence: { type: 'STRING' },
    notes: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['official_names', 'search_queries', 'brand_domains']
};

var URL_NON_OFFICIAL_HOSTS_ = [
  'google.com', 'bing.com', 'duckduckgo.com', 'baidu.com', 'sogou.com', 'yandex.com',
  'amazon.com', 'amazon.co.uk', 'ebay.com', 'aliexpress.com', 'alibaba.com', 'taobao.com',
  'jd.com', 'tmall.com', 'youtube.com', 'reddit.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'wikipedia.org', 'zhihu.com', 'bilibili.com'
];

function asStringArray_(value, limit) {
  var raw = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  var out = [], seen = {};
  for (var i = 0; i < raw.length && out.length < (limit || 8); i++) {
    var s = String(raw[i] == null ? '' : raw[i]).trim().replace(/[\r\n]+/g, ' ');
    if (s.length < 2 || s.length > 120) continue;
    var key = normalizeAlias(s);
    if (!key || seen[key]) continue;
    seen[key] = 1;
    out.push(s);
  }
  return out;
}

function identityCacheKey_(product) {
  return 'url_identity:' + normalizeAlias(
    String(product.brand || '') + ' ' + String(product.canonical_name || ''));
}

function fallbackProductIdentity_(product, note) {
  var name = String(product.canonical_name || '');
  var brand = String(product.brand || '');
  var out = {
    official_names: [], aliases: [], model_codes: [],
    brand_domains: detectBrandDomains_(brand + ' ' + name),
    search_queries: [brand + ' ' + name].filter(function(q) { return q.trim().length > 1; }),
    confidence: 'low', notes: [], source: 'fallback'
  };
  if (note) out.notes.push(String(note).slice(0, 160));
  return out;
}

function buildIdentityPrompt_(product) {
  var brand = String(product.brand || '');
  var name = String(product.canonical_name || '');
  return [
    '你是产品身份解析助手。输入的名称可能来自新闻/论坛，常用缩写、昵称或中文简称，不一定是官方产品名。',
    '请基于输入推断最可能的官方产品名、型号码、品牌官网主域名和多条搜索词，帮助后续抓取官网页面验证。',
    '严格规则：不要输出任何 URL；不要输出电商/搜索引擎/百科域名；不确定的型号也要给候选并降低 confidence；候选项必须能在后续官网页面抓取中被验证。',
    'official_names 给 1-4 个最可能的官方全名；aliases 给 1-6 个常见缩写/简称；model_codes 给型号或代号；brand_domains 只给主域名（如 logitechg.com、razer.com）；search_queries 给 2-5 条搜索词，优先“品牌 + 官方名/型号”，不要加 buy。',
    '',
    '品牌: ' + brand,
    '名称: ' + name,
    '分类: ' + String(product.category || '')
  ].join('\n');
}

function resolveProductIdentity_(product, deadlineMs) {
  var enabled = String(
    scriptProperty_('PRODUCT_IDENTITY_ENABLED')
    || (typeof CONFIG !== 'undefined' && CONFIG.PRODUCT_IDENTITY_ENABLED !== false ? '1' : '0')
  ).toLowerCase();
  if (enabled === '0' || enabled === 'false') return fallbackProductIdentity_(product);
  if (typeof hasConfiguredAIKey_ === 'function' && !hasConfiguredAIKey_()) {
    return fallbackProductIdentity_(product);
  }

  var cacheKey = identityCacheKey_(product);
  var cached = cacheGet_(cacheKey);
  if (cached && cached.search_queries && cached.search_queries.length) return cached;

  var remaining = Number(deadlineMs) ? Number(deadlineMs) - Date.now() : 60000;
  if (remaining < 45000) return fallbackProductIdentity_(product, '时间不足，跳过 AI 身份解析');

  var timeoutMs = Math.max(5000, Math.min(
    Number(CONFIG.PRODUCT_IDENTITY_TIMEOUT_MS) || 20000,
    remaining - 40000
  ));
  try {
    var raw = callAI(buildIdentityPrompt_(product), PRODUCT_IDENTITY_SCHEMA, {
      maxTokens: 1024,
      timeoutMs: timeoutMs
    }) || {};
    var fallback = fallbackProductIdentity_(product);
    var out = {
      official_names: asStringArray_(raw.official_names, 4),
      aliases: asStringArray_(raw.aliases, 6),
      model_codes: asStringArray_(raw.model_codes, 5),
      brand_domains: asStringArray_(raw.brand_domains, 5).filter(function(d) {
        return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(d);
      }),
      search_queries: asStringArray_(raw.search_queries, 5),
      confidence: String(raw.confidence || 'medium').slice(0, 20),
      notes: asStringArray_(raw.notes, 3),
      source: 'ai'
    };
    if (!out.search_queries.length) out.search_queries = fallback.search_queries;
    if (!out.brand_domains.length) out.brand_domains = fallback.brand_domains;
    cachePut_(cacheKey, out);
    return out;
  } catch (e) {
    return fallbackProductIdentity_(product, 'AI 身份解析失败: ' + String(e && e.message ? e.message : e));
  }
}

function identityOfficialNames_(identity, product) {
  var out = [];
  [identity.official_names, identity.aliases, identity.model_codes,
    [product.canonical_name || '']].forEach(function(arr) {
    (arr || []).forEach(function(s) {
      var v = String(s || '').trim();
      if (v.length >= 3) out.push(v);
    });
  });
  var seen = {};
  return out.filter(function(s) {
    var k = normalizeAlias(s);
    if (!k || seen[k]) return false;
    seen[k] = 1;
    return true;
  }).slice(0, 12);
}

function identityQueries_(identity, product) {
  var brand = String(product.brand || '');
  var name = String(product.canonical_name || '');
  var official = (identity.official_names || [])[0] || name;
  var model = (identity.model_codes || [])[0] || '';
  var out = (identity.search_queries || []).slice();
  out.push(brand + ' ' + name);
  out.push(brand + ' ' + official);
  if (model) out.push(brand + ' ' + model);
  var seen = {};
  return out.map(function(s) {
    return String(s || '').replace(/["'\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }).filter(function(s) {
    if (s.length < 3) return false;
    var k = normalizeAlias(s);
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  }).slice(0, 5);
}

function identityDomains_(identity, product) {
  var out = (identity.brand_domains || []).slice();
  if (typeof detectBrandDomains_ === 'function') {
    detectBrandDomains_(String(product.brand || '') + ' ' + String(product.canonical_name || ''))
      .forEach(function(d) { out.push(d); });
  }
  var seen = {};
  return out.map(function(d) { return String(d || '').toLowerCase().replace(/^www\./, '').trim(); })
    .filter(function(d) {
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d)) return false;
      if (seen[d]) return false;
      seen[d] = 1;
      return true;
    }).slice(0, 6);
}

function isCandidateUrlAllowed_(url, domains) {
  if (isAllowedOfficialProductUrl_(url)) return true;
  var m = String(url || '').match(/^https?:\/\/([^\/:?#]+)/i);
  if (!m) return false;
  var host = m[1].toLowerCase().replace(/^www\./, '');
  for (var i = 0; i < URL_NON_OFFICIAL_HOSTS_.length; i++) {
    var bad = URL_NON_OFFICIAL_HOSTS_[i];
    if (host === bad || host.slice(-(bad.length + 1)) === '.' + bad) return false;
  }
  for (var j = 0; j < (domains || []).length; j++) {
    var d = String(domains[j] || '').toLowerCase();
    if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
  }
  return false;
}

function saveProductIdentity_(product, identity) {
  try {
    var official = (identity.official_names || [])[0] || '';
    updateProductUrlFields_(product.product_id, {
      official_name: official,
      identity_source: identity.source || '',
      identity_checked_at: new Date().toISOString()
    });
    var aliases = (identity.official_names || []).concat(
      identity.aliases || [], identity.model_codes || []);
    aliases.forEach(function(a) {
      var s = String(a || '').trim();
      if (s.length >= 3 && s.length <= 80) addAlias_(s, product.product_id);
    });
  } catch (e) {
    Logger.log('回写产品官方名失败：' + String(e && e.message ? e.message : e));
  }
}

function isProductUrlVerified_(product) {
  return !!product
    && String(product.official_url || '').trim() !== ''
    && String(product.official_url_status || '').toLowerCase() === 'verified';
}

function escapeRegExp_(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlText_(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBrandFromProductName_(name, brand) {
  var original = String(name || '').trim();
  var b = String(brand || '').trim();
  if (!b) return original;
  var stripped = original.replace(new RegExp('^\\s*' + escapeRegExp_(b) + '[\\s\\-:|/]+', 'i'), '').trim();
  return stripped || original;
}

function productModelTokens_(name) {
  var generic = {
    the: 1, for: 1, with: 1, and: 1, series: 1, edition: 1,
    wired: 1, wireless: 1, gaming: 1, game: 1, mouse: 1, mice: 1,
    keyboard: 1, headset: 1, headphones: 1, earbuds: 1, speaker: 1,
    microphone: 1, camera: 1, webcam: 1, accessory: 1, accessories: 1
  };
  return String(name || '').split(/[^A-Za-z0-9\u4e00-\u9fff]+/)
    .filter(function(t) { return t && t.length >= 2 && !generic[t.toLowerCase()]; });
}

/**
 * 纯函数：判断官网页面文本是否确实对应目标产品。
 * strongText 为 <title>/<h1>/og:title，fullText 为去标签后的正文。
 */
function productPageMatches_(canonicalName, brand, strongText, fullText) {
  var name = String(canonicalName || '').trim();
  if (!name) return false;

  var model = stripBrandFromProductName_(name, brand);
  var modelNorm = normalizeAlias(model);
  var fullNorm = normalizeAlias(name);
  var strongNorm = normalizeAlias(strongText);
  var bodyNorm = normalizeAlias(fullText);

  if (!modelNorm && !fullNorm) return false;

  if (strongNorm && modelNorm.length >= 3 && strongNorm.indexOf(modelNorm) >= 0) return true;
  if (strongNorm && fullNorm.length >= 4 && strongNorm.indexOf(fullNorm) >= 0) return true;
  if (bodyNorm && modelNorm.length >= 6 && bodyNorm.indexOf(modelNorm) >= 0) return true;

  var tokens = productModelTokens_(model || name);
  if (tokens.length && strongNorm) {
    var hits = 0, distinctive = 0;
    tokens.forEach(function(t) {
      var n = normalizeAlias(t);
      if (n.length >= 2 && strongNorm.indexOf(n) >= 0) hits++;
      if (t.length >= 4) distinctive++;
    });
    if (hits === tokens.length) return true;
    if (tokens.length >= 2 && hits / tokens.length >= 0.75 && distinctive > 0) return true;
  }
  return false;
}

function collectProductJsonLd_(node, identifiers, texts) {
  if (!node || identifiers.length >= 40) return;
  if (Array.isArray(node)) {
    node.forEach(function(x) { collectProductJsonLd_(x, identifiers, texts); });
    return;
  }
  if (typeof node !== 'object') return;
  var keys = ['name', 'sku', 'mpn', 'model', 'productID', 'identifier', 'gtin13', 'gtin'];
  keys.forEach(function(k) {
    var v = node[k];
    if (typeof v !== 'string' && typeof v !== 'number') return;
    var s = String(v).trim();
    if (!s || s.length > 200) return;
    identifiers.push(s);
    if (['name', 'sku', 'mpn', 'model', 'productID'].indexOf(k) >= 0) texts.push(s);
  });
  Object.keys(node).forEach(function(k) {
    if (k.charAt(0) === '@' && k !== '@graph') return;
    if (node[k] && typeof node[k] === 'object') collectProductJsonLd_(node[k], identifiers, texts);
  });
}

function extractPageIdentity_(html) {
  var src = String(html || '');
  var titleMatch = src.match(/<title[^>]*>([\s\S]{0,500}?)<\/title>/i);
  var title = titleMatch ? titleMatch[1] : '';

  var h1s = [];
  var h1Re = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/gi, hm;
  while ((hm = h1Re.exec(src)) !== null && h1s.length < 3) h1s.push(hm[1]);

  var metas = [];
  var metaRe = /<meta\b[^>]*>/gi, mm;
  while ((mm = metaRe.exec(src)) !== null && metas.length < 10) {
    var tag = mm[0];
    if (/property\s*=\s*["']og:title["']/i.test(tag) || /name\s*=\s*["'](?:twitter:)?title["']/i.test(tag)) {
      var content = tag.match(/content\s*=\s*["']([^"']*)["']/i);
      if (content) metas.push(content[1]);
    }
  }

  var canonical = '';
  var linkRe = /<link\b[^>]*>/gi, lm;
  while ((lm = linkRe.exec(src)) !== null) {
    if (!/rel\s*=\s*["']canonical["']/i.test(lm[0])) continue;
    var href = lm[0].match(/href\s*=\s*["']([^"']+)["']/i);
    if (href) canonical = href[1];
    break;
  }

  var identifiers = [], jsonldTexts = [];
  var ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, ldm;
  while ((ldm = ldRe.exec(src)) !== null && identifiers.length < 40) {
    var raw = String(ldm[1] || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    try { collectProductJsonLd_(JSON.parse(raw), identifiers, jsonldTexts); }
    catch (e1) {
      try { collectProductJsonLd_(JSON.parse(raw.replace(/[\r\n\t]+/g, ' ')), identifiers, jsonldTexts); }
      catch (e2) {}
    }
  }

  var bodyHtml = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  return {
    title: decodeHtmlText_(title),
    strongText: decodeHtmlText_([title].concat(h1s, metas, jsonldTexts).join(' | ')),
    fullText: decodeHtmlText_(bodyHtml).slice(0, 120000),
    canonical: canonical,
    identifiers: identifiers.slice(0, 40),
    jsonldText: jsonldTexts.join(' | ')
  };
}

function productPageMatchesMulti_(product, page, officialNames) {
  var strong = String(page.strongText || '');
  var body = String(page.fullText || '');
  if (productPageMatches_(product.canonical_name, product.brand, strong, body)) return true;
  var names = officialNames || [];
  for (var i = 0; i < names.length; i++) {
    if (productPageMatches_(names[i], product.brand, strong, body)) return true;
  }
  var ids = (page.identifiers || []).map(function(s) { return normalizeAlias(s); }).filter(Boolean);
  var tokens = [];
  names.concat([product.canonical_name || '']).forEach(function(n) {
    var stripped = stripBrandFromProductName_(n, product.brand);
    productModelTokens_(stripped).forEach(function(t) {
      if (t.length >= 4) tokens.push(normalizeAlias(t));
    });
  });
  var seen = {};
  for (var j = 0; j < tokens.length; j++) {
    var t = tokens[j];
    if (!t || t.length < 4 || seen[t]) continue;
    seen[t] = 1;
    for (var k = 0; k < ids.length; k++) {
      if (ids[k] === t || ids[k].indexOf(t) >= 0) return true;
    }
  }
  return false;
}

function fetchOfficialProductPage_(url) {
  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': PRODUCT_URL_FETCH_UA_,
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
    }
  });
  var code = response.getResponseCode();
  var html = (code >= 200 && code < 300) ? String(response.getContentText() || '').slice(0, 300000) : '';
  return { code: code, html: html };
}

function fetchOfficialProductPages_(urls, deadlineMs) {
  var out = {};
  var list = [];
  var seen = {};
  (urls || []).forEach(function(u) {
    var url = String(u || '').trim();
    if (!url || seen[url]) return;
    seen[url] = 1;
    list.push(url);
  });
  var batchSize = Math.max(1, Number(CONFIG.PRODUCT_URL_FETCH_BATCH_SIZE) || 8);
  for (var start = 0; start < list.length; start += batchSize) {
    var batch = list.slice(start, start + batchSize);
    if (deadlineMs && Date.now() + 15000 > Number(deadlineMs)) {
      batch.forEach(function(url) { out[url] = { code: 0, html: '', error: 'budget' }; });
      continue;
    }
    try {
      var requests = batch.map(function(url) {
        return {
          url: url,
          muteHttpExceptions: true,
          followRedirects: true,
          headers: {
            'User-Agent': PRODUCT_URL_FETCH_UA_,
            'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
          }
        };
      });
      var responses = UrlFetchApp.fetchAll(requests);
      responses.forEach(function(response, i) {
        var code = response.getResponseCode();
        out[batch[i]] = {
          code: code,
          html: (code >= 200 && code < 300)
            ? String(response.getContentText() || '').slice(0, 300000) : ''
        };
      });
    } catch (e) {
      batch.forEach(function(url) {
        try { out[url] = fetchOfficialProductPage_(url); }
        catch (e2) { out[url] = { code: 0, html: '', error: String(e2).slice(0, 120) }; }
      });
    }
  }
  return out;
}

/**
 * UrlFetch 抓不到有效内容时的 Crawl4AI 兜底。
 * 只负责取回渲染后的文本，是否匹配仍由 productPageMatches_ 确定性判断。
 * 返回 null 表示未取得可匹配内容；失败原因写入 noteOut。
 */
function tryRenderedMatch_(url, product, reason, noteOut, deadlineMs, allowRender) {
  if (allowRender === false) return { status: 'disabled' };
  if (!crawl4aiCanRender_()) return { status: 'disabled' };
  if (deadlineMs && Date.now() + 45000 > Number(deadlineMs)) {
    noteOut.push('渲染跳过(剩余时间不足): ' + url.slice(0, 140));
    return { status: 'error' };
  }
  var rendered;
  try {
    rendered = crawl4aiRenderPage_(url, String(product.brand || '') + ' ' + String(product.canonical_name || ''), deadlineMs);
  } catch (e) {
    // 渲染器自己挂了（配额/超时/反爬）不等于页面不匹配，不能当成硬失败。
    noteOut.push('渲染失败(' + reason + '): ' + url.slice(0, 140) + ' | ' + String(e && e.message ? e.message : e).slice(0, 120));
    return { status: 'error' };
  }
  if (!productPageMatches_(product.canonical_name, product.brand, rendered.strongText, rendered.fullText)) {
    noteOut.push('渲染页面仍不匹配(' + reason + '): ' + url.slice(0, 140) + ' | ' + String(rendered.title || '').slice(0, 100));
    return { status: 'no_match' };
  }
  return { status: 'matched', code: 200, title: rendered.title, via: 'crawl4ai' };
}

function inspectOfficialProductUrl_(url, product, deadlineMs, prefetched, officialNames, allowRender) {
  var renderNotes = [];
  var page;
  try {
    page = prefetched || fetchOfficialProductPage_(url);
    if (prefetched && prefetched.error === 'budget') {
      return { status: 'fetch_error', code: 0, message: '预算不足', render_notes: renderNotes };
    }
  } catch (e) {
    // 网络层失败：可能是反爬或需要 JS 渲染，交给 Crawl4AI 再试一次。
    var renderedOnError = tryRenderedMatch_(url, product, '网络错误', renderNotes, deadlineMs, allowRender);
    if (renderedOnError.status === 'matched') return renderedOnError;
    return { status: 'fetch_error', code: 0, message: String(e).slice(0, 200), render_notes: renderNotes };
  }

  var code = page.code;
  if (code >= 200 && code < 300) {
    var identity = extractPageIdentity_(page.html);
    if (productPageMatchesMulti_(product, identity, officialNames)) {
      return { status: 'matched', code: code, title: identity.title, via: 'urlfetch' };
    }
    // 2xx 但不含型号：多半是 JS 渲染的空壳页（SPA 官网），用 Crawl4AI 渲染后再判。
    var rendered = tryRenderedMatch_(url, product, '空壳页', renderNotes, deadlineMs, allowRender);
    if (rendered.status === 'matched') return rendered;
    if (rendered.status === 'error') {
      // 页面确实是空壳，但渲染器没成功：无法下结论，保留待重试，不要隔离。
      return { status: 'fetch_error', code: code, message: '空壳页且渲染失败', render_notes: renderNotes };
    }
    return { status: 'mismatch', code: code, title: identity.title, render_notes: renderNotes };
  }

  if (code === 404 || code === 410) {
    return { status: 'invalid_http', code: code, message: 'HTTP ' + code };
  }
  // 403/405/429/5xx：反爬或暂时失败，Crawl4AI 有独立出口，值得再试一次。
  var renderedBlocked = tryRenderedMatch_(url, product, 'HTTP ' + code, renderNotes, deadlineMs, allowRender);
  if (renderedBlocked.status === 'matched') return renderedBlocked;
  return { status: 'fetch_error', code: code, message: 'HTTP ' + code, render_notes: renderNotes };
}

/**
 * 核验单个产品。返回 { status, url, checked_at, notes }。
 * status: verified / not_found / mismatch / check_failed
 */
function verifyProductUrl_(product, deadlineMs) {
  product = product || {};
  var deadline = Number(deadlineMs) || 0;
  function outOfBudget(minMs) {
    return deadline > 0 && Date.now() + (minMs || 15000) > deadline;
  }
  var checkedAt = new Date().toISOString();
  var brand = String(product.brand || '');
  var name = String(product.canonical_name || '');
  var existing = String(product.official_url || '').trim();
  var identity = resolveProductIdentity_(product, deadline);
  var officialNames = identityOfficialNames_(identity, product);
  var queries = identityQueries_(identity, product);
  var domains = identityDomains_(identity, product);
  var notes = (identity.notes || []).slice(0, 2);
  if (identity.source === 'ai') {
    notes.push('AI 官方名候选：' + (identity.official_names || []).slice(0, 3).join(' / '));
  }
  var hardInvalid = false;
  var transient = false;
  var candidates = [], seen = {};

  function addCandidate(url) {
    var u = String(url || '').trim();
    if (!u || seen[u]) return;
    if (!isCandidateUrlAllowed_(u, domains)) {
      notes.push('非品牌官网域名: ' + u.slice(0, 160));
      hardInvalid = true;
      return;
    }
    seen[u] = 1;
    candidates.push(u);
  }

  function scoreCandidate(url, via) {
    var path = String(url || '').split('://').pop().split('/').slice(1).join('/').toLowerCase();
    var n = 0;
    if (/product|products|shop\/p\/|\/p\/|gaming|mouse|keyboard|headset|spec/.test(path)) n += 3;
    if (/support|search|category|accessories/.test(path)) n -= 2;
    if (domains.some(function(d) { return String(url).toLowerCase().indexOf('://' + d) >= 0
      || String(url).toLowerCase().indexOf('://www.' + d) >= 0; })) n += 2;
    if (via === 'crawl4ai') n += 1;
    return n;
  }

  addCandidate(existing);
  if (outOfBudget(30000)) {
    transient = true;
    notes.push('核验时间不足，已跳过官网搜索');
  } else {
    queries.forEach(function(q) {
      try {
        searchOfficialProductCandidates_(q, deadline, { queries: [q], domains: domains })
          .forEach(addCandidate);
      } catch (e) {
        transient = true;
        notes.push('官网搜索失败: ' + String(e).slice(0, 120));
      }
    });
  }
  candidates = candidates.slice(0, 8);
  if (!candidates.length) {
    return {
      status: transient ? 'check_failed' : 'not_found',
      url: '', checked_at: checkedAt, candidates: [],
      notes: notes.join('；').slice(0, 900)
    };
  }

  var pages = fetchOfficialProductPages_(candidates, deadline);
  var matches = [], renderQueue = [];
  candidates.forEach(function(url) {
    var page = pages[url] || { code: 0, html: '' };
    var result = inspectOfficialProductUrl_(url, product, deadline, page, officialNames, false);
    if (result.status === 'matched') {
      matches.push({
        url: url, title: String(result.title || '').slice(0, 200),
        via: result.via || 'urlfetch', score: scoreCandidate(url, result.via)
      });
    } else if (result.status === 'mismatch') {
      hardInvalid = true;
      notes.push('页面与产品不匹配: ' + url.slice(0, 160) + ' | ' + String(result.title || '').slice(0, 100));
      renderQueue.push({ url: url, score: scoreCandidate(url, '') });
    } else if (result.status === 'invalid_http') {
      hardInvalid = true;
      notes.push('页面已失效(' + result.code + '): ' + url.slice(0, 160));
    } else {
      transient = true;
      notes.push('暂时无法抓取(' + (result.code || 'net') + '): ' + url.slice(0, 160));
      renderQueue.push({ url: url, score: scoreCandidate(url, '') });
    }
  });

  renderQueue.sort(function(a, b) { return b.score - a.score; });
  renderQueue.slice(0, 2).forEach(function(item) {
    if (outOfBudget(45000)) return;
    var result = inspectOfficialProductUrl_(item.url, product, deadline, null, officialNames, true);
    if (result.status === 'matched') {
      matches.push({
        url: item.url, title: String(result.title || '').slice(0, 200),
        via: result.via || 'crawl4ai', score: scoreCandidate(item.url, result.via) + 1
      });
    }
  });

  matches.sort(function(a, b) { return b.score - a.score; });
  if (matches.length === 1) {
    var hit = matches[0];
    saveProductIdentity_(product, identity);
    return {
      status: 'verified', url: hit.url, checked_at: checkedAt,
      via: hit.via, candidates: matches.slice(0, 5),
      notes: notes.concat(['页面标题: ' + hit.title]).join('；').slice(0, 900)
    };
  }
  if (matches.length > 1) {
    var candidateUrls = matches.slice(0, 5).map(function(m) { return m.url; });
    try {
      enqueuePending_('url_ambiguous', {
        product_id: product.product_id, canonical_name: name, brand: brand,
        official_name: (identity.official_names || [])[0] || '',
        candidates: candidateUrls
      }, '多个官网页面匹配，需人工确认');
    } catch (e) { notes.push('人工复核入队失败: ' + String(e).slice(0, 120)); }
    return {
      status: 'ambiguous', url: '', checked_at: checkedAt, candidates: candidateUrls,
      notes: notes.concat(['多个候选匹配: ' + candidateUrls.join(' | ')]).join('；').slice(0, 900)
    };
  }

  var status = hardInvalid ? 'mismatch' : (transient ? 'check_failed' : 'not_found');
  return {
    status: status,
    url: status === 'check_failed' ? existing : '',
    checked_at: checkedAt,
    candidates: [],
    notes: notes.join('；').slice(0, 900)
  };
}

function updateProductUrlFields_(productId, fields) {
  var sh = sheet_('Products');
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return false;

  var headers = vals[0].map(function(h) { return String(h == null ? '' : h).trim(); });
  var ix = {};
  headers.forEach(function(h, i) { ix[h] = i; });
  if (ix.product_id == null) return false;

  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][ix.product_id] || '').trim() !== String(productId || '').trim()) continue;
    Object.keys(fields).forEach(function(key) {
      if (ix[key] == null) {
        ix[key] = headers.length;
        headers.push(key);
        sh.getRange(1, ix[key] + 1).setValue(key);
      }
      var value = fields[key];
      sh.getRange(r + 1, ix[key] + 1).setValue(value === undefined || value === null ? '' : value);
    });
    return true;
  }
  return false;
}

/**
 * 物理删除产品并级联清理所有指向它的关联行。
 * 删除前把原因写入 PendingQueue，保留可追溯的审计记录。
 */
function deleteProductsCascade_(productIds, infoById) {
  var idSet = {};
  (productIds || []).forEach(function(id) {
    var v = String(id || '').trim();
    if (v) idSet[v] = 1;
  });
  var ids = Object.keys(idSet);
  if (!ids.length) return { deleted: [], removed_rows: {} };

  var info = infoById || {};
  ids.forEach(function(id) {
    var item = info[id] || {};
    try {
      enqueuePending_('product_deleted_url_invalid', {
        product_id: id,
        canonical_name: item.name || '',
        brand: item.brand || '',
        url_status: item.status || '',
        reason: item.notes || ''
      }, '产品无法溯源到匹配的官网 URL，已删除');
    } catch (e) {
      Logger.log('记录产品删除原因失败：' + String(e));
    }
  });

  var refs = [
    ['ProductAliases', ['product_id']],
    ['Feedback', ['product_id']],
    ['UserNeeds', ['product_id']],
    ['Topics', ['product_id']],
    ['Events', ['product_id']],
    ['Competitors', ['product_id', 'competitor_id']],
    ['PageTopics', ['product_id']],
    ['PageCompetitors', ['product_id', 'competitor_id']],
    ['ProductSpecifications', ['product_id']],
    ['ProductSpecificationsRaw', ['product_id']],
    ['ProductComponents', ['bundle_product_id', 'component_product_id']],
    ['SpecificationTasks', ['product_id']]
  ];

  var removed = {};
  refs.forEach(function(spec) {
    var tableName = spec[0], cols = spec[1];
    var rows;
    try { rows = readTable(tableName); } catch (e) { return; }
    var kept = rows.filter(function(row) {
      return !cols.some(function(col) { return idSet[String(row[col] || '').trim()]; });
    });
    var count = rows.length - kept.length;
    if (count > 0) {
      rewriteTable_(tableName, kept);
      removed[tableName] = count;
    }
  });

  var products = readTable('Products');
  var keptProducts = products.filter(function(p) { return !idSet[String(p.product_id || '').trim()]; });
  var productCount = products.length - keptProducts.length;
  if (productCount > 0) {
    rewriteTable_('Products', keptProducts);
    removed.Products = productCount;
  }

  clearCache();
  return { deleted: ids, removed_rows: removed };
}

/**
 * 批量核验任务。默认只处理到期产品；无法溯源/不匹配的产品先隔离（quarantined），不再直接级联删除。
 * options: { limit, ids, force, deleteInvalid, quarantineOnly }
 */
function verifyProductUrls_(options) {
  options = options || {};
  var limit = Math.max(1, Math.min(100,
    Number(options.limit) || Number(CONFIG.PRODUCT_URL_VERIFY_MAX_PER_RUN) || 20));
  var deleteInvalid = options.deleteInvalid === true;
  var quarantineOnly = options.quarantineOnly !== false;
  var force = !!options.force;
  var idFilter = null;
  if (options.ids) {
    idFilter = {};
    String(options.ids).split(',').forEach(function(id) {
      var v = String(id || '').trim();
      if (v) idFilter[v] = 1;
    });
  }
  var refreshMs = (Number(CONFIG.PRODUCT_URL_VERIFY_REFRESH_DAYS) || 7) * 86400000;
  var now = Date.now();
  var perProductMs = Math.max(30000,
    Number(options.per_product_ms) || Number(CONFIG.PRODUCT_URL_VERIFY_PER_PRODUCT_MS) || 70000);
  var overallDeadline = Number(options.deadline_ms) || 0;

  var products = readTable('Products').filter(function(p) {
    var status = String(p.status || '').toLowerCase();
    var category = String(p.category || '').toLowerCase();
    if (status === 'merged' || category === 'brand') return false;
    if (status === 'quarantined') {
      if (idFilter) return !!idFilter[String(p.product_id || '').trim()];
      if (force) return true;
      return false;
    }
    if (idFilter) return !!idFilter[String(p.product_id || '').trim()];
    if (force) return true;
    if (isProductUrlVerified_(p)) {
      var checked = p.official_url_checked_at ? new Date(p.official_url_checked_at).getTime() : 0;
      return !checked || isNaN(checked) || (now - checked) >= refreshMs;
    }
    return true;
  }).slice(0, limit);

  var results = [];
  var deleteIds = [];
  var deleteInfo = {};
  var quarantinedCount = 0;

  products.forEach(function(p) {
    var outcome;
    if (overallDeadline && Date.now() >= overallDeadline) {
      results.push({ product_id: p.product_id, status: 'skipped_budget' });
      return;
    }
    var productDeadline = Date.now() + perProductMs;
    if (overallDeadline) productDeadline = Math.min(productDeadline, overallDeadline);
    try {
      outcome = verifyProductUrl_(p, productDeadline);
    } catch (e) {
      outcome = {
        status: 'check_failed',
        url: String(p.official_url || '').trim(),
        checked_at: new Date().toISOString(),
        notes: '核验异常: ' + String(e).slice(0, 300)
      };
    }

    if (outcome.status === 'verified') {
      updateProductUrlFields_(p.product_id, {
        official_url: outcome.url,
        official_url_status: outcome.status,
        official_url_checked_at: outcome.checked_at,
        official_url_notes: outcome.notes || ''
      });
      try {
        var sh = sheet_('Products');
        var vals = sh.getDataRange().getValues();
        if (vals.length > 1) {
          var headers = vals[0].map(function(h) { return String(h == null ? '' : h).trim(); });
          var ix = {}; headers.forEach(function(h,i){ ix[h]=i; });
          if (ix.product_id != null && ix.status != null) {
            for (var r=1;r<vals.length;r++) {
              if (String(vals[r][ix.product_id] || '').trim() === String(p.product_id || '').trim()) {
                var cur = String(vals[r][ix.status] || '').toLowerCase();
                if (cur === 'quarantined') sh.getRange(r+1, ix.status+1).setValue('active');
                break;
              }
            }
          }
        }
      } catch(e2) {}
    } else if (outcome.status === 'ambiguous') {
      updateProductUrlFields_(p.product_id, {
        official_url: '',
        official_url_status: 'ambiguous',
        official_url_checked_at: outcome.checked_at,
        official_url_notes: outcome.notes || ''
      });
    } else if (outcome.status === 'check_failed') {
      updateProductUrlFields_(p.product_id, {
        official_url: String(p.official_url || '').trim(),
        official_url_status: outcome.status,
        official_url_checked_at: outcome.checked_at,
        official_url_notes: outcome.notes || ''
      });
    } else if (outcome.status === 'not_found' || outcome.status === 'mismatch') {
      updateProductUrlFields_(p.product_id, {
        official_url: '',
        official_url_status: outcome.status,
        official_url_checked_at: outcome.checked_at,
        official_url_notes: outcome.notes || ''
      });
      try {
        var sh2 = sheet_('Products');
        var vals2 = sh2.getDataRange().getValues();
        if (vals2.length > 1) {
          var headers2 = vals2[0].map(function(h) { return String(h == null ? '' : h).trim(); });
          var ix2 = {}; headers2.forEach(function(h,i){ ix2[h]=i; });
          if (ix2.product_id != null && ix2.status != null) {
            for (var r2=1;r2<vals2.length;r2++) {
              if (String(vals2[r2][ix2.product_id] || '').trim() === String(p.product_id || '').trim()) {
                var cur2 = String(vals2[r2][ix2.status] || '').toLowerCase();
                if (cur2 !== 'merged' && cur2 !== 'brand') {
                  sh2.getRange(r2+1, ix2.status+1).setValue('quarantined');
                  quarantinedCount++;
                }
                break;
              }
            }
          }
        }
      } catch(e3) {}
      try {
        enqueuePending_('product_quarantined_url_invalid', {
          product_id: p.product_id,
          canonical_name: p.canonical_name,
          brand: p.brand,
          url_status: outcome.status,
          reason: outcome.notes || ''
        }, '产品无法溯源到匹配的官网详情页，已隔离（暂不删除）');
      } catch(e4) {}
      if (deleteInvalid && !quarantineOnly) {
        deleteIds.push(p.product_id);
        deleteInfo[p.product_id] = {
          name: p.canonical_name,
          brand: p.brand,
          status: outcome.status,
          notes: outcome.notes || ''
        };
      }
    }

    results.push({
      product_id: p.product_id,
      name: p.canonical_name,
      status: outcome.status === 'not_found' || outcome.status === 'mismatch' ? 'quarantined' : outcome.status,
      url: outcome.url || '',
      notes: outcome.notes || ''
    });
  });

  var deletion = (deleteInvalid && !quarantineOnly && deleteIds.length) ? deleteProductsCascade_(deleteIds, deleteInfo) : { deleted: [], removed_rows: {} };
  clearCache();
  return {
    checked: products.length,
    verified: results.filter(function(r) { return r.status === 'verified'; }).length,
    retained_for_retry: results.filter(function(r) { return r.status === 'check_failed'; }).length,
    quarantined: quarantinedCount,
    deleted: deletion.deleted,
    removed_rows: deletion.removed_rows,
    results: results,
    deleteInvalid: deleteInvalid,
    quarantineOnly: quarantineOnly
  };
}

/** P0-1：产品的 URL 验证任务入队（同产品已有活跃任务时不重复创建）。 */
function enqueueUrlVerificationTask_(productId, url, priority) {
  var pid = String(productId || '').trim();
  if (!pid) return null;
  try {
    if (!sheet_('UrlVerificationTasks')) return null;
  } catch (e) {
    return null;
  }
  var tasks = readTable('UrlVerificationTasks');
  var active = tasks.some(function(t) {
    return String(t.product_id) === pid
      && ['queued', 'running', 'retry'].indexOf(String(t.status)) >= 0;
  });
  if (active) return null;

  var taskId = nextId('UVT', 'UrlVerificationTasks', 'task_id');
  var now = new Date().toISOString();
  appendRow('UrlVerificationTasks', {
    task_id: taskId,
    product_id: pid,
    url: String(url || ''),
    status: 'queued',
    priority: Number(priority) || 3,
    attempt_count: 0,
    max_attempts: Number(CONFIG.URL_VERIFY_TASK_MAX_ATTEMPTS) || 3,
    next_attempt_at: now,
    created_at: now,
    started_at: '',
    finished_at: '',
    last_error: '',
    result: '',
    notes: 'created_by_pipeline',
    checked_at: ''
  });
  return taskId;
}

/** P0-1：异步验证 Worker；逐条复用 verifyProductUrls_ 的判定与回写逻辑。 */
function processUrlVerificationTasks_(limit) {
  limit = Math.max(1, Math.min(10,
    Number(limit) || Number(CONFIG.URL_VERIFY_TASKS_PER_RUN) || 3));
  try {
    if (!sheet_('UrlVerificationTasks')) return { processed: 0, results: [] };
  } catch (e) {
    return { processed: 0, results: [] };
  }

  var now = Date.now();
  var tasks = readTable('UrlVerificationTasks').filter(function(t) {
    var status = String(t.status || '');
    if (['queued', 'retry'].indexOf(status) < 0) return false;
    var next = t.next_attempt_at ? new Date(t.next_attempt_at).getTime() : 0;
    return !next || isNaN(next) || next <= now;
  }).sort(function(a, b) {
    return Number(b.priority || 0) - Number(a.priority || 0)
      || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  }).slice(0, limit);

  var results = [];
  var sh = sheet_('UrlVerificationTasks');
  var values = sh.getDataRange().getValues();
  var headers = values[0].map(function(h) { return String(h == null ? '' : h).trim(); });
  var ix = {};
  headers.forEach(function(h, i) { ix[h] = i; });

  function updateRow(taskId, updates) {
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][ix.task_id] || '').trim() !== String(taskId)) continue;
      Object.keys(updates).forEach(function(k) {
        if (ix[k] != null) sh.getRange(r + 1, ix[k] + 1).setValue(updates[k]);
      });
      return;
    }
  }

  tasks.forEach(function(t) {
    var taskId = String(t.task_id || '');
    var pid = String(t.product_id || '');
    var attempts = Number(t.attempt_count || 0) + 1;
    var maxAttempts = Number(t.max_attempts || CONFIG.URL_VERIFY_TASK_MAX_ATTEMPTS || 3);
    updateRow(taskId, {
      status: 'running', attempt_count: attempts,
      started_at: new Date().toISOString(), last_error: ''
    });

    try {
      var productMs = Number(CONFIG.PRODUCT_URL_VERIFY_PER_PRODUCT_MS) || 70000;
      verifyProductUrls_({
        ids: pid, force: true, limit: 1, deleteInvalid: false, quarantineOnly: true,
        deadline_ms: Date.now() + productMs, per_product_ms: productMs
      });
      var product = readTable('Products').filter(function(p) {
        return String(p.product_id) === pid;
      })[0] || {};
      var st = String(product.official_url_status || '').toLowerCase();
      var checkedAt = String(product.official_url_checked_at || new Date().toISOString());
      var notes = String(product.official_url_notes || '');

      if (st === 'verified') {
        updateRow(taskId, {
          status: 'done', finished_at: new Date().toISOString(), checked_at: checkedAt,
          url: String(product.official_url || t.url || ''), result: 'verified',
          notes: notes.slice(0, 500), last_error: ''
        });
        results.push({ task_id: taskId, product_id: pid, status: 'verified' });
        return;
      }

      if (st === 'check_failed') {
        var giveUp = attempts >= maxAttempts;
        updateRow(taskId, {
          status: giveUp ? 'failed' : 'retry',
          next_attempt_at: giveUp ? '' : new Date(Date.now() + Math.min(24, Math.pow(2, attempts)) * 3600000).toISOString(),
          finished_at: giveUp ? new Date().toISOString() : '',
          checked_at: checkedAt, result: 'check_failed',
          notes: notes.slice(0, 500), last_error: notes.slice(0, 500)
        });
        results.push({ task_id: taskId, product_id: pid, status: giveUp ? 'failed' : 'retry' });
        return;
      }

      updateRow(taskId, {
        status: 'failed', finished_at: new Date().toISOString(), checked_at: checkedAt,
        result: st || 'not_found', notes: notes.slice(0, 500),
        last_error: notes.slice(0, 500)
      });
      results.push({ task_id: taskId, product_id: pid, status: 'failed', reason: st });
    } catch (e) {
      var msg = String(e && e.message ? e.message : e).slice(0, 500);
      var last = attempts >= maxAttempts;
      updateRow(taskId, {
        status: last ? 'failed' : 'retry',
        next_attempt_at: last ? '' : new Date(Date.now() + Math.min(24, Math.pow(2, attempts)) * 3600000).toISOString(),
        finished_at: last ? new Date().toISOString() : '',
        last_error: msg, notes: msg
      });
      results.push({ task_id: taskId, product_id: pid, status: last ? 'failed' : 'retry', error: msg });
    }
  });

  clearCache();
  return { processed: results.length, results: results };
}

/** 供触发器/编辑器直接运行。先消化验证任务队列，队列为空时才批量扫描。 */
function runProductUrlVerification(limit) {
  var taskResult = { processed: 0, results: [] };
  try {
    taskResult = processUrlVerificationTasks_(CONFIG.URL_VERIFY_TASKS_PER_RUN);
  } catch (e) {
    Logger.log('URL 验证任务队列执行失败：' + String(e));
  }

  // 队列已消耗本轮额度时不再批量扫描，避免 Crawl4AI 429。
  var scanLimit = taskResult.processed > 0
    ? 0
    : (limit || Number(CONFIG.PRODUCT_URL_VERIFY_MAX_PER_RUN) || 20);
  var scanResult = scanLimit > 0
    ? verifyProductUrls_({ limit: scanLimit, deleteInvalid: false, quarantineOnly: true })
    : { checked: 0, results: [] };

  return { tasks: taskResult, scan: scanResult };
}

/** 幂等安装：已存在同名触发器时不重复创建。 */
function installProductUrlVerifyTrigger_() {
  return ensureProductUrlVerifyTrigger_();
}

function isProductUrlVerifyTriggerInstalled_() {
  return ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'runProductUrlVerification';
  });
}

function ensureProductUrlVerifyTrigger_() {
  if (isProductUrlVerifyTriggerInstalled_()) {
    return 'URL 核验触发器已存在（每 6 小时运行），未重复创建。';
  }
  ScriptApp.newTrigger('runProductUrlVerification').timeBased().everyHours(6).create();
  return '已安装 URL 核验触发器：每 6 小时运行一次。';
}

/** 规格采集前确保 URL 已通过实时核验。 */
function ensureVerifiedProductUrl_(product) {
  if (!product) throw new Error('产品记录不存在');
  if (isProductUrlVerified_(product) && isAllowedOfficialProductUrl_(product.official_url)) {
    return String(product.official_url).trim();
  }

  var outcome = verifyProductUrl_(product);
  updateProductUrlFields_(product.product_id, {
    official_url: outcome.status === 'verified' ? outcome.url
      : (outcome.status === 'check_failed' ? String(product.official_url || '').trim() : ''),
    official_url_status: outcome.status,
    official_url_checked_at: outcome.checked_at,
    official_url_notes: outcome.notes || ''
  });

  if (outcome.status !== 'verified') {
    throw new Error('产品未通过官网 URL 核验（' + outcome.status + '）：' + (outcome.notes || '无可用官方产品页'));
  }

  product.official_url = outcome.url;
  product.official_url_status = 'verified';
  product.official_url_checked_at = outcome.checked_at;
  product.official_url_notes = outcome.notes || '';
  return outcome.url;
}
