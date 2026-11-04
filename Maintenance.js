/* ============================================================
 * Maintenance.gs — 实体合并与数据治理工具(通用,与期号无关)
 *
 * 合并的语义:不删除任何行,只把行内的指向字段改到目标实体,
 * 被合并实体标记 status='merged',API 自动隐藏。
 * ============================================================ */

/** 手工建产品(治理用),返回 product_id;已存在则复用 */
function createProductManual_(canonical, brand, category, issueNo) {
  const dup = readTable('Products').find(p => normalizeAlias(p.canonical_name) === normalizeAlias(canonical));
  if (dup) return dup.product_id;
  return createProduct_(canonical, brand, category, issueNo || '');
}

/** 把某个别名改挂到另一个产品 */
function reassignAlias_(alias, targetProductId) {
  const rows = readTable('ProductAliases');
  const norm = normalizeAlias(alias);
  rows.forEach(r => { if (r.normalized === norm) r.product_id = targetProductId; });
  rewriteTable_('ProductAliases', rows);
  return alias + ' -> ' + targetProductId;
}

/** 把某产品下、属于指定话题集的 Feedback 改挂到另一个产品 */
function repointFeedback_(fromProductId, toProductId, topicIds) {
  const set = new Set(topicIds || []);
  const rows = readTable('Feedback');
  let n = 0;
  rows.forEach(r => {
    if (r.product_id === fromProductId && (!set.size || set.has(r.topic_id))) {
      r.product_id = toProductId; n++;
    }
  });
  rewriteTable_('Feedback', rows);
  clearCache();
  return n + ' feedback rows repointed';
}

/**
 * 合并产品:keep 保留,drop 并入。别名/提及/诉求/事件/竞品关系全部改指,
 * drop 行标记 merged(不删除)。
 */
function mergeProducts_(keepId, dropId) {
  if (keepId === dropId) return 'same id';
  const keep = readTable('Products').find(p => p.product_id === keepId);
  const drop = readTable('Products').find(p => p.product_id === dropId);
  if (!keep || !drop) throw new Error('产品不存在: ' + keepId + ' / ' + dropId);

  const ali = readTable('ProductAliases');
  ali.forEach(r => { if (r.product_id === dropId) r.product_id = keepId; });
  rewriteTable_('ProductAliases', ali);

  const feedback = readTable('Feedback');
  feedback.forEach(r => { if (r.product_id === dropId) r.product_id = keepId; });
  rewriteTable_('Feedback', feedback);

  const needs = readTable('UserNeeds');
  needs.forEach(r => { if (r.product_id === dropId) r.product_id = keepId; });
  rewriteTable_('UserNeeds', needs);

  const evs = readTable('Events');
  evs.forEach(r => { if (r.product_id === dropId) r.product_id = keepId; });
  rewriteTable_('Events', evs);

  const comps = readTable('Competitors');
  comps.forEach(r => {
    if (r.product_id === dropId) r.product_id = keepId;
    if (r.competitor_id === dropId) r.competitor_id = keepId;
  });
  rewriteTable_('Competitors', comps);

  const prods = readTable('Products');
  prods.forEach(r => {
    if (r.product_id === dropId) {
      r.status = 'merged';
      r.canonical_name = r.canonical_name + '(已合并→' + keep.canonical_name + ')';
    }
  });
  rewriteTable_('Products', prods);
  clearCache();
  return dropId + ' merged into ' + keepId;
}

/** 合并话题:keep 保留,drop 的 Feedback 改指,drop 标记 merged。
 *  话题按产品隔离后,只允许合并同一产品下的话题。 */
function mergeTopics_(keepId, dropId) {
  if (keepId === dropId) return 'same id';
  const topics = readTable('Topics');
  const k = topics.find(t => t.topic_id === keepId);
  const d = topics.find(t => t.topic_id === dropId);
  if (k && d && String(k.product_id || '') !== '' && String(d.product_id || '') !== ''
      && k.product_id !== d.product_id) {
    return '拒绝合并:话题分属不同产品(' + k.product_id + ' vs ' + d.product_id + ')';
  }
  const feedback = readTable('Feedback');
  feedback.forEach(r => { if (r.topic_id === dropId) r.topic_id = keepId; });
  rewriteTable_('Feedback', feedback);
  const tops = readTable('Topics');
  tops.forEach(t => { if (t.topic_id === dropId) t.status = 'merged'; });
  rewriteTable_('Topics', tops);
  clearCache();
  return dropId + ' merged into ' + keepId;
}

/**
 * AI 复核 PendingQueue 中所有 topic_merge 建议(Gemini 批量裁决):
 * 裁决 same → 执行合并并标记 resolved;裁决 different → 保留新建,标记 kept。
 * 由 autoSync 每轮自动调用。
 */
