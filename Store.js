/* ============================================================
 * Store.gs — Sheets 数据访问层
 * ============================================================ */

const SHEET_DEFS = {
  Issues:       ['issue_no', 'date', 'raw_text_ref', 'status', 'created_at'],
  Documents:    ['doc_id', 'issue_no', 'platform', 'source_type', 'title', 'url', 'author',
                 'published_at', 'comment_count', 'char_count', 'text', 'created_at',
                 'segment_id', 'content_hash', 'parent_section', 'start_offset', 'end_offset', 'segment_type'],
  Products:     ['product_id', 'canonical_name', 'brand', 'category',
                 'first_seen_issue', 'status', 'created_at', 'official_url',
                 'official_url_status', 'official_url_checked_at', 'official_url_notes'],
  ProductSpecifications: ['spec_id', 'product_id', 'spec_key', 'spec_label', 'value', 'unit',
                 'raw_value', 'source_url', 'fetched_at', 'verification_status'],
  ProductSpecificationsRaw: ['raw_record_id', 'product_id', 'spec_key', 'source_url', 'source_type',
                 'raw_label', 'raw_value', 'raw_unit', 'normalized_value', 'normalized_unit',
                 'fetched_at', 'parser_name', 'verification_status', 'evidence_notes'],
  SpecificationDefinitions: ['spec_key', 'spec_label', 'category', 'subcategory', 'data_type',
                 'unit', 'allowed_values', 'is_common', 'is_comparable', 'comparison_group',
                 'normalization_rule', 'is_required', 'display_order', 'is_active', 'definition_notes'],
  SpecificationTasks: ['task_id', 'product_id', 'task_type', 'status', 'priority', 'attempt_count',
                 'max_attempts', 'next_attempt_at', 'created_at', 'started_at', 'finished_at',
                 'last_error', 'source_url', 'parser_version', 'task_notes'],
  ProductCategories: ['category_key', 'category_label', 'is_active', 'display_order'],
  ProductComponents: ['component_id', 'bundle_product_id', 'component_product_id', 'component_name',
                 'quantity', 'source_url', 'created_at'],

  ProductAliases: ['alias', 'product_id', 'normalized', 'created_at'],
  // 话题身份 = (product_id, name):同一话题名在不同产品下是不同实体
  Topics:       ['topic_id', 'product_id', 'name', 'keywords', 'summary', 'created_at', 'auto_created', 'status'],
  UserNeeds:    ['need_id', 'product_id', 'category', 'need_type', 'description', 'evidence_quote',
                 'doc_id', 'created_at'],
  Competitors:  ['row_id', 'product_id', 'competitor_id', 'dimensions', 'context_summary',
                 'stance', 'doc_id', 'created_at'],
  Events:       ['event_id', 'product_id', 'event_date', 'type', 'title', 'summary',
                 'doc_id', 'created_at'],
  PendingQueue: ['item_id', 'item_type', 'payload_json', 'reason', 'status', 'created_at'],

  /* --- V2.1 P0：行业讨论与非产品专属讨论（复用 Pass A 输出，不再二次调用 AI） --- */
  General_Discussions: ['discussion_id', 'issue_no', 'document_id', 'discussion_type', 'title',
                 'summary', 'sentiment', 'evidence', 'evidence_id', 'related_product_id',
                 'content_hash', 'created_at'],

  /* --- V2.1 P0：产品 URL 异步验证任务 --- */
  UrlVerificationTasks: ['task_id', 'product_id', 'url', 'status', 'priority', 'attempt_count',
                 'max_attempts', 'next_attempt_at', 'created_at', 'started_at', 'finished_at',
                 'last_error', 'result', 'notes', 'checked_at'],

  /* --- 反馈级明细:唯一事实表。一条 = 一条独立反馈,Topic 提及数 = 反馈条数 --- */
  Feedback:     ['feedback_id', 'doc_id', 'product_id', 'topic_id',
                 'sentiment', 'sentiment_confidence', 'quote', 'created_at'],
  ProcessedFiles: ['file_id', 'file_name', 'fingerprint', 'issue_no', 'status',
                 'progress', 'error', 'processed_at'],

  /* --- 物化视图:前端渲染专用,由 rebuildProductPages_() 每次同步后重建 --- */
  // 每产品 Top5 Topics(卡片取 rank 1-3,详情页取 1-5)
  PageTopics:   ['product_id', 'rank', 'topic_id', 'topic_name', 'summary',
                 'mention_count', 'sentiment', 'count_type',
                 'evidence_quote', 'evidence_source', 'evidence_url', 'evidence_platform',
                 'updated_at'],
  // 每产品关联竞品(含比较维度、比较摘要、代表引文)
  PageCompetitors: ['product_id', 'rank', 'competitor_id', 'competitor_name', 'dimensions',
                 'summary', 'evidence_quote', 'evidence_source', 'evidence_url', 'updated_at'],
};

