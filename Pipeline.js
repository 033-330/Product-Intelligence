/* ============================================================
 * Pipeline.gs — 入库管道(累计模式:只增不删,判重跳过)
 *
 * 数据模型:
 *   - 任何已写入的行永远不会被删除
 *   - 同一内容重复处理时,按唯一键判重并跳过
 *   - 文件更新后重跑:已有行跳过,新增/变化的部分追加
 *   - Top N Topics = 全历史(或指定窗口)mention_count 累计降序
 * ============================================================ */

/* ---------- Issue / Document 登记(存在则复用) ---------- */

function ensureIssue_(issueNo, date, rawRef) {
  const rows = readTable('Issues');
  const hit = rows.find(r => String(r.issue_no) === String(issueNo));
  if (hit) return hit;
  appendRow('Issues', {
    issue_no: issueNo, date: date || '', raw_text_ref: rawRef || '',
    status: 'published', created_at: new Date().toISOString(),
  });
  return readTable('Issues').find(r => String(r.issue_no) === String(issueNo));
}

/**
 * Document 按 (issue_no, url, title) 复用:
 * 已存在 → 原位更新 text/评论数(修改,不删除);不存在 → 新建
 */
function upsertDocument_(issueNo, seg, fallbackDate) {
  const rows = readTable('Documents');
  const segId = String(seg.segment_id || '');
  const legacyKey = r => String(r.issue_no) === String(issueNo)
      && String(r.url || '') === String(seg.url || '')
      && String(r.title || '') === String(seg.title || '');
  const existing = (segId && rows.filter(function(r) {
    return String(r.segment_id || '') === segId;
  })[0]) || rows.filter(legacyKey)[0];
  const text = String(seg.text || '');
  const extra = {
    segment_id: segId,
    content_hash: String(seg.content_hash || ''),
    parent_section: String(seg.parent_section || ''),
    start_offset: seg.start_offset != null ? seg.start_offset : '',
    end_offset: seg.end_offset != null ? seg.end_offset : '',
    segment_type: String(seg.segment_type || ''),
  };
  if (existing) {
    const sh = sheet_('Documents');
    const rowIdx = rows.indexOf(existing) + 2;
    const set = (col, val) => {
      const colIdx = SHEET_DEFS.Documents.indexOf(col);
      if (colIdx >= 0) sh.getRange(rowIdx, colIdx + 1).setValue(val);
    };
    set('text', text.slice(0, 45000));
    set('char_count', text.length);
    Object.keys(extra).forEach(function(k) { set(k, extra[k]); });
    if (seg.comment_count != null) set('comment_count', seg.comment_count);
    return existing;
  }
  appendRow('Documents', {
    doc_id: nextId('DOC', 'Documents', 'doc_id'),
    issue_no: issueNo,
    platform: seg.platform || '',
    source_type: seg.source_type || '',
    title: seg.title || '',
    url: seg.url || '',
    author: seg.author || '',
    published_at: seg.published_at || fallbackDate || '',
    comment_count: seg.comment_count != null ? seg.comment_count : '',
    char_count: text.length,
    text: text.slice(0, 45000),
    created_at: new Date().toISOString(),
    segment_id: extra.segment_id,
    content_hash: extra.content_hash,
    parent_section: extra.parent_section,
    start_offset: extra.start_offset,
    end_offset: extra.end_offset,
    segment_type: extra.segment_type,
  });
  return readTable('Documents').find(legacyKey);
}

/* ---------- 判重集合(本次运行内有效,随写随加) ---------- */

function buildDedupSets_() {
  const s = {
    needs: new Set(), comps: new Set(), feedback: new Set(),
    discussions: new Set(), needRows: {}
  };

  readTable('Feedback').forEach(function(f) {
    s.feedback.add([
      f.doc_id, f.product_id, f.topic_id, String(f.quote || '').slice(0, 30)
    ].join('|'));
  });

  // 通过表头名称读取 UserNeeds，避免依赖固定列顺序。
  const sh = sheet_('UserNeeds');
  const values = sh.getDataRange().getValues();
  const headers = values.length ? values[0].map(function(h) { return String(h).trim(); }) : [];
  const ix = {};
  headers.forEach(function(h, i) { ix[h] = i; });
  ['doc_id', 'product_id', 'evidence_quote', 'need_type'].forEach(function(h) {
    if (ix[h] == null) throw new Error('UserNeeds 表缺少必要列：' + h);
  });

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[ix.doc_id] || !row[ix.product_id]) continue;
    const key = [row[ix.doc_id], row[ix.product_id], String(row[ix.evidence_quote] || '').slice(0, 30)].join('|');
    s.needs.add(key);
    s.needRows[key] = { row: i + 1 };
  }

  readTable('Competitors').forEach(function(c) {
    s.comps.add([c.doc_id, c.product_id, c.competitor_id].join('|'));
  });

  try {
    readTable('General_Discussions').forEach(function(d) {
      if (d.content_hash) s.discussions.add(String(d.content_hash));
    });
  } catch (e) {}
  return s;
}

/* ---------- 实体解析(与上一版相同的三级消重) ---------- */

function buildAliasIndex_() {
  const idx = {};
  readTable('ProductAliases').forEach(r => { idx[String(r.normalized)] = r.product_id; });
  return idx;
}

