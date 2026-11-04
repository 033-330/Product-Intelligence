/* ============================================================
 * tests/SmokeTest.js — 少量真实数据冒烟测试（Google Apps Script）
 *
 * 目的：用现有表里的真实产品验证本次改动
 * 重点：
 *   1. 产品实体过滤（品牌名/品类名/功能名不应识别为产品）
 *   2. 官网 URL 核验：失败时隔离（quarantined）而不是直接级联删除
 *   3. 耳机规格提取：区分听歌/通话续航、频响、灵敏度、驱动单元等
 *   4. 隔离产品不会进入规格采集队列
 * ============================================================ */

/* 菜单统一由 Menu.js 的 onOpen() 创建，这里不要再定义 onOpen，否则会覆盖主菜单。 */

function smoke_log_(title, msg) {
  var line = '[' + title + '] ' + msg;
  Logger.log(line);
  return line;
}

function smoke_getRealProducts_(limit) {
  limit = limit || 10;
  var list = readTable('Products').filter(function(p) {
    var st = String(p.status || '').toLowerCase();
    var cat = String(p.category || '').toLowerCase();
    if (st === 'merged' || st === 'brand' || cat === 'brand') return false;
    if (st === 'quarantined') return false;
    return true;
  });
  return list.slice(0, limit);
}

/* 1) 产品实体过滤 */
function smoke_productEntity() {
  var cases = [
    { v: 'GPW5', exp: true },
    { v: 'G Pro X Superlight 2', exp: true },
    { v: 'PRO X SUPERLIGHT 2', exp: true },
    { v: 'Cloud III', exp: true },
    { v: 'G915 TKL', exp: true },
    { v: 'HYPERX CLOUD ALPHA', exp: true },
    { v: 'Logitech', exp: false },
    { v: 'Razer', exp: false },
    { v: '雷蛇鼠标', exp: false },
    { v: '鼠标', exp: false },
    { v: '键盘', exp: false },
    { v: '耳机', exp: false },
    { v: '电磁微动', exp: false },
    { v: '光学微动', exp: false },
    { v: '霍尔效应微动', exp: false },
    { v: 'Hypershift', exp: false },
    { v: 'G 系列', exp: false },
    { v: 'PRO 系列', exp: false },
    { v: 'TTC Gold', exp: false },
    { v: 'Kailh BOX', exp: false },
    { v: 'Omron', exp: false }
  ];
  var pass = 0, fail = 0;
  var lines = ['=== 1) 产品实体过滤 ==='];
  cases.forEach(function(c) {
    var r = isLikelyProductEntity_(c.v);
    if (r === c.exp) { pass++; lines.push('OK  ' + c.v + ' -> ' + r); }
    else { fail++; lines.push('FAIL ' + c.v + ' -> ' + r + ' 预期:' + c.exp); }
  });
  lines.push('结果：' + pass + '/' + cases.length + ' 通过，' + fail + ' 失败');
  var txt = lines.join('\n');
  Logger.log(txt);
  SpreadsheetApp.getUi().alert(txt);
}