function applyOpenTopicMerges_() {
  const queue = readTable('PendingQueue').filter(r => r.item_type === 'topic_merge' && r.status === 'open');
  if (!queue.length) return ['队列为空'];

  const pairs = [];
  queue.forEach(q => {
    let payload;
    try { payload = JSON.parse(q.payload_json); } catch (e) { q.status = 'invalid'; return; }
    const topics = readTable('Topics');
    const keep = topics.find(t => t.name === payload.similar_to);
    const drop = topics.find(t => t.name === payload.new_topic);
    if (!keep || !drop) { q.status = 'invalid'; return; }
    if (String(keep.product_id || '') !== '' && String(drop.product_id || '') !== ''
        && keep.product_id !== drop.product_id) { q.status = 'skipped'; return; }
    const pName = (readTable('Products').find(p => p.product_id === keep.product_id) || {}).canonical_name || '';
    pairs.push({ name: payload.new_topic, candidate_name: payload.similar_to,
                 keep_id: keep.topic_id, drop_id: drop.topic_id, product: pName, queueRow: q });
  });

  if (!pairs.length) { rewriteTable_('PendingQueue', queue); return ['无待裁决条目']; }

  let verdicts = [];
  try {
    verdicts = callAI(buildTopicVerifyPrompt_(
      pairs.map(p => ({ name: p.name, candidate_name: p.candidate_name })),
      pairs[0].product || ''), TOPIC_VERIFY_SCHEMA).verdicts || [];
  } catch (e) {
    return ['Gemini 裁决调用失败: ' + String(e).slice(0, 200) + '(建议稍后重跑)'];
  }
  const byName = {};
  verdicts.forEach(v => byName[v.name] = v);

  const log = [];
  pairs.forEach(p => {
    const v = byName[p.name];
    if (v && v.same === true) {
      log.push(mergeTopics_(p.keep_id, p.drop_id));
      p.queueRow.status = 'resolved';
    } else {
      log.push('保留新建:' + p.name + '(AI 判定与「' + p.candidate_name + '」不同主题)');
      p.queueRow.status = 'kept';
    }
  });
  rewriteTable_('PendingQueue', queue);
  return log;
}

/** 把某产品标记为品牌级占位,API 目录会隐藏 */
function markAsBrand_(productId) {
  const prods = readTable('Products');
  prods.forEach(r => {
    if (r.product_id === productId) {
      r.category = 'brand';
      if (r.canonical_name.indexOf('(品牌)') === -1) r.canonical_name += '(品牌)';
    }
  });
  rewriteTable_('Products', prods);
  clearCache();
  return productId + ' marked as brand';
}

/** 一次性归一全部品牌名(按 Config.BRAND_SYNONYMS) */
function normalizeAllBrands_() {
  const prods = readTable('Products');
  prods.forEach(r => r.brand = normalizeBrand_(r.brand));
  rewriteTable_('Products', prods);
  clearCache();
  return 'brands normalized';
}

/**
 * Topics 产品化迁移(话题身份 = product_id + name):
 * 存量无归属话题按 Feedback 反查归属;同名多产品时拆分为每产品一个实体。
 * 一次性迁移工具,新数据由管道自动写入 product_id,无需再跑。
 */
function backfillTopicProducts_() {
  const topics = readTable('Topics');
  const feedback = readTable('Feedback');
  const log = [];

  topics.forEach(t => {
    if (String(t.product_id || '') !== '') return;
    const pids = [];
    feedback.forEach(m => {
      if (m.topic_id === t.topic_id && pids.indexOf(m.product_id) === -1) pids.push(m.product_id);
    });

    if (pids.length === 0) {
      t.status = 'orphan';
      log.push(t.topic_id + ' ' + t.name + ' -> orphan(无提及)');
      return;
    }
    t.product_id = pids[0];
    log.push(t.topic_id + ' ' + t.name + ' -> ' + pids[0]);
    pids.slice(1).forEach(pid => {
      const newId = nextId('TOP', 'Topics', 'topic_id');
      appendRow('Topics', {
        topic_id: newId, product_id: pid, name: t.name,
        keywords: t.keywords || '', summary: t.summary || '',
        created_at: new Date().toISOString(), auto_created: t.auto_created || 'yes', status: '',
      });
      feedback.forEach(m => { if (m.topic_id === t.topic_id && m.product_id === pid) m.topic_id = newId; });
      log.push('  拆分 ' + newId + ' -> ' + pid);
    });
  });

  rewriteTable_('Topics', topics);
  rewriteTable_('Feedback', feedback);
  clearCache();
  return log;
}

/** 清空全部业务数据(保留表头),用于一次性重建。谨慎使用!
 *  会先确保所有表存在(缺表先建),绝不半途清空。 */
function resetAllData_() {
  setupSheets();
  Object.keys(SHEET_DEFS).forEach(name => rewriteTable_(name, []));
  clearCache();
  return '已清空全部 ' + Object.keys(SHEET_DEFS).length + ' 张表的数据(表头保留)。可直接运行 runIssue14()。';
}