function isLikelyProductEntity_(name) {
  var s = String(name || '').trim();
  if (!s) return false;
  var lower = s.toLowerCase();

  // 明显非产品实体：纯品牌名
  if (/^(logitech|logitech\s*g|razer|corsair|steelseries|hyperx|keychron|wooting|asus|msi|dell|alienware|hp|lenovo|sony|bose|sennheiser|jbl|audio-technica|shure|apple|microsoft)$/i.test(s)) {
    return false;
  }

  // 明显非产品实体：品类名
  if (/(^|[\s\/\-\(])?(鼠标|键盘|耳机|耳塞|入耳式|头戴式|游戏耳机|鼠标垫|轨迹球|游戏手柄|方向盘|键鼠套装|配件|外设)([\s\/\-\)\,\.]|$)/.test(s)) {
    // 但如果同时包含明显型号（带数字或常见型号后缀）则放行
    if (!/[a-z]{1,4}\d{2,4}|gpw|gpro|pro\s*x|ultra|se|tkl|max|mini|plus|v\d/i.test(s)) {
      return false;
    }
  }

  // 明显非产品实体：功能/技术名
  if (/(光学微动|电磁微动|霍尔效应微动|磁轴|光轴|类磁轴|tactile|linear|clicky|hypershift|hero\s*sensor|focus\s*pro|焦点|陀螺仪|陀螺|转向辅助|自适应触发|杜比全景声|空间音频|主动降噪|环境音)/i.test(s)) {
    return false;
  }

  // 过短且全字母且无数字：大概率不是具体型号
  if (/^[a-z\s]{2,8}$/i.test(s) && !/\d/.test(s)) {
    return false;
  }

  // 纯中文且无常见英文型号且无数字：大概率是描述而不是具体型号
  if (/^[\u4e00-\u9fa5\s]{2,12}$/i.test(s) && !/[a-z0-9]/i.test(s)) {
    return false;
  }

  return true;
}

/** 仅用于生成候选名称：剥离 AI 标注后缀与多余空白，不代表名称已可信。 */
function cleanProductName_(name) {
  return String(name || '')
    .replace(/\s*[(（]\s*(?:hypothetical|假设|推测|猜测|未知|tentative|placeholder|未确认)\s*[)）]\s*/gi, '')
    .replace(/\s*[(（]\s*[^)）]*(?:hypothetical|假设|推测|猜测|未知|tentative|placeholder|未确认)[^)）]*\s*[)）]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 产品名称写入前强制校验（V2.1 P0-2）。
 * 返回 { ok, name, reason, existingId?, source }。
 * sourceText 为空时跳过“必须出现在原文”的校验，仅保留实体类型与重复校验。
 */
