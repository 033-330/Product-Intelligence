/* ============================================================
 * FullPipelineEntry.gs — V2.1 P0 端到端验证入口
 *
 * 输入一段文本，一次性跑通：
 *   结构分块 → Pass A 实体识别 → 产品入库（含 URL 验证任务）
 *   → URL 核验 → 规格采集 → 写入 ProductSpecifications
 *
 * 手动触发：
 *   - 表格菜单「冒烟测试 → 4.7) 端到端验证」
 *   - 或在 Apps Script 编辑器运行 smoke_fullPipelineFromInputSheet
 *
 * 结果：
 *   - 弹窗摘要
 *   - SmokeInput!A3 起写阶段明细
 * ============================================================ */

var FULL_PIPELINE_PROGRESS_SHEET_ = null;

function smoke_fullPipelineFromInputSheet() {
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }

  var ss = ss_();
  var sh = ss.getSheetByName('SmokeInput');
  if (!sh) {
    sh = ss.insertSheet('SmokeInput');
    sh.getRange('A1').setValue('把待测试文本粘贴到 A2，然后运行菜单「4.7) 端到端验证」。');
  }

  var text = String(sh.getRange('A2').getValue() || '').trim();
  if (!text) {
    if (ui) ui.alert('SmokeInput!A2 还是空的，请先粘贴一段文本。');
    return { ok: false, error: '文本为空' };
  }

  var report;
  FULL_PIPELINE_PROGRESS_SHEET_ = sh;
  try {
    report = runFullPipelineFromText_(text, {
      maxSegments: numberProperty_('FULL_PIPELINE_MAX_SEGMENTS',
        Number(CONFIG.FULL_PIPELINE_MAX_SEGMENTS) || 3),
      maxProducts: numberProperty_('FULL_PIPELINE_MAX_PRODUCTS',
        Number(CONFIG.FULL_PIPELINE_MAX_PRODUCTS) || 3),
      maxSpecs: numberProperty_('FULL_PIPELINE_MAX_SPECS',
        Number(CONFIG.FULL_PIPELINE_MAX_SPECS) || 1)
    });
  } catch (e) {
    report = {
      ok: false,
      error: String(e && e.message ? e.message : e),
      stages: [],
      errors: [String(e && e.message ? e.message : e)],
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      elapsed_ms: 0
    };
  } finally {
    FULL_PIPELINE_PROGRESS_SHEET_ = null;
  }

  try { writeFullPipelineReport_(sh, report); } catch (writeError) {
    Logger.log('写入端到端报告失败：' + String(writeError));
  }
  if (ui) ui.alert(buildFullPipelineSummary_(report));
  Logger.log(JSON.stringify(report));
  return report;
}

/**
 * 核心入口：从任意文本跑完整链路。
 * opts: { maxSegments, maxProducts, maxSpecs, budgetMs }
 */