/* 2) 随机挑1个产品跑 URL 核验 */
function smoke_verifyOne() {
  var list = smoke_getRealProducts_(20);
  if (!list.length) { SpreadsheetApp.getUi().alert('Products 表中暂无可用产品（已过滤 merged/brand/quarantined）'); return; }
  var p = list[Math.floor(Math.random() * list.length)];
  Logger.log('=== 2) 单个产品 URL 核验 ===');
  Logger.log('目标：' + p.product_id + ' | ' + p.brand + ' | ' + p.canonical_name + ' | status:' + p.status + ' | url:' + (p.official_url||''));
  try {
    var fresh = readTable('Products').find(function(x){ return String(x.product_id) === String(p.product_id); }) || p;
    var out = verifyProductUrl_(fresh);
    Logger.log('outcome: ' + JSON.stringify(out));
    if (out.status === 'verified') {
      updateProductUrlFields_(p.product_id, { official_url: out.url, official_url_status: 'verified', official_url_checked_at: out.checked_at, official_url_notes: out.notes||'' });
      try {
        var sh = sheet_('Products'), vals = sh.getDataRange().getValues(), h = vals[0].map(function(x){return String(x);}), ix={}; for(var i=0;i<h.length;i++){ix[h[i]]=i;}
        for(var r=1;r<vals.length;r++){ if(String(vals[r][ix.product_id])===String(p.product_id)){ if(String(vals[r][ix.status]).toLowerCase()==='quarantined') sh.getRange(r+1,ix.status+1).setValue('active'); break; }}
      } catch(e){}
      SpreadsheetApp.getUi().alert('核验通过\n' + out.url);
    } else if (out.status === 'check_failed') {
      updateProductUrlFields_(p.product_id, { official_url: String(fresh.official_url||'').trim(), official_url_status: 'check_failed', official_url_checked_at: out.checked_at, official_url_notes: out.notes||'' });
      SpreadsheetApp.getUi().alert('暂时失败（check_failed）\n保留原URL，不隔离');
    } else if (out.status === 'not_found' || out.status === 'mismatch') {
      updateProductUrlFields_(p.product_id, { official_url: '', official_url_status: out.status, official_url_checked_at: out.checked_at, official_url_notes: out.notes||'' });
      try {
        var sh2 = sheet_('Products'), vals2 = sh2.getDataRange().getValues(), h2 = vals2[0].map(function(x){return String(x);}), ix2={}; for(var i2=0;i2<h2.length;i2++){ix2[h2[i2]]=i2;}
        for(var r2=1;r2<vals2.length;r2++){ if(String(vals2[r2][ix2.product_id])===String(p.product_id)){ var st2=String(vals2[r2][ix2.status]).toLowerCase(); if(st2!=='merged'&&st2!=='brand'){ sh2.getRange(r2+1,ix2.status+1).setValue('quarantined'); } break; }}
      } catch(e2){}
      try { enqueuePending_('product_quarantined_url_invalid', {product_id:p.product_id,canonical_name:p.canonical_name,brand:p.brand,url_status:out.status,reason:out.notes||''}, '冒烟测试：隔离而非删除'); } catch(e3){}
      SpreadsheetApp.getUi().alert('未找到匹配详情页 -> 已隔离（quarantined）\n未执行级联删除');
    }
  } catch(e) {
    Logger.log('ERR: ' + e);
    SpreadsheetApp.getUi().alert('异常：' + e);
  }
  clearCache();
}

/* 3) 批量核验 */
function smoke_verifyBatch() {
  Logger.log('=== 3) 批量核验（limit=5, quarantineOnly=true, deleteInvalid=false） ===');
  try {
    var res = verifyProductUrls_({ limit: 5, force: false, deleteInvalid: false, quarantineOnly: true });
    Logger.log(JSON.stringify(res, null, 2));
    SpreadsheetApp.getUi().alert('批量结果\nchecked:' + res.checked + '\nverified:' + res.verified + '\nretained_for_retry:' + res.retained_for_retry + '\nquarantined:' + res.quarantined + '\ndeleted:' + res.deleted.length + '\n（deleted 应为 0）');
  } catch(e) {
    Logger.log('ERR: ' + e);
    SpreadsheetApp.getUi().alert('异常：' + e);
  }
  clearCache();
}