function validateProductNameBeforeWrite_(candidate, opts) {
  opts = opts || {};
  const written = String(opts.nameAsWritten || candidate || '').trim();
  const guess = String(opts.canonicalGuess || '').trim();
  const sourceText = String(opts.sourceText || '');
  const selfId = String(opts.selfProductId || '');
  const existing = opts.existingProducts || readTable('Products');

  // 原始候选里出现 AI 标注后缀，直接拒绝，不能先清洗再判断。
  if (/[(（]\s*(?:hypothetical|假设|推测|猜测|未知|tentative|placeholder|未确认)\s*[)）]/i.test(String(candidate || ''))) {
    return { ok: false, name: cleanProductName_(candidate), reason: '名称含 AI 标注后缀' };
  }

  const cleaned = cleanProductName_(candidate);
  if (!cleaned) return { ok: false, name: '', reason: '名称为空' };
  if (cleaned.length > 80) return { ok: false, name: cleaned, reason: '名称过长（>80 字符）' };
  if (/[<>]|https?:\/\//i.test(cleaned)) return { ok: false, name: cleaned, reason: '名称含 HTML 或 URL' };
  if (!isLikelyProductEntity_(cleaned)) {
    return { ok: false, name: cleaned, reason: '疑似品牌名/品类名/功能名/技术名' };
  }

  // 原文可追溯：name_as_written 或 canonical_guess 至少一个能在原文中找到。
  let source = 'no_source_check';
  if (sourceText) {
    const hay = normalizeAlias(sourceText);
    const writtenHit = written && hay.indexOf(normalizeAlias(written)) >= 0;
    const guessHit = guess && hay.indexOf(normalizeAlias(guess)) >= 0;
    if (!writtenHit && !guessHit) {
      return { ok: false, name: cleaned, reason: '名称未在原文中出现，无法追溯' };
    }
    source = writtenHit ? 'name_as_written' : 'canonical_guess_in_source';
  }

  // 与现有产品同名：交给上层复用字典中的 canonical_name，不新建、不覆盖。
  const dup = existing.filter(function(p) {
    return String(p.product_id) !== selfId
      && normalizeAlias(p.canonical_name) === normalizeAlias(cleaned);
  })[0];
  if (dup) {
    return { ok: false, name: cleaned, reason: '与现有产品同名', existingId: String(dup.product_id) };
  }

  return { ok: true, name: cleaned, reason: '通过', source: source };
}

function matchProductRule_(name, aliasIndex) {
  // 仅精确匹配:子串匹配会把 GPW5 误并入 GPW5 Ultra、PRO X 3 误并入鼠标
  var candidate = String(name || '').trim();
  if (!isLikelyProductEntity_(candidate)) {
    return null;
  }
  const norm = normalizeAlias(candidate);
  return norm ? (aliasIndex[norm] || null) : null;
}

/** 品牌名归一 */
function normalizeBrand_(b) {
  const map = CONFIG.BRAND_SYNONYMS || {};
  const key = String(b || '').trim();
  return map[key] || key;
}

function addAlias_(alias, productId) {
  const norm = normalizeAlias(alias);
  if (!norm) return;
  const dup = readTable('ProductAliases').some(r => r.normalized === norm);
  if (!dup) {
    appendRow('ProductAliases', {
      alias: alias, product_id: productId, normalized: norm,
      created_at: new Date().toISOString(),
    });
  }
}

function createProduct_(name, brand, category, issueNo, opts) {
  opts = opts || {};
  const id = nextId('PROD', 'Products', 'product_id');
  appendRow('Products', {
    product_id: id,
    canonical_name: name,
    brand: normalizeBrand_(brand),
    category: category || 'unknown',
    first_seen_issue: issueNo,
    status: 'auto',
    created_at: new Date().toISOString(),
    official_url: '',
    official_url_status: 'pending',
    official_url_checked_at: '',
    official_url_notes: opts.nameSource ? ('name_source=' + opts.nameSource) : '',
  });
  addAlias_(name, id);
  if (opts.nameAsWritten && normalizeAlias(opts.nameAsWritten) !== normalizeAlias(name)) {
    addAlias_(opts.nameAsWritten, id);
  }
  // P0-1：创建后立即进入异步 URL 验证队列，不在写入路径同步抓取。
  if (typeof enqueueUrlVerificationTask_ === 'function') {
    try {
      enqueueUrlVerificationTask_(id, '', 3);
    } catch (e) {
      Logger.log('URL 验证任务入队失败：' + String(e));
    }
  }
  return id;
}

function resolveProducts_(extracts, issueNo, sourceText) {
  const aliasIndex = buildAliasIndex_();
  const unresolved = [];
  const filtered = [];
  (extracts || []).forEach(function(x) {
    var name = x && x.name_as_written ? String(x.name_as_written).trim() : '';
    if (!name || !isLikelyProductEntity_(name)) {
      // 跳过明显的品牌名、品类名、功能名、技术名
      return;
    }
    filtered.push(x);
  });

  filtered.forEach(x => {
    const hit = matchProductRule_(x.name_as_written, aliasIndex);
    if (hit) { x.product_id = hit; addAlias_(x.name_as_written, hit); }
    else unresolved.push(x);
  });

  if (unresolved.length) {
    const mapping = callAI(
      buildResolvePrompt_(unresolved.map(u => u.name_as_written), readTable('ProductAliases')),
      RESOLVE_SCHEMA
    ).mapping || [];
    const mapByName = {};
    mapping.forEach(m => { mapByName[m.name] = m; });

    // 产品库快照:Gemini 返回的 ID 必须真实存在,否则视为幻觉按 NEW 处理(空库时尤其重要)
    const productRows = readTable('Products');
    const validIds = {};
    productRows.forEach(p => validIds[p.product_id] = 1);

    unresolved.forEach(x => {
      var xname = String(x.name_as_written || '').trim();
      if (!isLikelyProductEntity_(xname)) {
        return;
      }
      const m = mapByName[xname];
      const geminiId = (m && m.product_id) || '';
      if (geminiId && geminiId !== 'NEW' && validIds[geminiId]) {
        x.product_id = geminiId;
        addAlias_(xname, geminiId);
        return;
      }
      if (geminiId && geminiId !== 'NEW' && !validIds[geminiId]) {
        enqueuePending_('product', x, 'Gemini 返回了不存在的 ' + geminiId + ',已按新品处理');
      } else if (!m) {
        enqueuePending_('product', x, 'Gemini 未返回映射:' + xname);
      }

      // P0-2：名称写入前强制校验。原文名优先，AI canonical 仅作为候选。
      var aiCanonical = String((m && m.canonical_name) || x.canonical_guess || '').trim();
      var verdict = validateProductNameBeforeWrite_(xname, {
        nameAsWritten: xname,
        canonicalGuess: aiCanonical,
        sourceText: sourceText || '',
        existingProducts: productRows
      });

      // 与现有产品同名：复用它，绝不覆盖字典里的 canonical_name。
      if (verdict.existingId) {
        x.product_id = verdict.existingId;
        addAlias_(xname, verdict.existingId);
        return;
      }

      // 原文名不通过时，只有当 AI 建议名也能在原文中追溯，才允许改用建议名。
      if (!verdict.ok && aiCanonical && aiCanonical !== xname) {
        var alt = validateProductNameBeforeWrite_(aiCanonical, {
          nameAsWritten: xname,
          canonicalGuess: aiCanonical,
          sourceText: sourceText || '',
          existingProducts: productRows
        });
        if (alt.ok && alt.source === 'canonical_guess_in_source') verdict = alt;
        else if (alt.existingId) {
          x.product_id = alt.existingId;
          addAlias_(xname, alt.existingId);
          return;
        }
      }

      if (!verdict.ok) {
        enqueuePending_('product_name_rejected', {
          name_as_written: xname,
          ai_canonical: aiCanonical,
          brand: x.brand_guess || '',
          category: x.category_guess || '',
          evidence: String(x.evidence || '').slice(0, 300)
        }, verdict.reason);
        return;
      }

      x.product_id = createProduct_(
        verdict.name,
        (m && m.brand) || x.brand_guess || '',
        (m && m.category) || x.category_guess || 'unknown',
        issueNo,
        { nameAsWritten: xname, nameSource: verdict.source }
      );
      if (x.product_id) addAlias_(xname, x.product_id);
    });
  }
  return new Set(filtered.map(x => x.product_id).filter(Boolean));
}

/* ---------- 话题名规范（2-6 个字） ---------- */

function normalizeTopicName_(name) {
  var s = String(name || '').trim();
  if (!s) return '';
  s = s.replace(/[\r\n\t]/g, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/[（(][^（）()]*[）)]/g, '');
  s = s.replace(/[【\[][^\[\]】]*[】\]]/g, '');
  s = s.replace(/话题|讨论|问题|体验|感受|评价|吐槽|分析|总结|看法|反馈/g, '');
  if (s.indexOf('：') >= 0) s = s.split('：')[0];
  if (s.indexOf(':') >= 0) s = s.split(':')[0];
  if (s.indexOf('-') >= 0 && s.length > 6) {
    var p = s.split('-');
    if (p[0] && p[0].length >= 2) s = p[0];
  }
  if (s.length > 6) s = s.slice(0, 6);
  if (s.length < 2) {
    s = String(name || '').replace(/\s+/g, '').slice(0, 6);
  }
  return s;
}

function ensureShortTopicName_(name) {
  var n = normalizeTopicName_(name);
  if (n.length >= 2 && n.length <= 6) return n;
  if (n.length > 6) return n.slice(0, 6);
  var fallback = String(name || '').replace(/\s+/g, '').slice(0, 6);
  return fallback.length >= 2 ? fallback : '其他';
}

function createTopic_(name, productId) {
  var shortName = ensureShortTopicName_(name);
  const id = nextId('TOP', 'Topics', 'topic_id');
  appendRow('Topics', {
    topic_id: id,
    product_id: productId || '',
    name: shortName,
    keywords: '',
    created_at: new Date().toISOString(),
    auto_created: 'yes',
    status: '',
  });
  return id;
}

/**
 * 批量话题消重(话题身份 = product_id + name,按产品隔离):
 * 规范化精确匹配(限同产品)→ 高相似度(0.75)归并(限同产品)→ Gemini 批量判定 → 新建
 * 返回 { 话题名 -> { topic_id, summary } }
 */
function resolveTopicsBatch_(names, productId) {
  // 匹配池:该产品的话题 + 历史遗留的无归属话题(product_id 为空,迁移期兼容)
  const topics = readTable('Topics').filter(t => t.status !== 'merged'
    && (String(t.product_id || '') === String(productId) || String(t.product_id || '') === ''));
  const byNorm = {};
  topics.forEach(t => byNorm[normalizeAlias(t.name)] = t);
  const result = {};
  const unresolved = [];
  const borderline = []; // 模糊地带(0.55-0.75):由 Gemini 裁决,不再进人工队列

  names.forEach(n => {
    const norm = normalizeAlias(n);
    if (byNorm[norm]) { result[n] = { topic_id: byNorm[norm].topic_id, summary: '' }; return; }
    let best = null, bs = 0;
    topics.forEach(t => { const s = bigramSim_(n, t.name); if (s > bs) { bs = s; best = t; } });
    if (best && bs >= 0.75) { result[n] = { topic_id: best.topic_id, summary: '' }; return; }
    if (best && bs >= 0.55 && String(best.product_id || '') === String(productId || '')) {
      borderline.push({ name: n, candidate_id: best.topic_id, candidate_name: best.name, score: bs });
      return; // 暂挂起,等 Gemini 裁决
    }
    unresolved.push({ name: n, best: best ? best.name : '', score: bs });
  });

  // 模糊地带批量裁决:一次 Gemini 调用判定所有边界对
  if (borderline.length) {
    const productName = (readTable('Products').find(p => p.product_id === productId) || {}).canonical_name || productId;
    let verdicts = [];
    try {
      verdicts = callAI(buildTopicVerifyPrompt_(borderline, productName), TOPIC_VERIFY_SCHEMA).verdicts || [];
    } catch (e) {
      verdicts = []; // 调用失败则全部按新建处理
    }
    const byName = {};
    verdicts.forEach(v => byName[v.name] = v);
    borderline.forEach(b => {
      const v = byName[b.name];
      if (v && v.same === true) {
        result[b.name] = { topic_id: b.candidate_id, summary: '' };
        enqueuePending_('topic_merged_by_ai', { topic: b.name, into: b.candidate_id, score: b.score },
          'AI 自动合并(相似度 ' + b.score.toFixed(2) + ')');
      } else {
        unresolved.push({ name: b.name, best: b.candidate_name, score: b.score });
      }
    });
  }

  if (unresolved.length) {
    const productName = (readTable('Products').find(p => p.product_id === productId) || {}).canonical_name || productId;
    const mapping = callAI(
      buildTopicResolvePrompt_(unresolved.map(u => u.name), topics, productName),
      TOPIC_RESOLVE_SCHEMA
    ).mapping || [];
    const byName = {};
    mapping.forEach(m => byName[m.name] = m);
    unresolved.forEach(u => {
      const m = byName[u.name];
      if (m && m.topic_id && m.topic_id !== 'NEW') { result[u.name] = { topic_id: m.topic_id, summary: '' }; return; }
      if (!m && u.best && u.score >= 0.4) {
        enqueuePending_('topic_merge_reviewed', { new_topic: u.name, similar_to: u.best, score: u.score },
          'AI 已复核:不合并,新建话题(与「' + u.best + '」相似度 ' + u.score.toFixed(2) + ')');
      }
      var finalTopicName = ensureShortTopicName_(u.name);
      result[u.name] = { topic_id: createTopic_(finalTopicName, productId), summary: '' };
    });
  }
  return result;
}

function enqueuePending_(type, payload, reason) {
  appendRow('PendingQueue', {
    item_id: nextId('PEN', 'PendingQueue', 'item_id'),
    item_type: type,
    payload_json: JSON.stringify(payload).slice(0, 2000),
    reason: reason,
    status: 'open',
    created_at: new Date().toISOString(),
  });
}

/* ---------- 单 Document 入库(判重,只增不删) ---------- */

function writeDocumentExtraction_(doc, ext, issueNo, dedup, stats) {
  const now = new Date().toISOString();
  const products = ext.products || [];
  resolveProducts_(products, issueNo, String(doc.text || ''));

  // 批量话题消重:按产品分批(话题身份 = product_id + name,产品之间完全隔离)
  const topicMap = {};
  const namesByProduct = {};
  products.forEach(p => (p.topics || []).forEach(t => {
    if (t.evidence) (namesByProduct[p.product_id] = namesByProduct[p.product_id] || []).push(t.name);
  }));
  Object.keys(namesByProduct).forEach(pid => {
    const resolved = resolveTopicsBatch_(namesByProduct[pid], pid);
    Object.keys(resolved).forEach(n => { topicMap[pid + '|' + n] = resolved[n]; });
  });

  // 话题摘要回填:首选该文档中此话题第一次出现处的摘要
  const topicSummaries = {};
  products.forEach(p => (p.topics || []).forEach(t => {
    if (t.evidence && t.topic_summary && !topicSummaries[t.name]) {
      topicSummaries[t.name] = String(t.topic_summary).slice(0, 500);
    }
  }));

  // Topics 行快照:topic_id -> {行号, 已有摘要}(摘要统一存 Topics.summary)
  const topicRowMap = {};
  {
    const tvals = sheet_('Topics').getDataRange().getValues();
    for (let i = 1; i < tvals.length; i++) {
      if (!tvals[i][0]) continue;
      const topicHeaders = tvals[0].map(function(h) { return String(h).trim(); });
      const summaryIdx = topicHeaders.indexOf('summary');
      topicRowMap[tvals[i][0]] = { row: i + 1, hasSummary: summaryIdx >= 0 && !!tvals[i][summaryIdx] };
    }
  }

  products.forEach(p => {
    (p.topics || []).forEach(t => {
      if (!t.evidence) return; // 无证据不入库 — 硬规则
      const topicId = topicMap[p.product_id + '|' + t.name].topic_id;
      // 摘要写入 Topics.summary(首个非空为准)
      const sum = String(topicSummaries[t.name] || '');
      const trow = topicRowMap[topicId];
      if (sum && trow && !trow.hasSummary) {
        const summaryCol = SHEET_DEFS.Topics.indexOf('summary') + 1;
        if (summaryCol < 1) throw new Error('SHEET_DEFS.Topics 缺少 summary 列');
        sheet_('Topics').getRange(trow.row, summaryCol).setValue(sum);
        trow.hasSummary = true;
        stats.updated = (stats.updated || 0) + 1;
      }
      // 反馈级明细:一条 = 一条独立反馈(mentions 语义由 Feedback 承担)
      (t.feedback || []).forEach(f => {
        if (!f.quote) return;
        const fbKey = [doc.doc_id, p.product_id, topicId, String(f.quote).slice(0, 30)].join('|');
        if (dedup.feedback.has(fbKey)) { stats.skipped++; return; }
        dedup.feedback.add(fbKey);
        appendRow('Feedback', {
          feedback_id: nextId('FB', 'Feedback', 'feedback_id'),
          doc_id: doc.doc_id,
          product_id: p.product_id,
          topic_id: topicId,
          sentiment: ['positive', 'negative', 'neutral', 'unknown'].indexOf(f.sentiment) !== -1 ? f.sentiment : 'unknown',
          sentiment_confidence: f.confidence || '',
          quote: String(f.quote).slice(0, 300),
          created_at: now,
        });
        stats.added++;
      });
    });

    (p.user_needs || []).forEach(n => {
      if (!n.evidence) return;
      const key = [doc.doc_id, p.product_id, String(n.evidence).slice(0, 30)].join('|');
      if (dedup.needs.has(key)) {
        const oldRow = dedup.needRows && dedup.needRows[key];
        const nt = n.need_type === 'evaluation' ? 'evaluation' : 'need';
        if (oldRow) sheet_('UserNeeds').getRange(oldRow.row, SHEET_DEFS.UserNeeds.indexOf('need_type') + 1).setValue(nt);
        stats.skipped++; return;
      }
      dedup.needs.add(key);
      appendRow('UserNeeds', {
        need_id: nextId('NEED', 'UserNeeds', 'need_id'),
        product_id: p.product_id,
        category: n.category || '',
        need_type: n.need_type === 'evaluation' ? 'evaluation' : 'need',
        description: n.description || '',
        evidence_quote: String(n.evidence).slice(0, 300),
        doc_id: doc.doc_id,
        created_at: now,
      });
      stats.added++;
    });

    (p.competitor_mentions || []).forEach(c => {
      if (!c.evidence) return;
      const tmp = [{ name_as_written: c.name_as_written }];
      resolveProducts_(tmp, issueNo, String(doc.text || ''));
      if (tmp[0].product_id === p.product_id) { stats.skipped++; return; } // 自环比无意义
      const key = [doc.doc_id, p.product_id, tmp[0].product_id].join('|');
      if (dedup.comps.has(key)) { stats.skipped++; return; }
      dedup.comps.add(key);
      appendRow('Competitors', {
        row_id: nextId('CMP', 'Competitors', 'row_id'),
        product_id: p.product_id,
        competitor_id: tmp[0].product_id,
        dimensions: (c.dimensions || []).join('、'),
        context_summary: (c.competitor_summary || c.stance || '') + ' | ' + String(c.evidence).slice(0, 200),
        stance: c.stance || '',
        doc_id: doc.doc_id,
        created_at: now,
      });
      stats.added++;
    });
  });

  // P0-4：General_Discussions 直接复用 Pass A 输出，不再调用 AI 重新总结。
  (ext.general_discussion || []).forEach(function(gd) {
    const evidence = String((gd && gd.evidence) || '').trim();
    const title = String((gd && (gd.topic || gd.title)) || '').trim();
    const summary = String((gd && gd.summary) || '').trim();
    if (!evidence || (!title && !summary)) { stats.skipped++; return; }

    const hash = [doc.doc_id, normalizeAlias(title), normalizeAlias(evidence).slice(0, 120)].join('|');
    if (dedup.discussions && dedup.discussions.has(hash)) { stats.skipped++; return; }
    if (dedup.discussions) dedup.discussions.add(hash);

    // 只在唯一命中本次已解析产品时关联，绝不强行归属。
    const hay = normalizeAlias(title + ' ' + summary + ' ' + evidence);
    const hits = products.filter(function(p) {
      const n = normalizeAlias(p.name_as_written || '');
      return n && hay.indexOf(n) >= 0;
    });
    const related = hits.length === 1 && hits[0].product_id ? String(hits[0].product_id) : '';
    const sentiment = String((gd && gd.sentiment) || '').toLowerCase();

    appendRow('General_Discussions', {
      discussion_id: nextId('DISC', 'General_Discussions', 'discussion_id'),
      issue_no: issueNo,
      document_id: doc.doc_id,
      discussion_type: String((gd && (gd.discussion_type || gd.type)) || 'industry_discussion'),
      title: title.slice(0, 200),
      summary: summary.slice(0, 1000),
      sentiment: ['positive', 'negative', 'neutral', 'unknown'].indexOf(sentiment) >= 0 ? sentiment : 'unknown',
      evidence: evidence.slice(0, 300),
      evidence_id: '',
      related_product_id: related,
      content_hash: hash,
      created_at: now,
    });
    stats.added++;
  });
}

/**
 * 结构感知分块（V2.1 P0-3）。
 * 纯代码识别标题/段落/列表/表格，在结构边界内按 Token 预算切分；
 * 结构不可用时回退到机械切块，保证任何文本都能处理。
 */
function buildDeterministicSegments_(file, text) {
  const name = file && file.getName ? file.getName() : 'text';
  const url = file && file.getUrl ? file.getUrl() : '';
  const version = String((CONFIG && CONFIG.SEGMENTER_VERSION) || 'v2');
  const documents = version === 'v1'
    ? mechanicalSegments_(text, name, url)
    : structuralSegments_(text, name, url);
  return { issue: {}, documents: documents, segmenter_version: version };
}

function estimateTokens_(s) {
  const text = String(s || '');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function contentHash_(s) {
  let h = 2166136261;
  const text = String(s || '');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

function makeSegment_(chunk, meta) {
  const hash = contentHash_(chunk);
  return {
    segment_id: 'SEG-' + meta.index + '-' + hash,
    title: meta.name + '｜' + (meta.section || '正文') + '｜分块 ' + String(meta.index).padStart(3, '0'),
    url: meta.url,
    text: chunk,
    parent_section: meta.section || '正文',
    start_offset: meta.start,
    end_offset: meta.end,
    content_hash: hash,
    segment_type: meta.type || 'paragraph',
  };
}

function mechanicalSegments_(text, name, url) {
  const src = String(text || '');
  const MAX_CHARS = Number((CONFIG && CONFIG.SEGMENT_MAX_CHARS) || 6000);
  const docs = [];
  let start = 0;
  let index = 1;

  while (start < src.length) {
    let end = Math.min(start + MAX_CHARS, src.length);
    if (end < src.length) {
      const newline = src.lastIndexOf('\n', end);
      if (newline > start + MAX_CHARS * 0.6) end = newline + 1;
      else {
        const nextNewline = src.indexOf('\n', end);
        if (nextNewline !== -1) end = nextNewline + 1;
      }
    }
    const chunk = src.slice(start, end);
    docs.push(makeSegment_(chunk, {
      name: name, url: url, index: index, section: '正文',
      start: start, end: end, type: 'paragraph'
    }));
    start = end;
    index++;
  }
  return docs;
}

/** 把文本解析成结构块（标题/段落/列表/表格），并保留字符偏移。 */
function parseTextBlocks_(text) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/);
  const lineOffsets = [0];
  for (let k = 0; k < lines.length; k++) lineOffsets.push(lineOffsets[k] + lines[k].length + 1);

  const blocks = [];
  function push(type, from, to) {
    const chunk = lines.slice(from, to).join('\n');
    if (!chunk.trim()) return;
    blocks.push({
      type: type,
      text: chunk.trim(),
      start: lineOffsets[from] || 0,
      end: lineOffsets[to] !== undefined ? lineOffsets[to] : src.length,
    });
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = String(line).trim();
    if (!trimmed) { i++; continue; }

    if (/^#{1,6}\s+/.test(trimmed) || /^【[^】]{1,40}】$/.test(trimmed)) {
      push('heading', i, i + 1);
      i++;
      continue;
    }

    if (trimmed.indexOf('|') >= 0) {
      let j = i;
      while (j < lines.length && String(lines[j]).trim().indexOf('|') >= 0) j++;
      push('table', i, j);
      i = j;
      continue;
    }

    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      let j = i;
      while (j < lines.length
        && (/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[j]) || String(lines[j]).trim() === '')) j++;
      push('list', i, j);
      i = j;
      continue;
    }

    let j = i;
    while (j < lines.length
      && String(lines[j]).trim() !== ''
      && !/^#{1,6}\s+/.test(String(lines[j]).trim())
      && !/^【[^】]{1,40}】$/.test(String(lines[j]).trim())
      && String(lines[j]).trim().indexOf('|') < 0
      && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[j])) j++;
    push('paragraph', i, j);
    i = j;
  }
  return blocks;
}