function runFullPipelineFromText_(text, opts) {
  opts = opts || {};
  var startedMs = Date.now();
  var maxSegments = Math.max(1, Number(opts.maxSegments) || 3);
  var maxProducts = Math.max(1, Number(opts.maxProducts) || 3);
  var maxSpecs = (opts.maxSpecs === undefined || opts.maxSpecs === null || opts.maxSpecs === '')
    ? (Number(CONFIG.FULL_PIPELINE_MAX_SPECS) || 1)
    : Math.max(0, Number(opts.maxSpecs) || 0);
  var timeBudget = Math.max(60000,
    Number(opts.budgetMs) || Number(CONFIG.DOC_RUN_BUDGET_MS) || 240000);

  var report = {
    ok: false,
    started_at: new Date().toISOString(),
    text_chars: String(text || '').length,
    stages: [],
    segments: [],
    total_segments: 0,
    products: [],
    url_results: [],
    spec_results: [],
    errors: [],
    spec_saved: 0,
    tokens: { ai_calls: 0, input_tokens: 0, output_tokens: 0 }
  };

  function stage(name, status, detail) {
    report.stages.push({
      stage: name, status: status, detail: detail || '',
      elapsed_ms: Date.now() - startedMs
    });
    if (FULL_PIPELINE_PROGRESS_SHEET_) {
      try { writeFullPipelineReport_(FULL_PIPELINE_PROGRESS_SHEET_, report); } catch (ignore) {}
    }
  }

  // 0) 幂等建表/补列（不删改历史数据）
  try {
    setupSheets();
    stage('setupSheets', 'ok', '建表/补列完成');
  } catch (e) {
    stage('setupSheets', 'warn', String(e).slice(0, 200));
  }

  // 1) 结构感知分块
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss');
  var fakeFile = {
    getName: function() { return '端到端测试文本-' + stamp; },
    getUrl: function() { return 'smoke://full/' + stamp; },
    getLastUpdated: function() { return new Date(); }
  };

  var segResult = buildDeterministicSegments_(fakeFile, text);
  var allSegs = segResult.documents || [];
  report.total_segments = allSegs.length;
  var segs = allSegs.slice(0, maxSegments);
  stage('split', segs.length ? 'ok' : 'fail',
    '共 ' + allSegs.length + ' 个分块，本次处理 ' + segs.length
    + ' 个（segmenter=' + (segResult.segmenter_version || '') + '）');
  if (!segs.length) {
    report.errors.push('分块为空');
    return finishFullPipelineReport_(report, startedMs);
  }

  report.segments = segs.map(function(s) {
    return {
      segment_id: s.segment_id,
      title: s.title,
      section: s.parent_section,
      type: s.segment_type,
      chars: String(s.text || '').length,
      tokens_est: estimateTokens_(s.text),
      content_hash: s.content_hash
    };
  });

  // 2) 文档登记 + Pass A + 实体/话题/讨论落库
  var issueNo = 'e2e-' + stamp;
  var issueDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  ensureIssue_(issueNo, issueDate, fakeFile.getUrl());

  var dedup = buildDedupSets_();
  var stats = {
    added: 0, skipped: 0, updated: 0, errors: [],
    ai_calls: 0, input_tokens: 0, output_tokens: 0
  };
  var productIds = {};

  segs.forEach(function(seg) {
    if (Date.now() - startedMs >= timeBudget) {
      stage('passA:' + seg.segment_id, 'budget_stopped', '接近运行上限，剩余分块留待下次');
      return;
    }
    try {
      var docRow = upsertDocument_(issueNo, seg, issueDate);
      var remainingMs = timeBudget - (Date.now() - startedMs);
      var ext = callAI(buildPassAPrompt_(docRow, String(seg.text || '')), PASS_A_SCHEMA, {
        maxTokens: Number(CONFIG.AI_MAX_OUTPUT_TOKENS) || 16384,
        timeoutMs: Math.min(
          Number(CONFIG.AI_CALL_BUDGET_MS) || 90000,
          Math.max(15000, remainingMs)
        )
      });
      var before = stats.added;
      writeDocumentExtraction_(docRow, ext, issueNo, dedup, stats);

      (ext.products || []).forEach(function(p) {
        if (p && p.product_id) productIds[p.product_id] = 1;
      });

      var diag = typeof getLastAiDiag_ === 'function' ? getLastAiDiag_() : null;
      if (diag) {
        stats.ai_calls++;
        stats.input_tokens += Number(diag.inputTokens || 0);
        stats.output_tokens += Number(diag.outputTokens || 0) + Number(diag.thoughts || 0);
      }

      stage('passA:' + seg.segment_id, 'ok',
        '【' + (seg.parent_section || '正文') + ' / ' + String(seg.text || '').length + '字】'
        + '识别产品 ' + ((ext.products || []).length)
        + '，新增明细 ' + (stats.added - before)
        + (diag ? '，output_tokens=' + (diag.outputTokens || 0) : '')
        + (ext.__truncated ? '（输出被截断）' : ''));
    } catch (e) {
      var msg = String(e && e.message ? e.message : e).slice(0, 300);
      report.errors.push(msg);
      stage('passA:' + seg.segment_id, 'fail', msg.slice(0, 200));
      try {
        enqueuePending_('e2e_doc_error', { issue: issueNo, title: seg.title }, msg);
      } catch (ignore) {}
    }
  });

  var ids = Object.keys(productIds).slice(0, maxProducts);
  report.products = ids.map(function(id) {
    var p = readTable('Products').filter(function(x) {
      return String(x.product_id) === String(id);
    })[0] || {};
    return {
      product_id: id,
      name: p.canonical_name || '',
      brand: p.brand || '',
      category: p.category || '',
      official_url: p.official_url || '',
      url_status: p.official_url_status || ''
    };
  });
  stage('entities', ids.length ? 'ok' : 'warn',
    '本次涉及产品 ' + Object.keys(productIds).length + ' 个，本次验证前 ' + ids.length + ' 个');
  if (!ids.length && allSegs.length > segs.length) {
    stage('hint', 'warn',
      '前 ' + segs.length + ' 块未识别到产品，全文共 ' + allSegs.length
      + ' 块；可设置脚本属性 FULL_PIPELINE_MAX_SEGMENTS 加大处理块数后重跑');
  }

  // 3) URL 验证（复用任务队列 + 现有核验链路）
  var verified = [];
  ids.forEach(function(id) {
    // 单次 URL 核验可能包含 90 秒级 AI 调用，剩余不足 90 秒就不要再开始。
    if (timeBudget - (Date.now() - startedMs) < 90000) {
      report.url_results.push({ product_id: id, status: 'skipped_budget' });
      try { enqueueUrlVerificationTask_(id, '', 1); } catch (ignore) {}
      stage('url:' + id, 'skipped', '剩余不足 90 秒，已入队待定时任务核验');
      return;
    }
    try {
      var product = verifyProductForEntry_(id);
      var st = String(product.official_url_status || '').toLowerCase();
      report.url_results.push({
        product_id: id,
        status: st || 'unknown',
        url: product.official_url || '',
        notes: String(product.official_url_notes || '').slice(0, 200)
      });
      stage('url:' + id, st === 'verified' ? 'ok' : 'fail',
        (st || 'unknown') + ' | ' + String(product.official_url || '').slice(0, 120));
      if (st === 'verified') verified.push(id);
    } catch (e) {
      var urlError = String(e && e.message ? e.message : e).slice(0, 300);
      report.url_results.push({ product_id: id, status: 'error', error: urlError });
      report.errors.push('URL 验证失败 ' + id + '：' + urlError);
      stage('url:' + id, 'fail', urlError.slice(0, 200));
    }
  });

  // 4) 规格采集 + 写入
  verified.slice(0, maxSpecs).forEach(function(id) {
    // Crawl4AI 单产品最多 3×40 秒 + 等待，剩余不足 150 秒就交给定时队列。
    if (timeBudget - (Date.now() - startedMs) < 150000) {
      report.spec_results.push({ product_id: id, status: 'skipped_budget' });
      try { enqueueSpecificationTask_(id, 'e2e_budget_skipped', 1); } catch (ignore) {}
      stage('specs:' + id, 'skipped', '剩余不足 150 秒，已入队待定时任务执行');
      return;
    }
    try {
      var p = readTable('Products').filter(function(x) {
        return String(x.product_id) === String(id);
      })[0];
      var url = resolveOfficialUrl_(p);
      // 先过入队门禁（验证产品确实可采集），采集完成后把任务标记 done，避免残留 queued 任务。
      var taskId = enqueueSpecificationTask_(id, 'e2e_full_pipeline', 1);
      var parserName = specParserName_();
      var parsed = extractOfficialSpecs_(String(p.brand || '') + ' ' + String(p.canonical_name || ''), url);
      var saved = saveOfficialSpecs_(p, url, parsed, parserName);
      if (taskId && typeof updateSpecificationTask_ === 'function') {
        updateSpecificationTask_(taskId, {
          status: 'done',
          finished_at: new Date().toISOString(),
          source_url: url,
          last_error: '',
          task_notes: 'e2e 同步采集完成：' + saved.count + ' 项规格'
        });
      }

      report.spec_results.push({
        product_id: id,
        status: 'saved',
        specs: saved.count,
        crawler: parsed.crawler || parserName,
        url: url,
        queued_task: taskId || ''
      });
      stage('specs:' + id, 'ok',
        '写入 ' + saved.count + ' 条规格，来源 ' + (parsed.crawler || parserName));
    } catch (e) {
      var specError = String(e && e.message ? e.message : e).slice(0, 300);
      report.spec_results.push({ product_id: id, status: 'error', error: specError });
      report.errors.push('规格采集失败 ' + id + '：' + specError);
      stage('specs:' + id, 'fail', specError.slice(0, 200));
    }
  });

  report.issue_no = issueNo;
  report.tokens = {
    ai_calls: stats.ai_calls,
    input_tokens: stats.input_tokens,
    output_tokens: stats.output_tokens
  };
  report.spec_saved = report.spec_results.reduce(function(n, r) {
    return n + Number(r.specs || 0);
  }, 0);
  report.ok = report.errors.length === 0 && report.spec_saved > 0;
  return finishFullPipelineReport_(report, startedMs);
}