function ss_() { return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('找不到工作表: ' + name + ' — 请先运行 setupSheets()');
  return sh;
}

function readTable(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  // 统一去掉表头前后空格，避免 product_id 、topic_id 等列名带空格时读不到字段。
  const headers = values[0].map(h => String(h == null ? '' : h).trim());
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row.join('')).trim() === '') continue;
    const o = {};
    headers.forEach((h, j) => o[h] = row[j]);
    out.push(o);
  }
  return out;
}

function appendRow(name, obj) {
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(headers.map(h => { const key = String(h == null ? '' : h).trim(); return obj[key] !== undefined && obj[key] !== null ? obj[key] : ''; }));
  return obj;
}

/** 整表重写(保留表头),用于按条件删除行 */
function rewriteTable_(name, keepRows) {
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.clearContents();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (keepRows.length) {
    sh.getRange(2, 1, keepRows.length, headers.length)
      .setValues(keepRows.map(r => headers.map(h => { const key = String(h == null ? '' : h).trim(); return r[key] !== undefined ? r[key] : ''; })));
  }
}

function nextId(prefix, sheetName, idCol) {
  let max = 0;
  readTable(sheetName).forEach(r => {
    const m = String(r[idCol] || '').match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

/** 别名规范化:小写、NFKC(全角转半角)、去空白与常见标点 */
function normalizeAlias(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\-_·.,;:!?'"()[\]\/\\]/g, '');
}

/** Dice 二元组相似度,用于 Topic 归并 */
function bigramSim_(a, b) {
  const grams = s => {
    s = String(s || '');
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(g => { if (B.has(g)) inter++; });
  return 2 * inter / (A.size + B.size);
}

/* ---------- 缓存(带索引,写入后可彻底清空) ---------- */

function cachePut_(key, obj) {
  const c = CacheService.getScriptCache();
  const idx = JSON.parse(c.get('cache_index') || '[]');
  if (idx.indexOf(key) === -1 && idx.length < 400) {
    idx.push(key);
    c.put('cache_index', JSON.stringify(idx), 21600);
  }
  c.put(key, JSON.stringify(obj), CONFIG.CACHE_SECONDS);
}

function cacheGet_(key) {
  const v = CacheService.getScriptCache().get(key);
  return v ? JSON.parse(v) : null;
}

function clearCache() {
  const c = CacheService.getScriptCache();
  const idx = JSON.parse(c.get('cache_index') || '[]');
  if (idx.length) c.removeAll(idx);
  c.put('cache_index', '[]', 21600);
}

/* ---------- 建表(幂等:缺表建表、缺列补列) ---------- */

function setupSheets() {
  const ss = ss_();
  Object.keys(SHEET_DEFS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SHEET_DEFS[name];
    const existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
      .filter(String);
    headers.forEach(h => {
      if (existing.indexOf(h) === -1) {
        sh.getRange(1, existing.length + 1).setValue(h);
        existing.push(h);
      }
    });
  });
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  try {
    if (typeof seedProductCategories_ === 'function') seedProductCategories_();
    if (typeof seedSpecificationDefinitions_ === 'function') seedSpecificationDefinitions_();
  } catch (e) {
    Logger.log('规格字典初始化失败：' + String(e));
  }
  return '建表完成(含新增列):' + Object.keys(SHEET_DEFS).join(', ');
}