function dominantBlockType_(counts) {
  let best = 'paragraph';
  let n = 0;
  Object.keys(counts || {}).forEach(function(k) {
    if (k !== 'heading' && counts[k] > n) { best = k; n = counts[k]; }
  });
  return best;
}

/**
 * 超长单块切分。重叠内容加显式标记，Pass A 只把它当上下文，避免重复抽取。
 */
function splitLongBlock_(text, maxTokens, overlapChars) {
  const src = String(text || '');
  const paras = src.split(/\n{2,}/).filter(function(s) { return s.trim(); });
  if (!paras.length) return [src];

  const parts = [];
  let buf = '';
  paras.forEach(function(p) {
    if (buf && estimateTokens_(buf + '\n\n' + p) > maxTokens) {
      parts.push(buf);
      const tail = overlapChars > 0 ? buf.slice(-overlapChars).trim() : '';
      buf = tail
        ? '【上文衔接，仅供理解，不要重复抽取】\n' + tail + '\n\n' + p
        : p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  });
  if (buf.trim()) parts.push(buf);
  return parts.length ? parts : [src];
}

function structuralSegments_(text, name, url) {
  const src = String(text || '');
  const targetTokens = Number((CONFIG && CONFIG.SEGMENT_TARGET_TOKENS) || 2200);
  const maxTokens = Number((CONFIG && CONFIG.SEGMENT_MAX_TOKENS) || 3000);
  const overlapChars = Number((CONFIG && CONFIG.SEGMENT_OVERLAP_CHARS) || 0);

  const blocks = parseTextBlocks_(src);
  if (!blocks.length) return mechanicalSegments_(src, name, url);
  if (blocks.length === 1 && estimateTokens_(blocks[0].text) > maxTokens) {
    return mechanicalSegments_(src, name, url);
  }

  const docs = [];
  let index = 1;
  let section = '正文';
  let buf = '';
  let bufStart = 0;
  let bufEnd = 0;
  let bufTypes = {};

  function flush(sectionName) {
    if (!buf.trim()) { buf = ''; bufTypes = {}; return; }
    docs.push(makeSegment_(buf, {
      name: name, url: url, index: index, section: sectionName || section,
      start: bufStart, end: bufEnd, type: dominantBlockType_(bufTypes)
    }));
    index++;
    buf = '';
    bufTypes = {};
  }

  blocks.forEach(function(b) {
    if (b.type === 'heading') {
      flush(section);
      section = String(b.text).replace(/^[#\s]+/, '').trim() || section;
      buf = b.text + '\n\n';
      bufStart = b.start;
      bufEnd = b.end;
      bufTypes[b.type] = 1;
      return;
    }

    const pieceTokens = estimateTokens_(b.text);
    if (pieceTokens > maxTokens && b.type !== 'table') {
      flush(section);
      splitLongBlock_(b.text, maxTokens, overlapChars).forEach(function(part, i) {
        docs.push(makeSegment_(part, {
          name: name, url: url, index: index,
          section: section + (i > 0 ? '（续' + (i + 1) + '）' : ''),
          start: b.start, end: b.end, type: b.type
        }));
        index++;
      });
      return;
    }

    if (buf && estimateTokens_(buf + b.text) > targetTokens) flush(section);
    if (!buf) bufStart = b.start;
    buf += b.text + (b.type === 'table' ? '\n' : '\n\n');
    bufEnd = b.end;
    bufTypes[b.type] = (bufTypes[b.type] || 0) + 1;
  });
  flush(section);

  return docs.length ? docs : mechanicalSegments_(src, name, url);
}

/* ---------- 单文件处理主流程 ---------- */

function guessIssueNo_(fileName, text) {
  const m = String(fileName).match(/第\s*(\d+)\s*期/) || String(fileName).match(/issue\s*[-_]?\s*(\d+)/i);
  if (m) return m[1];
  const m2 = String(text).slice(0, 800).match(/第\s*(\d+)\s*期/);
  return m2 ? m2[1] : null;
}

/**
 * 处理一个 Drive 文件:
 *   Pass 0 拆 Documents → 登记 Issues/Documents → 逐段 Pass A → 判重写入
 * 已存在的数据不会删除,重复内容自动跳过。
 */
function processDriveFile_(file, opts) {
  opts = opts || {};
  const doneKeys = opts.doneKeys || new Set();
  const text = readFileText_(file) || '';
  if (text.trim().length < 1) {
    throw new Error('从「' + file.getName() + '」读取到的正文为空。请检查文件内容、权限及格式转换设置。');
  }
  Logger.log('全文提取完成：' + file.getName() + '；字符数=' + text.length);

  // 结构感知分块（V2.1 P0-3）
  const seg = buildDeterministicSegments_(file, text);

  // 期号与日期
  const issueNo = String((seg.issue && seg.issue.issue_no)
    || guessIssueNo_(file.getName(), text)
    || ('auto-' + Utilities.formatDate(file.getLastUpdated(), Session.getScriptTimeZone(), 'yyyyMMdd')));
  const issueDate = (seg.issue && seg.issue.date)
    || Utilities.formatDate(file.getLastUpdated(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  ensureIssue_(issueNo, issueDate, file.getUrl());

  // 逐 Document:登记 + Pass A + 写入(支持断点续跑、每轮上限与动态运行预算)
  const segs = seg.documents || [];
  const dedup = buildDedupSets_();
  const startedMs = Date.now();
  const budgetMs = Math.max(30000,
    Number(opts.budgetMs) || Number(CONFIG.DOC_RUN_BUDGET_MS) || 240000);
  const stats = { issue_no: issueNo, file: file.getName(),
                  source_chars: text.length,
                  segmenter_version: seg.segmenter_version || '',
                  docs_total: segs.length, docs_done: doneKeys.size,
                  added: 0, skipped: 0, updated: 0, errors: [], remaining: 0,
                  ai_calls: 0, input_tokens: 0, output_tokens: 0,
                  cache_hits: 0, elapsed_ms: 0, stopped_by_budget: false };
  let runCount = 0;
  for (let i = 0; i < segs.length; i++) {
    if (Date.now() - startedMs >= budgetMs) {
      stats.stopped_by_budget = true;
      break;  // 接近运行上限：主动停止，剩余的交给 60 秒续跑
    }
    const d = segs[i];
    const key = docKey_(d);
    if (doneKeys.has(key)) { stats.skipped++; continue; }   // 之前轮次已完成,连 Pass A 的 token 都省掉
    try {
      const docRow = upsertDocument_(issueNo, d, issueDate);
      const ext = callAI(buildPassAPrompt_(docRow, String(d.text || '')), PASS_A_SCHEMA, { maxTokens: 16384 });
      writeDocumentExtraction_(docRow, ext, issueNo, dedup, stats);
      doneKeys.add(key);
      runCount++;
      const diag = typeof getLastAiDiag_ === 'function' ? getLastAiDiag_() : null;
      if (diag) {
        stats.ai_calls++;
        stats.input_tokens += Number(diag.inputTokens || 0);
        stats.output_tokens += Number(diag.outputTokens || 0) + Number(diag.thoughts || 0);
      }
      Utilities.sleep(400); // 限速保护
    } catch (e) {
      const message = String(e).slice(0, 500);
      stats.errors.push({ title: d.title, error: message });
      // 错误队列写入失败不能掩盖原始分块失败，也不能把该分块标记为完成。
      try {
        enqueuePending_('doc_error', { issue: issueNo, title: d.title, url: d.url }, message);
      } catch (queueError) {
        Logger.log('写入 PendingQueue 失败：' + String(queueError));
      }
    }
    if (opts.maxDocs && runCount >= opts.maxDocs) break;    // 本轮额度用完,剩下的下轮继续
  }
  stats.docs_done = doneKeys.size;
  stats.remaining = segs.length - doneKeys.size;
  stats.elapsed_ms = Date.now() - startedMs;
  return stats;
}

/** Document 的稳定键：新分块用 segment_id，历史数据仍用 URL+标题。 */
function docKey_(seg) {
  if (seg && seg.segment_id) return 'seg:' + String(seg.segment_id);
  return normalizeAlias((seg.url || '') + '|' + (seg.title || ''));
}