/* 4) 耳机规格提取 */
function smoke_extractHeadset() {
  Logger.log('=== 4) 耳机规格提取 ===');
  var crawler = 'urlfetch';
  try { crawler = activeSpecCrawler_(); } catch (e) { SpreadsheetApp.getUi().alert(String(e && e.message ? e.message : e)); return; }
  if (crawler !== 'crawl4ai' && !hasConfiguredAIKey_()) {
    SpreadsheetApp.getUi().alert('需要 CRAWL4AI_API_KEY（推荐，可渲染官网页面），或 GEMINI_API_KEY / OPENROUTER_API_KEY 作为回退');
    return;
  }
  var prods = readTable('Products').filter(function(p){
    var st = String(p.status||'').toLowerCase();
    if (st==='merged'||st==='brand'||st==='quarantined') return false;
    var name = String(p.canonical_name||'').toLowerCase();
    var cat = String(p.category||'').toLowerCase();
    return cat.indexOf('headset')>=0 || cat.indexOf('headphone')>=0 || name.indexOf('cloud')>=0 || name.indexOf('zone')>=0 || name.indexOf('h390')>=0;
  });
  if (!prods.length) {
    SpreadsheetApp.getUi().alert('未找到合适的耳机产品。\n可去 Products 表找一条耳机类产品手动测试。');
    return;
  }
  var t = prods[0];
  Logger.log('目标：' + t.product_id + ' | ' + t.brand + ' ' + t.canonical_name);
  try {
    var url = resolveOfficialUrl_(t);
    Logger.log('抓取器：' + activeSpecCrawler_() + ' | URL: ' + url);
    var parsed = extractOfficialSpecs_(String(t.brand||'') + ' ' + String(t.canonical_name||''), url);
    var specs = parsed.specs || [];
    Logger.log('提取数量：' + specs.length);
    var keys = {};
    specs.forEach(function(s){ keys[s.spec_key] = 1; Logger.log('  ' + s.spec_key + ' = ' + s.value + (s.unit?' '+s.unit:'') + ' | raw:' + (s.raw_value||'').slice(0,80)); });
    var saved = saveOfficialSpecs_(t, url, parsed, specParserName_() + '_smoke');
    Logger.log('写入：' + saved.count);
    var need = ['battery_life_listening_hours','battery_life_talk_hours','frequency_response_mic','sensitivity_db','driver','bluetooth_version'];
    var hit = need.filter(function(k){ return keys[k]; });
    SpreadsheetApp.getUi().alert('耳机提取完成\n提取:' + specs.length + ' 写入:' + saved.count + '\n命中关键字段:' + hit.join(', ') + (hit.length<need.length?'\n（部分字段可能随官网结构不同）':''));
  } catch(e) {
    Logger.log('ERR: ' + e);
    SpreadsheetApp.getUi().alert('异常：' + e);
  }
  clearCache();
}

/* 5) 隔离产品不入队 */
function smoke_quarantineBlocksTask() {
  var qs = readTable('Products').filter(function(p){ return String(p.status||'').toLowerCase() === 'quarantined'; });
  if (!qs.length) { SpreadsheetApp.getUi().alert('当前无 quarantined 产品\n可先跑测试2或3产生隔离产品再测'); return; }
  var p = qs[0];
  Logger.log('=== 5) 隔离产品不入队 ===');
  Logger.log('隔离产品：' + p.product_id + ' ' + p.canonical_name);
  var id = enqueueSpecificationTask_(p.product_id, 'smoke_test', 1);
  if (id === null) { Logger.log('结果：返回 null -> 正确'); SpreadsheetApp.getUi().alert('✅ 正确：隔离产品不会进入规格采集队列'); }
  else { Logger.log('结果：返回 ' + id + ' -> 错误'); SpreadsheetApp.getUi().alert('❌ 错误：隔离产品意外入队'); }
}