/** 入口专用：同步核验当前产品，并把它的验证任务结算掉，避免后台重复抓取。 */
function verifyProductForEntry_(productId) {
  var product = readTable('Products').filter(function(p) {
    return String(p.product_id) === String(productId);
  })[0] || {};

  if (!isProductUrlVerified_(product)) {
    verifyProductUrls_({
      ids: productId, force: true, limit: 1,
      deleteInvalid: false, quarantineOnly: true
    });
    product = readTable('Products').filter(function(p) {
      return String(p.product_id) === String(productId);
    })[0] || {};
  }

  settleUrlVerificationTask_(productId, product);
  return product;
}

/** 把该产品活跃的验证任务结算为 done/failed，与产品最终状态对齐。 */
function settleUrlVerificationTask_(productId, product) {
  try {
    var tasks = readTable('UrlVerificationTasks').filter(function(t) {
      return String(t.product_id) === String(productId)
        && ['queued', 'retry', 'running'].indexOf(String(t.status)) >= 0;
    });
    if (!tasks.length) return;

    var sh = sheet_('UrlVerificationTasks');
    var values = sh.getDataRange().getValues();
    var headers = values[0].map(function(h) { return String(h == null ? '' : h).trim(); });
    var ix = {};
    headers.forEach(function(h, i) { ix[h] = i; });

    var ok = isProductUrlVerified_(product);
    var status = ok ? 'done' : 'failed';
    var urlStatus = String(product.official_url_status || '').toLowerCase();
    var notes = String(product.official_url_notes || '').slice(0, 500);

    tasks.forEach(function(t) {
      for (var r = 1; r < values.length; r++) {
        if (String(values[r][ix.task_id] || '').trim() !== String(t.task_id)) continue;
        if (ix.status != null) sh.getRange(r + 1, ix.status + 1).setValue(status);
        if (ix.result != null) sh.getRange(r + 1, ix.result + 1).setValue(ok ? 'verified' : (urlStatus || 'failed'));
        if (ix.checked_at != null) sh.getRange(r + 1, ix.checked_at + 1).setValue(product.official_url_checked_at || '');
        if (ix.finished_at != null) sh.getRange(r + 1, ix.finished_at + 1).setValue(new Date().toISOString());
        if (ix.notes != null) sh.getRange(r + 1, ix.notes + 1).setValue(notes);
        if (ix.last_error != null) sh.getRange(r + 1, ix.last_error + 1).setValue(ok ? '' : notes);
        break;
      }
    });
  } catch (e) {
    Logger.log('结算 URL 验证任务失败：' + String(e));
  }
}

