/* ============================================================
 * DebugData.js — 只读诊断数据表与关联 ID
 * 运行 diagnoseEmptyDataTables()，在执行记录/日志中查看返回值。
 * ============================================================ */
function diagnoseEmptyDataTables() {
  const names = ['Products','Feedback','Topics','Competitors',
    'ProductSpecifications','PageTopics','PageCompetitors','Documents','ProductAliases'];
  const ss = ss_();
  const tables = {};
  names.forEach(name => {
    try {
      const sh = ss.getSheetByName(name);
      const rows = readTable(name);
      const rawHeaders = sh && sh.getLastColumn() ? sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0] : [];
      tables[name] = { rows: rows.length, headers_raw: rawHeaders,
        headers_trimmed: rawHeaders.map(h => String(h || '').trim()), sample: rows.slice(0, 2) };
    } catch (e) { tables[name] = { error: String(e) }; }
  });

  const products = readTable('Products');
  const productIds = new Set(products.map(p => String(p.product_id || '').trim()).filter(Boolean));
  const topicIds = new Set(readTable('Topics').map(t => String(t.topic_id || '').trim()).filter(Boolean));
  const feedback = readTable('Feedback');
  const competitors = readTable('Competitors');
  const badFeedback = { blank_product_id: 0, blank_topic_id: 0, unmatched_product_id: 0, unmatched_topic_id: 0 };
  const badFeedbackSamples = [];
  feedback.forEach(r => {
    const pid = String(r.product_id || '').trim(), tid = String(r.topic_id || '').trim();
    if (!pid) badFeedback.blank_product_id++;
    else if (!productIds.has(pid)) badFeedback.unmatched_product_id++;
    if (!tid) badFeedback.blank_topic_id++;
    else if (!topicIds.has(tid)) badFeedback.unmatched_topic_id++;
    if ((!pid || !productIds.has(pid) || !tid || !topicIds.has(tid)) && badFeedbackSamples.length < 20)
      badFeedbackSamples.push({product_id:r.product_id, topic_id:r.topic_id, doc_id:r.doc_id, quote:r.quote});
  });
  const badCompetitors = { blank_product_id: 0, blank_competitor_id: 0, neither_side_matches_product: 0 };
  const badCompetitorSamples = [];
  competitors.forEach(r => {
    const pid = String(r.product_id || '').trim(), cid = String(r.competitor_id || '').trim();
    if (!pid) badCompetitors.blank_product_id++;
    if (!cid) badCompetitors.blank_competitor_id++;
    if ((!pid || !productIds.has(pid)) && (!cid || !productIds.has(cid))) {
      badCompetitors.neither_side_matches_product++;
      if (badCompetitorSamples.length < 20) badCompetitorSamples.push({product_id:r.product_id, competitor_id:r.competitor_id, dimensions:r.dimensions, doc_id:r.doc_id});
    }
  });
  const missingUrl = products.filter(p => !String(p.official_url || '').trim())
    .map(p => ({product_id:p.product_id, name:p.canonical_name}));
  const result = {
    checked_at: new Date().toISOString(),
    tables,
    products_count: products.length,
    feedback_link_check: badFeedback,
    feedback_problem_samples: badFeedbackSamples,
    competitor_link_check: badCompetitors,
    competitor_problem_samples: badCompetitorSamples,
    products_missing_official_url_count: missingUrl.length,
    products_missing_official_url_sample: missingUrl.slice(0,20),
    next_step: '若 Feedback/Competitors 的关联 ID 均匹配，运行 rebuildProductPages_()，检查返回的 topic_rows 与 competitor_rows。ProductSpecifications 需另外运行 refreshProductSpecifications_("产品ID")。'
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}