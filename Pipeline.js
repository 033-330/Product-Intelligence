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
  const key = r => String(r.issue_no) === String(issueNo)
      && String(r.url || '') === String(seg.url || '')
      && String(r.title || '') === String(seg.title || '');
  const existing = rows.find(key);
  const text = String(seg.text || '');
  if (existing) {
    const sh = sheet_('Documents');
    const rowIdx = rows.indexOf(existing) + 2;
    const set = (col, val) => sh.getRange(rowIdx, SHEET_DEFS.Documents.indexOf(col) + 1).setValue(val);
    set('text', text.slice(0, 45000));
    set('char_count', text.length);
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
  });
  return readTable('Documents').find(key);
}

/* ---------- 判重集合(本次运行内有效,随写随加) ---------- */

function buildDedupSets_() {
  const s = {
    needs: new Set(), comps: new Set(), events: new Set(), feedback: new Set(),
    needRows: {}
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

  readTable('Events').forEach(function(ev) {
    s.events.add([
      ev.doc_id, ev.product_id,
      String(ev.type || '') + '|' + String(ev.title || '').slice(0, 12)
    ].join('|'));
  });
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

function createProduct_(name, brand, category, issueNo) {
  const id = nextId('PROD', 'Products', 'product_id');
  appendRow('Products', {
    product_id: id,
    canonical_name: name,
    brand: normalizeBrand_(brand),
    category: category || 'unknown',
    first_seen_issue: issueNo,
    status: 'auto',
    created_at: new Date().toISOString(),
  });
  addAlias_(name, id);
  return id;
}

function resolveProducts_(extracts, issueNo) {
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
    const validIds = {};
    readTable('Products').forEach(p => validIds[p.product_id] = 1);

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
      // 如果 AI 返回的 canonical_name/brand 看起来像品牌名或品类名，也要更谨慎，但仍按 NEW 创建
      x.product_id = createProduct_(
        (m && m.canonical_name) || x.canonical_guess || xname,
        (m && m.brand) || x.brand_guess || '',
        (m && m.category) || x.category_guess || 'unknown',
        issueNo
      );
      addAlias_(xname, x.product_id);
    });
  }
  return new Set(filtered.map(x => x.product_id).filter(Boolean));
}

function createTopic_(name, productId) {
  const id = nextId('TOP', 'Topics', 'topic_id');
  appendRow('Topics', {
    topic_id: id, product_id: productId || '', name: name, keywords: '',
    created_at: new Date().toISOString(), auto_created: 'yes', status: '',
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
      result[u.name] = { topic_id: createTopic_(u.name, productId), summary: '' };
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
  resolveProducts_(products, issueNo);

  // 事件涉及的产品名也解析
  const eventProducts = {};
  (ext.events || []).forEach(ev => {
    if (!ev.product_name) return;
    let src = products.find(p => normalizeAlias(p.name_as_written) === normalizeAlias(ev.product_name));
    let pid = src ? src.product_id : matchProductRule_(ev.product_name, buildAliasIndex_());
    if (!pid) {
      const tmp = [{ name_as_written: ev.product_name }];
      resolveProducts_(tmp, issueNo);
      pid = tmp[0].product_id;
    }
    eventProducts[ev.product_name] = pid;
  });

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
      resolveProducts_(tmp, issueNo);
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

  (ext.events || []).forEach(ev => {
    const pid = eventProducts[ev.product_name];
    if (!pid) return;
    const key = [doc.doc_id, pid, (ev.type || '') + '|' + String(ev.title || '').slice(0, 12)].join('|');
    if (dedup.events.has(key)) { stats.skipped++; return; }
    dedup.events.add(key);
    appendRow('Events', {
      event_id: nextId('EVT', 'Events', 'event_id'),
      product_id: pid,
      event_date: ev.event_date || '',
      type: ev.type || '',
      title: ev.title || '',
      summary: ev.summary || '',
      doc_id: doc.doc_id,
      created_at: now,
    });
    stats.added++;
  });
}

function buildDeterministicSegments_(file, text) {
  const MAX_CHARS = 6000;
  const documents = [];
  let start = 0;
  let index = 1;

  while (start < text.length) {
    let end = Math.min(start + MAX_CHARS, text.length);

    if (end < text.length) {
      // 优先在当前块后 40% 范围内寻找换行
      const newline = text.lastIndexOf('\n', end);

      if (newline > start + MAX_CHARS * 0.6) {
        end = newline + 1;
      } else {
        // 如果当前范围内没有合适的换行，向后寻找
        const nextNewline = text.indexOf('\n', end);

        if (nextNewline !== -1) {
          end = nextNewline + 1;
        }
      }
    }

    const chunk = text.slice(start, end);

    documents.push({
      title: file.getName() +
        '｜原文分块 ' + String(index).padStart(3, '0'),
      url: file.getUrl(),
      text: chunk
    });

    start = end;
    index++;
  }

  return {
    issue: {},
    documents: documents
  };
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

  // Pass 0:Gemini 拆分
  const seg = buildDeterministicSegments_(file, text);


  // 分块函数已移至文件顶层，供测试函数和主流程共同调用。



  // 期号与日期
  const issueNo = String((seg.issue && seg.issue.issue_no)
    || guessIssueNo_(file.getName(), text)
    || ('auto-' + Utilities.formatDate(file.getLastUpdated(), Session.getScriptTimeZone(), 'yyyyMMdd')));
  const issueDate = (seg.issue && seg.issue.date)
    || Utilities.formatDate(file.getLastUpdated(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  ensureIssue_(issueNo, issueDate, file.getUrl());

  // 逐 Document:登记 + Pass A + 写入(支持断点续跑与每轮上限)
  const segs = seg.documents || [];
  const dedup = buildDedupSets_();
  const stats = { issue_no: issueNo, file: file.getName(),
                  source_chars: text.length,
                  docs_total: segs.length, docs_done: doneKeys.size,
                  added: 0, skipped: 0, updated: 0, errors: [], remaining: 0 };
  let runCount = 0;
  for (let i = 0; i < segs.length; i++) {
    const d = segs[i];
    const key = docKey_(d);
    if (doneKeys.has(key)) { stats.skipped++; continue; }   // 之前轮次已完成,连 Pass A 的 token 都省掉
    try {
      const docRow = upsertDocument_(issueNo, d, issueDate);
      const ext = callAI(buildPassAPrompt_(docRow, String(d.text || '')), PASS_A_SCHEMA, { maxTokens: 16384 });
      writeDocumentExtraction_(docRow, ext, issueNo, dedup, stats);
      doneKeys.add(key);
      runCount++;
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
  return stats;
}

/** Document 的稳定键:URL + 标题(规范化) */
function docKey_(seg) {
  return normalizeAlias((seg.url || '') + '|' + (seg.title || ''));
}
