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

  var bodyHtml = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  return {
    title: decodeHtmlText_(title),
    strongText: decodeHtmlText_([title].concat(h1s, metas).join(' | ')),
    fullText: decodeHtmlText_(bodyHtml).slice(0, 120000)
  };
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

/**
 * UrlFetch 抓不到有效内容时的 Crawl4AI 兜底。
 * 只负责取回渲染后的文本，是否匹配仍由 productPageMatches_ 确定性判断。
 * 返回 null 表示未取得可匹配内容；失败原因写入 noteOut。
 */
function tryRenderedMatch_(url, product, reason, noteOut) {
  if (!crawl4aiCanRender_()) return { status: 'disabled' };
  var rendered;
  try {
    rendered = crawl4aiRenderPage_(url, String(product.brand || '') + ' ' + String(product.canonical_name || ''));
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

function inspectOfficialProductUrl_(url, product) {
  var renderNotes = [];
  var page;
  try {
    page = fetchOfficialProductPage_(url);
  } catch (e) {
    // 网络层失败：可能是反爬或需要 JS 渲染，交给 Crawl4AI 再试一次。
    var renderedOnError = tryRenderedMatch_(url, product, '网络错误', renderNotes);
    if (renderedOnError.status === 'matched') return renderedOnError;
    return { status: 'fetch_error', code: 0, message: String(e).slice(0, 200), render_notes: renderNotes };
  }

  var code = page.code;
  if (code >= 200 && code < 300) {
    var identity = extractPageIdentity_(page.html);
    if (productPageMatches_(product.canonical_name, product.brand, identity.strongText, identity.fullText)) {
      return { status: 'matched', code: code, title: identity.title, via: 'urlfetch' };
    }
    // 2xx 但不含型号：多半是 JS 渲染的空壳页（SPA 官网），用 Crawl4AI 渲染后再判。
    var rendered = tryRenderedMatch_(url, product, '空壳页', renderNotes);
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
  var renderedBlocked = tryRenderedMatch_(url, product, 'HTTP ' + code, renderNotes);
  if (renderedBlocked.status === 'matched') return renderedBlocked;
  return { status: 'fetch_error', code: code, message: 'HTTP ' + code, render_notes: renderNotes };
}

/**
 * 核验单个产品。返回 { status, url, checked_at, notes }。
 * status: verified / not_found / mismatch / check_failed
 */
function verifyProductUrl_(product) {
  product = product || {};
  var checkedAt = new Date().toISOString();
  var brand = String(product.brand || '');
  var name = String(product.canonical_name || '');
  var existing = String(product.official_url || '').trim();
  var notes = [];
  var tested = {};
  var hardInvalid = false;
  var transient = false;

  function tryUrl(url) {
    url = String(url || '').trim();
    if (!url || tested[url]) return null;
    tested[url] = 1;
    if (!isAllowedOfficialProductUrl_(url)) {
      notes.push('非品牌官网域名: ' + url.slice(0, 160));
      hardInvalid = true;
      return null;
    }
    var result = inspectOfficialProductUrl_(url, product);
    if (result.status === 'matched') {
      return {
        status: 'verified', url: url, checked_at: checkedAt,
        via: result.via || 'urlfetch',
        notes: (result.via === 'crawl4ai'
          ? 'Crawl4AI 渲染页面核验通过 | 页面标题: '
          : '页面标题: ') + String(result.title || '').slice(0, 300)
      };
    }
    if (result.status === 'mismatch') {
      hardInvalid = true;
      notes.push('页面与产品不匹配: ' + url.slice(0, 160) + ' | ' + String(result.title || '').slice(0, 100));
      (result.render_notes || []).forEach(function(n) { notes.push(n); });
    } else if (result.status === 'invalid_http') {
      hardInvalid = true;
      notes.push('页面已失效(' + result.code + '): ' + url.slice(0, 160));
    } else {
      transient = true;
      notes.push('暂时无法抓取(' + (result.code || 'net') + '): ' + url.slice(0, 160));
      (result.render_notes || []).forEach(function(n) { notes.push(n); });
    }
    return null;
  }

  var hit = tryUrl(existing);
  if (hit) return hit;

  var candidates = [];
  try {
    candidates = searchOfficialProductCandidates_(brand + ' ' + name);
  } catch (e) {
    transient = true;
    notes.push('官网搜索失败: ' + String(e).slice(0, 120));
  }

  for (var i = 0; i < candidates.length && i < 12; i++) {
    hit = tryUrl(candidates[i]);
    if (hit) return hit;
  }

  var status = hardInvalid ? 'mismatch' : (transient ? 'check_failed' : 'not_found');
  return {
    status: status,
    url: status === 'check_failed' ? existing : '',
    checked_at: checkedAt,
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
    try {
      outcome = verifyProductUrl_(p);
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
      verifyProductUrls_({ ids: pid, force: true, limit: 1, deleteInvalid: false, quarantineOnly: true });
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
