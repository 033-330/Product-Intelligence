/* ============================================================
 * Features.gs — 产品名称解析 + 多产品规格对比
 * 规格采集/写表统一由 SpecificationTasks.js 负责。
 * ============================================================ */

function featureProducts_() {
  return readTable('Products').filter(p => String(p.status || '').toLowerCase() !== 'merged');
}

function resolveProductName_(input, products, aliasRows) {
  var q = normalizeAlias(input);
  if (!q) return { status: 'not_found', input: input, candidates: [] };
  var matches = [];
  products.forEach(function(p) {
    var names = [p.canonical_name, p.brand && (p.brand + ' ' + p.canonical_name)];
    aliasRows.filter(function(a) { return String(a.product_id) === String(p.product_id); })
      .forEach(function(a) { names.push(a.alias); });
    var exact = names.some(function(n) { return normalizeAlias(n) === q; });
    if (exact) matches.push({ product_id: p.product_id, name: p.canonical_name, brand: p.brand, category: p.category, match_type: 'exact' });
  });
  if (matches.length === 1) return { status: 'matched', input: input, product: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', input: input, candidates: matches };
  // Fuzzy match only offers candidates; it never silently binds a different model.
  var scored = [];
  products.forEach(function(p) {
    var names = [p.canonical_name].concat(aliasRows.filter(function(a) { return String(a.product_id) === String(p.product_id); }).map(function(a) { return a.alias; }));
    var score = 0;
    names.forEach(function(n) {
      var nn = normalizeAlias(n);
      if (nn && (nn.indexOf(q) >= 0 || q.indexOf(nn) >= 0)) score = Math.max(score, Math.min(nn.length, q.length) / Math.max(nn.length, q.length));
    });
    if (score >= 0.55) scored.push({ product_id: p.product_id, name: p.canonical_name, brand: p.brand, category: p.category, score: score });
  });
  scored.sort(function(a,b) { return b.score-a.score; });
  return { status: scored.length ? 'ambiguous' : 'not_found', input: input, candidates: scored.slice(0,5) };
}

function compareProducts_(namesRaw) {
  var names = String(namesRaw || '').split(/\n|,|，|;|；/).map(function(s){return s.trim();}).filter(Boolean);
  if (names.length < 2) throw new Error('请至少输入两个产品名称');
  if (names.length > 6) throw new Error('一次最多比较 6 个产品');
  var products = featureProducts_(), aliases = readTable('ProductAliases');
  var resolutions = names.map(function(n){ return resolveProductName_(n, products, aliases); });
  var outputProducts = [];
  var webErrors = [];
  resolutions.forEach(function(r) {
    if (r.status === 'ambiguous') return; // 有多个候选时先让用户确认型号，避免抓错官网产品
    var p = null;
    if (r.status === 'matched') {
      p = products.filter(function(x){return String(x.product_id)===String(r.product.product_id);})[0] || {};
      var savedSpecs = readTable('ProductSpecifications').filter(function(s){return String(s.product_id)===String(p.product_id);});
      if (savedSpecs.length) {
        outputProducts.push({product_id:p.product_id, name:p.canonical_name, brand:p.brand, category:p.category,
          official_url:p.official_url || savedSpecs[0].source_url || '', specs:savedSpecs, source_type:'database'});
        return;
      }
    }
    // 无论是否已入库，缺少规格时都尝试在线发现官方页面。
    // Crawl4AI 自带 LLM 抽取，只有 urlfetch 回退路径才需要 Gemini/OpenRouter Key。
    if (activeSpecCrawler_() === 'urlfetch' && !hasConfiguredAIKey_()) {
      webErrors.push({input:r.input, message:'未配置 CRAWL4AI_API_KEY，也未配置 AI API Key，无法解析官网规格。'}); return;
    }
    try {
      var url = p && p.official_url && isAllowedOfficialProductUrl_(p.official_url) ? p.official_url : searchOfficialProductPage_(r.input);
      if (!url) { webErrors.push({input:r.input, message:'未找到可信的品牌官方产品页面。'}); return; }
      var live = extractOfficialSpecs_(r.input, url);
      if (!live.specs.length) { webErrors.push({input:r.input, message:'官网页面未提取到可确认的规格。'}); }
      outputProducts.push({product_id:p ? p.product_id : '', name:live.name || (p && p.canonical_name) || r.input,
        input_name:r.input, brand:live.brand || (p && p.brand) || '', category:p && p.category || '', official_url:url,
        specs:live.specs.map(function(s){return {spec_key:String(s.spec_key), spec_label:String(s.spec_label || s.spec_key),
          value:String(s.value), unit:String(s.unit || ''), raw_value:String(s.raw_value || s.value), source_url:url,
          fetched_at:live.fetched_at, verification_status:'ai_extracted_unverified'};}),
        source_type:'official_web', fetched_at:live.fetched_at});
      r.status = p ? 'matched_web_specs' : 'web_found';
      r.web_product = {name:live.name || r.input, brand:live.brand || '', official_url:url};
    } catch(e) { webErrors.push({input:r.input, message:String(e).slice(0,220)}); }
  });
  var allSpecs = [];
  outputProducts.forEach(function(p){(p.specs||[]).forEach(function(s){if(s.spec_key && allSpecs.indexOf(s.spec_key)<0)allSpecs.push(s.spec_key);});});
  return {resolutions:resolutions, products:outputProducts, spec_keys:allSpecs, web_errors:webErrors,
    message:'优先使用数据库中已有规格；缺少规格时会搜索公开品牌官网。官网提取结果标记为“AI 提取待核验”，并附来源链接；未找到或无法确认的参数不会猜测。'};
}