function finishFullPipelineReport_(report, startedMs) {
  report.elapsed_ms = Date.now() - startedMs;
  report.finished_at = new Date().toISOString();
  return report;
}

function buildFullPipelineSummary_(report) {
  var lines = ['端到端验证：' + (report.ok ? '通过' : '未完全通过')];
  lines.push('耗时：' + Number(report.elapsed_ms || 0) + ' ms');
  lines.push('分块：' + (report.segments || []).length
    + '，产品：' + (report.products || []).length);
  lines.push('URL 通过：' + (report.url_results || []).filter(function(r) {
    return r.status === 'verified';
  }).length);
  lines.push('规格写入：' + Number(report.spec_saved || 0) + ' 条');
  if (!(report.products || []).length
      && Number(report.total_segments || 0) > (report.segments || []).length) {
    lines.push('提示：前 ' + (report.segments || []).length + ' 块未识别到产品（共 '
      + Number(report.total_segments || 0) + ' 块），可在脚本属性设置 '
      + 'FULL_PIPELINE_MAX_SEGMENTS 后重跑');
  }
  if ((report.errors || []).length) {
    lines.push('错误：' + report.errors.slice(0, 3).join(' | ').slice(0, 300));
  }
  lines.push('详细结果见 SmokeInput!A3 起。');
  return lines.join('\n');
}

function writeFullPipelineReport_(sh, report) {
  var startRow = 3;
  var rows = [['阶段/对象', '状态', '详情']];

  (report.stages || []).forEach(function(s) {
    rows.push([s.stage, s.status, String(s.detail || '') + ' @' + Number(s.elapsed_ms || 0) + 'ms']);
  });

  rows.push(['--- 汇总 ---', '', '']);
  rows.push(['elapsed_ms', String(report.elapsed_ms || 0), '']);
  rows.push(['spec_saved', String(report.spec_saved || 0), '']);
  rows.push(['ai_calls', String((report.tokens || {}).ai_calls || 0), '']);
  rows.push([
    'tokens',
    'in=' + Number((report.tokens || {}).input_tokens || 0),
    'out=' + Number((report.tokens || {}).output_tokens || 0)
  ]);
  rows.push(['ok', report.ok ? 'true' : 'false', report.error || '']);

  rows.push(['--- 本次分块 ---', '', '']);
  (report.segments || []).forEach(function(s) {
    rows.push([
      s.segment_id || '',
      String(s.type || ''),
      '【' + String(s.section || '') + '】' + Number(s.chars || 0) + ' 字 / ~'
        + Number(s.tokens_est || 0) + ' tokens'
    ]);
  });

  (report.errors || []).forEach(function(e, i) {
    rows.push(['error-' + (i + 1), 'fail', e]);
  });

  var requiredRows = startRow + rows.length - 1;
  if (sh.getMaxRows() < requiredRows) {
    sh.insertRowsAfter(sh.getMaxRows(), requiredRows - sh.getMaxRows());
  }
  sh.getRange(startRow, 1, rows.length, 3).setValues(rows);
}