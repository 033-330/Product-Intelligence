/* ============================================================
 * Pages.gs — 前端物化视图
 *
 * 每次同步完成后,rebuildProductPages_() 把每个产品的
 * Top5 Topics(标题/摘要/引文/来源)和关联竞品(名称/维度/摘要/引文)
 * 预计算写入 PageTopics / PageCompetitors 两张表。
 * 前端只读这两张表:getPage 返回的 JSON 可直接渲染,无需再聚合。
 * ============================================================ */

/** 重建物化视图(全量)。autoSync 每轮同步后自动调用。 */
function rebuildProductPages_() {
  const now = new Date().toISOString();
  const products = readTable('Products').filter(p => String(p.status || '').toLowerCase() !== 'merged' && String(p.category || '').toLowerCase() !== 'brand');
  const pIdx = productIndex_();
  const aliases = aliasesByProduct_();
  const docs = docIndex_();
  const competitors = readTable('Competitors');
  const agg = aggregateFeedback_(0); // 全历史，只读取 Feedback

  const topicRows = [];
  const compRows = [];

  products.forEach(pr => {
    const pid = String(pr.product_id || '').trim();
    const pAgg = agg[pid] || {};

    /* ---- Top5 Topics:与 getProduct 相同的排序(preRank 优先,同级按提及数)---- */
    const topics = Object.keys(pAgg).map(tid => ({
      tid: tid,
      count: pAgg[tid].count,
      preRank: pAgg[tid].preRankSum !== undefined ? pAgg[tid].preRankSum : 1e9,
      t: pAgg[tid],
    })).sort((a, b) => (a.preRank !== b.preRank) ? (a.preRank - b.preRank) : (b.count - a.count))
      .slice(0, 5);

    topics.forEach((x, i) => {
      const ev = (x.t.quotes || [])[0] || {};
      topicRows.push({
        product_id: pid,
        rank: i + 1,
        topic_id: x.tid,
        topic_name: (topicIndex_()[x.tid]) || x.tid,
        summary: (x.t.summaries || [])[0] || '',
        mention_count: x.count,
        sentiment: dominant_(x.t.sentiments),
        count_type: 'feedback', // 提及数统一按 Feedback 独立反馈条数统计
        evidence_quote: ev.quote || '',
        evidence_source: ev.source || '',
        evidence_url: ev.url || '',
        evidence_platform: ev.platform || '',
        updated_at: now,
      });
    });

    /* ---- 竞品:按关联强度(提及次数)排序,取 Top 10 ---- */
    const compMap = {};
    competitors.forEach(c => {
      const subjectId = String(c.product_id || '').trim();
      const competitorId = String(c.competitor_id || '').trim();
      const isSubject = subjectId === pid;
      const isCompetitor = competitorId === pid;
      const otherId = isSubject ? competitorId : subjectId;
      if (!isSubject && !isCompetitor) return;
      if (!otherId || otherId === String(pid)) return;
      const slot = compMap[otherId] = compMap[otherId] || { count: 0, dimensions: {}, summary: '', quote: '', doc: '' };
      slot.count++;
      String(c.dimensions || '').split('、').filter(String).forEach(d => slot.dimensions[d] = (slot.dimensions[d] || 0) + 1);
      if (!slot.summary) {
        // context_summary 形如 "比较结论 | 引文"
        const parts = String(c.context_summary || '').split(' | ');
        slot.summary = (parts[0] || '').trim();
        slot.quote = (parts.slice(1).join(' | ') || '').trim();
        slot.doc = c.doc_id;
      }
    });

    Object.keys(compMap)
      .sort((a, b) => compMap[b].count - compMap[a].count)
      .slice(0, 10)
      .forEach((oid, i) => {
        const s = compMap[oid];
        const d = docs[s.doc] || {};
        compRows.push({
          product_id: pid,
          rank: i + 1,
          competitor_id: oid,
          competitor_name: (pIdx[oid] || {}).canonical_name || oid,
          dimensions: Object.keys(s.dimensions).sort((a, b) => s.dimensions[b] - s.dimensions[a]).join('、'),
          summary: s.summary,
          evidence_quote: s.quote,
          evidence_source: d.title || '',
          evidence_url: d.url || '',
          updated_at: now,
        });
      });
  });

  rewriteTable_('PageTopics', topicRows);
  rewriteTable_('PageCompetitors', compRows);
  clearCache();
  return { products: products.length, topic_rows: topicRows.length, competitor_rows: compRows.length };
}

/** 前端:读物化表渲染产品详情页(零聚合) */
function buildPage_(id) {
  if (!id) throw new Error('缺少 id 参数');
  const normalizedId = String(id || '').trim();
  const pr = readTable('Products').find(r => String(r.product_id || '').trim() === normalizedId);
  if (!pr) throw new Error('产品不存在: ' + id);
  if (pr.status === 'merged') throw new Error('该产品已合并: ' + pr.canonical_name);

  const topics = readTable('PageTopics')
    .filter(r => String(r.product_id || '').trim() === normalizedId)
    .sort((a, b) => a.rank - b.rank)
    .map(r => ({
      rank: +r.rank, topic_id: r.topic_id, name: r.topic_name,
      summary: r.summary, mention_count: +r.mention_count, sentiment: r.sentiment,
      evidence: r.evidence_quote ? [{ quote: r.evidence_quote, source: r.evidence_source,
                                      url: r.evidence_url, platform: r.evidence_platform }] : [],
    }));

  const competitors = readTable('PageCompetitors')
    .filter(r => String(r.product_id || '').trim() === normalizedId)
    .sort((a, b) => a.rank - b.rank)
    .map(r => ({
      rank: +r.rank, product_id: r.competitor_id, name: r.competitor_name,
      dimensions: String(r.dimensions || '').split('、').filter(String),
      summary: r.summary,
      evidence: r.evidence_quote ? [{ quote: r.evidence_quote, source: r.evidence_source,
                                      url: r.evidence_url, platform: '' }] : [],
    }));

  const officialSpecs = readTable('ProductSpecifications')
    .filter(r => String(r.product_id || '').trim() === normalizedId)
    .map(r => ({
      spec_key: r.spec_key,
      spec_label: r.spec_label || r.spec_key,
      value: r.value,
      unit: r.unit || '',
      raw_value: r.raw_value || '',
      source_url: r.source_url || '',
      fetched_at: r.fetched_at || '',
      verification_status: r.verification_status || 'needs_review',
    }));

  const userNeeds = readTable('UserNeeds')
    .filter(n => String(n.product_id || '').trim() === normalizedId && n.need_type !== 'evaluation')
    .map(n => ({ category: n.category, description: n.description, evidence: n.evidence_quote }));

  // V2.1 P0：Events 已退出新 Pipeline，详情页不再读取事件表。
  const events = [];

  return {
    product_id: pr.product_id,
    name: pr.canonical_name,
    aliases: aliasesByProduct_()[normalizedId] || [],
    brand: pr.brand,
    category: pr.category,
    scope: '历史累计',
    top_topics: topics,      // 5 行:rank/name/summary/mention_count/sentiment/evidence
    competitors: competitors, // 每行:name/dimensions/summary/evidence
    official_specs: officialSpecs,
    user_needs: userNeeds,
    events: events,
  };
}

/** 前端:全量页面数据(静态站整站导出用),按产品分组 */
function buildAllPages_() {
  const pages = {};
  readTable('Products').filter(p => p.status !== 'merged' && p.category !== 'brand')
    .forEach(p => { pages[p.product_id] = buildPage_(p.product_id); });
  return { generated_at: new Date().toISOString(), pages: pages };
}