/* 6) 状态报告 */
function smoke_reportStatus() {
  var prods = readTable('Products');
  var quarantined = prods.filter(function(p){ return String(p.status||'').toLowerCase()==='quarantined'; });
  var q = quarantined.length;
  var v = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='verified'; }).length;
  var cf = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='check_failed'; }).length;
  var nf = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='not_found'; }).length;
  var mm = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='mismatch'; }).length;
  var pend = [];
  try { pend = readTable('PendingQueue').filter(function(r){ return String(r.item_type||'').indexOf('quarantined')>=0; }); } catch(e){}

  var triggerState = '未安装（异步核验不会自动运行）';
  try {
    triggerState = isProductUrlVerifyTriggerInstalled_() ? '已安装（每 6 小时运行）' : triggerState;
  } catch (e) {}

  // 隔离原因分布：优先 official_url_status，缺失时回退到 notes 里的判定文本。
  var reasonCount = {};
  quarantined.forEach(function(p) {
    var reason = String(p.official_url_status || '').trim().toLowerCase();
    if (!reason) {
      var notes = String(p.official_url_notes || '');
      if (notes.indexOf('非品牌官网域名') >= 0) reason = 'invalid_domain';
      else if (notes.indexOf('页面与产品不匹配') >= 0) reason = 'mismatch';
      else if (notes.indexOf('页面已失效') >= 0) reason = 'invalid_http';
      else if (notes.indexOf('暂时无法抓取') >= 0) reason = 'check_failed';
      else reason = 'unknown';
    }
    reasonCount[reason] = (reasonCount[reason] || 0) + 1;
  });
  var reasonLines = Object.keys(reasonCount).sort().map(function(k) {
    return '  - ' + k + ': ' + reasonCount[k];
  });
  if (!reasonLines.length) reasonLines.push('  （无）');

  var recentFailLines = prods.filter(function(p) {
    var st = String(p.official_url_status || '').toLowerCase();
    return st === 'not_found' || st === 'mismatch' || st === 'check_failed';
  }).sort(function(a, b) {
    return String(b.official_url_checked_at || '').localeCompare(String(a.official_url_checked_at || ''));
  }).slice(0, 3).map(function(p) {
    return '  - ' + p.product_id + ' | ' + (p.canonical_name || '') + ' | '
      + (p.official_url_status || '') + ' | ' + String(p.official_url || '').slice(0, 100);
  });
  if (!recentFailLines.length) recentFailLines.push('  （无）');

  var txt = ['=== 6) 状态报告 ===',
    'quarantined(Products.status): ' + q,
    'verified: ' + v,
    'check_failed: ' + cf,
    'not_found: ' + nf,
    'mismatch: ' + mm,
    'URL 核验触发器: ' + triggerState,
    '隔离原因分布:',
    reasonLines.join('\n'),
    '最近失败(最多3条):',
    recentFailLines.join('\n'),
    'PendingQueue(quarantined相关): ' + pend.length].join('\n');
  Logger.log(txt); SpreadsheetApp.getUi().alert(txt);
}

/* 7) 安装/检查 URL 核验触发器（已存在则不重复创建） */
function smoke_ensureUrlVerifyTrigger() {
  var msg = ensureProductUrlVerifyTrigger_();
  Logger.log('=== 7) URL 核验触发器 ===\n' + msg);
  SpreadsheetApp.getUi().alert(msg);
}

/* 把长文本切成与 buildDeterministicSegments_ 一致的 6000 字块（优先在换行处断开）。 */
function splitSmokeText_(text, maxChars) {
  maxChars = Number(maxChars) || 6000;
  var s = String(text || ''), out = [], start = 0;
  while (start < s.length) {
    var end = Math.min(start + maxChars, s.length);
    if (end < s.length) {
      var nl = s.lastIndexOf('\n', end);
      if (nl > start + maxChars * 0.6) end = nl + 1;
      else {
        var nextNl = s.indexOf('\n', end);
        if (nextNl !== -1) end = nextNl + 1;
      }
    }
    out.push(s.slice(start, end));
    start = end;
  }
  return out.length ? out : [''];
}

/* 4.5) Crawl4AI 规格采集：只处理「官网已核验 + 缺规格」的产品，结果写正式规格表。 */
function crawl4aiSpecSmoke_(limit) {
  limit = Math.max(1, Math.min(5, Number(limit) || 3));
  var lines = [], result = { crawler: 'urlfetch', lines: lines, done: 0, failed: 0, candidates: 0 };

  try { result.crawler = activeSpecCrawler_(); }
  catch (e) { result.crawler = 'crawl4ai(配置错误)'; lines.push('  抓取器：' + result.crawler + ' — ' + (e && e.message ? e.message : e)); return result; }

  if (result.crawler !== 'crawl4ai') {
    lines.push('  抓取器：urlfetch（未启用 Crawl4AI，请在 Script Properties 配置 CRAWL4AI_API_KEY）');
    return result;
  }
  lines.push('  抓取器：Crawl4AI /extract');

  var products = readTable('Products').filter(function(p) {
    var st = String(p.status || '').toLowerCase();
    if (st === 'merged' || st === 'brand' || st === 'quarantined') return false;
    return isProductUrlVerified_(p);
  });
  var specs = readTable('ProductSpecifications');
  var missing = products.filter(function(p) {
    return !specs.some(function(s) {
      return String(s.product_id) === String(p.product_id) && String(s.value || '').trim() !== '';
    });
  });
  result.candidates = missing.length;
  lines.push('  已核验官网的产品：' + products.length + '，其中缺规格：' + missing.length);
  if (!missing.length) {
    lines.push('  没有待采集产品（可先清掉某个产品的规格再测，或先跑冒烟 2/3 核验 URL）');
    return result;
  }

  missing.slice(0, limit).forEach(function(p) {
    var label = String(p.product_id) + ' ' + String(p.brand || '') + ' ' + String(p.canonical_name || '');
    try {
      var url = String(p.official_url || '');
      var parsed = extractSpecsViaCrawl4AI_(String(p.brand || '') + ' ' + String(p.canonical_name || ''), url);
      if (!parsed.specs.length) {
        result.failed++;
        lines.push('  ' + label + ' → 0 项（官网未给出可确认参数）');
        return;
      }
      var saved = saveOfficialSpecs_(p, url, parsed, 'crawl4ai_smoke');
      result.done++;
      lines.push('  ' + label + ' → 成功 ' + saved.count + ' 项：'
        + parsed.specs.slice(0, 4).map(function(s) { return s.spec_key + '=' + s.value + (s.unit ? s.unit : ''); }).join(', '));
    } catch (e) {
      result.failed++;
      lines.push('  ' + label + ' → 失败：' + String(e && e.message ? e.message : e).slice(0, 180));
    }
  });
  clearCache();
  return result;
}

function smoke_crawl4aiSpecs() {
  var ui = SpreadsheetApp.getUi();
  Logger.log('=== 4.5) Crawl4AI 规格采集 ===');
  try {
    var res = crawl4aiSpecSmoke_(3);
    var summary = ['【冒烟】Crawl4AI 规格采集'
      , '抓取器：' + res.crawler
      , '成功：' + res.done + '，失败：' + res.failed + '，待采集：' + res.candidates]
      .concat(res.lines).join('\n');
    Logger.log(summary);
    ui.alert(summary);
    return summary;
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    Logger.log('ERR: ' + msg);
    ui.alert('异常：' + msg);
  }
}

function smoke_pipelineFromLogitechReport14(text) {
  // 菜单/编辑器里有 UI 就弹框；通过 Execution API 调用时没有 UI，直接使用传入的 text。
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  if (typeof text !== 'string') {
    if (!ui) throw new Error('当前上下文无 UI，请通过参数传入待处理文本');
    var resp = ui.prompt('用第14期报告跑完整 Pipeline', '请粘贴《罗技游戏-罗技产品跟踪-第14期 — 整份报告》中的某一长段文本（建议200字以上，包含产品名、型号更好）', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.ButtonSet.OK) return;
    text = String(resp.getResponseText() || '').trim();
  } else {
    text = String(text || '').trim();
  }
  if (!text) { if (ui) ui.alert('未粘贴文本，已取消'); return; }
  try {
    var issueNo = 'smoke14';
    var baseUrl = 'smoke://logitech/issue14';
    ensureIssue_(issueNo, Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'), baseUrl);

    // 整份报告可达 16 万字：一次 PASS_A 的 JSON 远超 maxOutputTokens 会被截断。
    // 按生产同样的 6000 字分块逐块抽取，每块单独一次调用；已处理过的块按标题跳过，重跑可续。
    var chunks = splitSmokeText_(text, 6000);
    var doneTitles = {};
    readTable('Documents').forEach(function(d) {
      if (String(d.issue_no) === issueNo) doneTitles[String(d.title)] = 1;
    });
    var pending = [];
    chunks.forEach(function(chunk, i) {
      var title = '【冒烟】罗技游戏-罗技产品跟踪-第14期（手动粘贴）｜分块 ' + ('000' + (i + 1)).slice(-3);
      if (!doneTitles[title]) pending.push({ index: i + 1, text: chunk, title: title });
    });
    var MAX_CHUNKS_PER_RUN = 3;
    var batch = pending.slice(0, MAX_CHUNKS_PER_RUN);
    var remaining = Math.max(0, pending.length - batch.length);

    var dedup = buildDedupSets_();
    var stats = { added: 0, skipped: 0, updated: 0 };
    var docIds = [], chunkLines = [], truncatedChunks = 0;

    if (!batch.length) {
      chunkLines.push('  所有分块均已处理，无新增（如需重跑请先删掉 Documents 里对应分块行）');
    }
    batch.forEach(function(c) {
      var seg = {
        title: c.title,
        url: baseUrl,
        platform: 'manual',
        source_type: 'manual_smoke',
        text: c.text
      };
      var doc = upsertDocument_(issueNo, seg, '');
      docIds.push(doc.doc_id);
      var ext = callAI(buildPassAPrompt_(doc, c.text), PASS_A_SCHEMA,
        { maxTokens: Number(CONFIG.AI_MAX_OUTPUT_TOKENS) || 16384 });
      var wasCut = !!(ext && ext.__truncated);
      if (wasCut) truncatedChunks++;
      writeDocumentExtraction_(doc, ext, issueNo, dedup, stats);
      var diag = typeof getLastAiDiag_ === 'function' ? getLastAiDiag_() : null;
      var diagText = diag
        ? ' · ' + diag.provider + '/' + String(diag.model || '')
          + ' · 思考 ' + (diag.thoughts || 0) + ' · 输出 ' + (diag.outputTokens || 0)
          + (diag.finishReason ? ' · ' + diag.finishReason : '')
        : '';
      chunkLines.push('  分块 ' + c.index + '/' + chunks.length + '：' + doc.doc_id
        + '（' + String(c.text.length) + ' 字）' + diagText
        + (wasCut ? ' → 输出被截断，已保留完整条目' : ''));
    });

    if (typeof rebuildProductPages_ === 'function') rebuildProductPages_();

    // 先把未核验的产品跑一遍 URL 核验，否则规格队列会被 isProductUrlVerified_ 全部挡掉。
    var urlVerifyLines = [];
    try {
      var urlRes = verifyProductUrls_({ force: false, deleteInvalid: false, quarantineOnly: true });
      urlVerifyLines = ['checked=' + urlRes.checked + ' verified=' + urlRes.verified + ' quarantined=' + urlRes.quarantined + ' retained=' + urlRes.retained_for_retry];
    } catch (e) {
      urlVerifyLines = ['URL 核验异常：' + (e && e.message ? e.message : e)];
    }

    // 规格采集是独立队列：入队缺少规格的产品，并立即处理最多 3 条。
    var specQueued = 0, specProcessed = 0, specLines = [], crawlerLabel = 'unknown';
    try { crawlerLabel = activeSpecCrawler_(); } catch (e) { crawlerLabel = '配置错误：' + (e && e.message ? e.message : e); }
    try {
      var queued = enqueueMissingSpecificationTasks_();
      specQueued = queued.queued || 0;
      // Crawl4AI 自带 LLM 抽取，只有 urlfetch 路径才需要 Gemini/OpenRouter Key。
      if (hasConfiguredAIKey_() || crawlerLabel === 'crawl4ai') {
        var specRes = processSpecificationTasks_(3);
        specProcessed = specRes.processed || 0;
        specLines = (specRes.results || []).map(function(r) {
          if (r.status === 'done') return '  ' + r.product_id + ' 成功 ' + r.count + ' 项';
          return '  ' + r.product_id + ' ' + r.status + '：' + (r.error || '');
        });
      } else {
        specLines = ['  未配置 AI Key 也未配置 CRAWL4AI_API_KEY，仅入队未执行'];
      }
    } catch (e) {
      specLines = ['  规格队列异常：' + (e && e.message ? e.message : e)];
    }

    // 队列一次只跑 3 条且只认已核验 URL 的产品；这里再显式用 Crawl4AI 抓一轮，确保本期能验证爬虫。
    var c4Lines = [], c4Done = 0, c4Failed = 0;
    try {
      var c4 = crawl4aiSpecSmoke_(2);
      c4Lines = c4.lines; c4Done = c4.done; c4Failed = c4.failed;
    } catch (e) {
      c4Lines = ['  Crawl4AI 采集异常：' + (e && e.message ? e.message : e)];
    }
    clearCache();

    var counts = [];
    ['Products', 'Topics', 'Feedback', 'Events', 'ProductSpecificationsRaw'].forEach(function(name) {
      try { counts.push(name + '：' + readTable(name).length); }
      catch (err) { counts.push(name + '：读取失败(' + err.message + ')'); }
    });
    var summary = ['【冒烟】第14期报告 Pipeline 跑完',
      '文本分块：共 ' + chunks.length + ' 块，本次处理 ' + batch.length + ' 块，剩余 ' + remaining + ' 块'
        + (truncatedChunks ? '（' + truncatedChunks + ' 块输出被截断）' : ''),
      docIds.length ? '文档：' + docIds.join(', ') : '文档：无新增分块',
      '本段新增：' + stats.added + '，跳过重复：' + stats.skipped,
      'URL 核验：' + urlVerifyLines.join('\n'),
      '规格抓取器：' + crawlerLabel,
      '规格任务：入队 ' + specQueued + '，执行 ' + specProcessed]
      .concat(specLines)
      .concat(['Crawl4AI 直采：成功 ' + c4Done + '，失败 ' + c4Failed]).concat(c4Lines)
      .concat(counts).join('\n');
    Logger.log(summary);
    if (ui) ui.alert(summary);
    return summary;
  } catch(e) {
    var msg = e && e.message ? e.message : String(e);
    Logger.log('ERR: ' + msg + '\n' + (e && e.stack ? e.stack : ''));
    if (ui) { try { ui.alert('异常：' + msg); } catch(ee) {} }
    throw new Error(msg);
  }
}

/* 从 SmokeInput!A2 读取整段文本（适合多行长文本），再跑同一条 Pipeline。 */
function smoke_pipelineFromInputSheet() {
  var ui = SpreadsheetApp.getUi();
  var ss = ss_();
  var sh = ss.getSheetByName('SmokeInput');
  if (!sh) {
    sh = ss.insertSheet('SmokeInput');
    sh.getRange('A1').setValue('把待测试文本粘贴到 A2，然后从菜单重新运行"从 SmokeInput!A2 跑Pipeline"。');
  }
  var text = String(sh.getRange('A2').getValue() || '').trim();
  if (!text) {
    ui.alert('SmokeInput!A2 还是空的，请先粘贴文本。');
    return;
  }
  ui.alert(smoke_productOnlyPipeline_(text));
}

/* 精简冒烟：只做 产品识别 → URL 核验 → 规格提取，跳过 topics/feedback/events/user_needs/competitors。 */
function smoke_productOnlyPipeline_(text) {
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  text = String(text || '').trim();
  if (!text) { if (ui) ui.alert('文本为空'); return; }
  try {
    var issueNo = 'smoke14';
    var baseUrl = 'smoke://logitech/issue14';
    ensureIssue_(issueNo, Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'), baseUrl);

    var chunks = splitSmokeText_(text, 6000);
    var doneTitles = {};
    readTable('Documents').forEach(function(d) {
      if (String(d.issue_no) === issueNo) doneTitles[String(d.title)] = 1;
    });
    var pending = [];
    chunks.forEach(function(chunk, i) {
      var title = '【冒烟·精简】罗技产品跟踪-第14期｜分块 ' + ('000' + (i + 1)).slice(-3);
      if (!doneTitles[title]) pending.push({ index: i + 1, text: chunk, title: title });
    });
    var MAX_CHUNKS_PER_RUN = 3;
    var batch = pending.slice(0, MAX_CHUNKS_PER_RUN);
    var remaining = Math.max(0, pending.length - batch.length);

    var stats = { added: 0, skipped: 0 };
    var docIds = [], chunkLines = [], truncatedChunks = 0;

    batch.forEach(function(c) {
      var seg = { title: c.title, url: baseUrl, platform: 'manual', source_type: 'manual_smoke', text: c.text };
      var doc = upsertDocument_(issueNo, seg, '');
      docIds.push(doc.doc_id);
      var ext = callAI(buildPassAPrompt_(doc, c.text), PASS_A_SCHEMA,
        { maxTokens: Number(CONFIG.AI_MAX_OUTPUT_TOKENS) || 16384 });
      var wasCut = !!(ext && ext.__truncated);
      if (wasCut) truncatedChunks++;
      // 只处理产品实体，跳过 topics/feedback/events/user_needs/competitors。
      var products = (ext && ext.products) || [];
      resolveProducts_(products, issueNo);
      stats.added += products.length;
      var diag = typeof getLastAiDiag_ === 'function' ? getLastAiDiag_() : null;
      var diagText = diag
        ? ' · ' + diag.provider + '/' + String(diag.model || '')
          + ' · 输出 ' + (diag.outputTokens || 0)
          + (diag.finishReason ? ' · ' + diag.finishReason : '')
        : '';
      chunkLines.push('  分块 ' + c.index + '/' + chunks.length + '：' + doc.doc_id
        + '（' + String(c.text.length) + ' 字）识别产品 ' + products.length + ' 款' + diagText
        + (wasCut ? ' → 输出被截断' : ''));
    });

    // 列出本期识别到的产品，便于人工核对名字是否忠实于原文。
    var productLines = [];
    try {
      readTable('Products').forEach(function(p) {
        if (String(p.status || '').toLowerCase() === 'merged') return;
        productLines.push('  ' + p.product_id + ' | ' + p.canonical_name + ' | ' + (p.official_url_status || '未核验') + ' | ' + (p.official_url || ''));
      });
    } catch (e) {}

    // URL 核验
    var urlVerifyLines = [];
    try {
      var urlRes = verifyProductUrls_({ force: false, deleteInvalid: false, quarantineOnly: true });
      urlVerifyLines = ['checked=' + urlRes.checked + ' verified=' + urlRes.verified + ' quarantined=' + urlRes.quarantined + ' retained=' + urlRes.retained_for_retry];
    } catch (e) {
      urlVerifyLines = ['URL 核验异常：' + (e && e.message ? e.message : e)];
    }

    // 规格入队 + 采集
    var specQueued = 0, specProcessed = 0, specLines = [], crawlerLabel = 'unknown';
    try { crawlerLabel = activeSpecCrawler_(); } catch (e) { crawlerLabel = '配置错误：' + (e && e.message ? e.message : e); }
    try {
      var queued = enqueueMissingSpecificationTasks_();
      specQueued = queued.queued || 0;
      if (hasConfiguredAIKey_() || crawlerLabel === 'crawl4ai') {
        var specRes = processSpecificationTasks_(3);
        specProcessed = specRes.processed || 0;
        specLines = (specRes.results || []).map(function(r) {
          if (r.status === 'done') return '  ' + r.product_id + ' 成功 ' + r.count + ' 项';
          return '  ' + r.product_id + ' ' + r.status + '：' + (r.error || '');
        });
      } else {
        specLines = ['  未配置 AI Key 也未配置 CRAWL4AI_API_KEY，仅入队未执行'];
      }
    } catch (e) {
      specLines = ['  规格队列异常：' + (e && e.message ? e.message : e)];
    }

    clearCache();

    var counts = [];
    ['Products', 'ProductSpecificationsRaw'].forEach(function(name) {
      try { counts.push(name + '：' + readTable(name).length); }
      catch (err) { counts.push(name + '：读取失败(' + err.message + ')'); }
    });
    var summary = ['【冒烟·精简】产品识别 → URL 核验 → 规格提取',
      '文本分块：共 ' + chunks.length + ' 块，本次处理 ' + batch.length + ' 块，剩余 ' + remaining + ' 块'
        + (truncatedChunks ? '（' + truncatedChunks + ' 块输出被截断）' : ''),
      docIds.length ? '文档：' + docIds.join(', ') : '文档：无新增分块',
      '识别产品：' + stats.added + ' 款']
      .concat(chunkLines)
      .concat(['', '当前 Products 表：']).concat(productLines)
      .concat(['', 'URL 核验：' + urlVerifyLines.join('\n')])
      .concat(['规格抓取器：' + crawlerLabel, '规格任务：入队 ' + specQueued + '，执行 ' + specProcessed])
      .concat(specLines)
      .concat(counts).join('\n');
    Logger.log(summary);
    if (ui) ui.alert(summary);
    return summary;
  } catch(e) {
    var msg = e && e.message ? e.message : String(e);
    Logger.log('ERR: ' + msg + '\n' + (e && e.stack ? e.stack : ''));
    if (ui) { try { ui.alert('异常：' + msg); } catch(ee) {} }
    throw new Error(msg);
  }
}

function smoke_all() {
  smoke_productEntity();
  Utilities.sleep(800);
  smoke_verifyBatch();
  Utilities.sleep(1500);
  smoke_reportStatus();
  Utilities.sleep(800);
  smoke_quarantineBlocksTask();
  SpreadsheetApp.getUi().alert('冒烟测试完成\n详情见扩展程序 > Apps Script > 执行日志');
}

