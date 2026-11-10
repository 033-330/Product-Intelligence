/* ============================================================
 * Api.gs — Web App 查询接口(前端 fetch 的唯一入口)
 *
 * 时间窗:days 不传或 = 0 → 累计全部历史(默认);
 *        days = 30 → 最近 30 天窗口。
 * Top 5 Topics 排序:Gemini 预排序(重要度)优先,同级按累计提及降序;
 *        每个 topic 带 summary(AI 摘要)、mention_count、sentiment、evidence。
 * ============================================================ */

function doGet(e) {
  const p = (e && e.parameter) || {};

  try {
    assertAllowedUser_(false);
    // 直接访问 Web App 首页时，显示前端
    if (!p.action) {
      return HtmlService
        .createHtmlOutputFromFile('site')
        .setTitle('Product Intelligence')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    }

    const action = String(p.action);
    // 公开 GET 只保留只读查询；写操作必须走带登录态的 apiDispatch 或 token 保护的 sync。
    if (action === 'sync' || action === 'rebuildPages') {
      assertWriteToken_(p.token);
    } else if (!isPublicReadAction_(action)) {
      throw new Error('该 action 不允许通过公开 GET 调用: ' + action);
    }
    return json_(apiDispatch(action, p));
  } catch (err) {
    return json_({ error: String(err).slice(0, 500) });
  }
}

function isPublicReadAction_(action) {
  return [
    'listProducts', 'getProduct', 'getTopic', 'search', 'listEvents',
    'syncStatus', 'listNeeds', 'getPage', 'listPages', 'topicSentiment',
    'getFeedback', 'searchReviews', 'specTaskStatus'
  ].indexOf(String(action)) >= 0;
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 时间窗(0 / 不传 = 全部累计) ---------- */

function parseDays_(daysParam) {
  const d = parseInt(daysParam, 10);
  return (isNaN(d) || d <= 0) ? 0 : d;
}

function windowDocIds_(days) {
  const docs = cacheGet_('allDocs') || readTable('Documents');
  if (!cacheGet_('allDocs')) cachePut_('allDocs', docs);
  if (!days) return new Set(docs.map(d => d.doc_id));
  const cutoff = new Date(Date.now() - days * 86400000);
  return new Set(docs.filter(d => {
    const t = new Date(d.published_at);
    return isNaN(t.getTime()) ? true : t >= cutoff;
  }).map(d => d.doc_id));
}

function scopeLabel_(days) { return days ? ('最近 ' + days + ' 天') : '历史累计'; }

function topicIndex_() {
  const idx = {};
  readTable('Topics').forEach(t => idx[t.topic_id] = t.name);
  return idx;
}

function productIndex_() {
  const idx = {};
  readTable('Products').forEach(p => idx[p.product_id] = p);
  return idx;
}

function aliasesByProduct_() {
  const map = {};
  readTable('ProductAliases').forEach(r => {
    (map[r.product_id] = map[r.product_id] || []).push(r.alias);
  });
  return map;
}

function docIndex_() {
  const idx = {};
  readTable('Documents').forEach(d => idx[d.doc_id] = d);
  return idx;
}

/** topic 元数据:名称 + 摘要(摘要统一存 Topics.summary) */
function topicMeta_() {
  const idx = {};
  readTable('Topics').forEach(t => idx[t.topic_id] = { name: t.name, summary: t.summary });
  return idx;
}

/**
 * 聚合 Feedback:product_id -> topic_id -> {count, sentiments, quotes[], summaries[], preRank}
 * count = 独立反馈条数;preRank 取首条反馈的行序(先写 = 更重要)
 */
function aggregateFeedback_(days) {
  const agg = {};
  const docs = docIndex_();
  const tMeta = topicMeta_();
  const ids = windowDocIds_(days);
  const order = {};
  // Feedback 是唯一事实表：每一行代表一条独立用户反馈。
  const sourceRows = readTable('Feedback');

  sourceRows.forEach((m, i) => {
    // days=0 代表全历史，不应因 Documents 缺行/ID 不一致而误过滤所有记录。
    if (days && !ids.has(m.doc_id)) return;
    const pid = String(m.product_id || '').trim();
    const tid = String(m.topic_id || '').trim();
    if (!pid || !tid) return;
    const a = agg[pid] = agg[pid] || {};
    const t = a[tid] = a[tid] || { count: 0, sentiments: [], quotes: [], summaries: [] };
    t.count += 1;
    if (m.sentiment) t.sentiments.push(m.sentiment);
    const quote = m.quote;
    if (quote && t.quotes.length < 3) {
      const d = docs[m.doc_id] || {};
      t.quotes.push({ quote: String(quote), source: d.title || '', url: d.url || '', platform: d.platform || '' });
    }
    const summary = (tMeta[tid] || {}).summary;
    if (summary && t.summaries.length === 0) t.summaries.push(String(summary));
    const key = pid + '|' + tid;
    if (order[key] === undefined) order[key] = i;
  });
  Object.keys(order).forEach(key => {
    const parts = key.split('|');
    const pid = parts[0], tid = parts.slice(1).join('|');
    if (agg[pid] && agg[pid][tid]) {
      agg[pid][tid].preRankSum = order[key];
      agg[pid][tid].preRankN = 1;
      if (!agg[pid][tid].summaries.length) agg[pid][tid].summaries = [(tMeta[tid] || {}).summary || ''];
    }
  });
  return agg;
}

function dominant_(arr) {
  const c = {};
  arr.forEach(s => c[s] = (c[s] || 0) + 1);
  return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || 'neutral';
}

/* ---------- action: listProducts ---------- */

function buildProductList_(p) {
  const days = parseDays_(p.days);
  const ck = ['listProducts', days, p.brand || '', p.category || '', (p.q || '').toLowerCase()].join('|');
  const hit = cacheGet_(ck);
  if (hit) return hit;

  const q = (p.q || '').toLowerCase().trim();
  const aliases = aliasesByProduct_();
  const tIdx = topicIndex_();
  const agg = aggregateFeedback_(days);

  const out = readTable('Products')
    .filter(pr => pr.status !== 'merged' && pr.category !== 'brand')
    .filter(pr => (!p.brand || pr.brand === p.brand))
    .filter(pr => (!p.category || pr.category === p.category))
    .filter(pr => {
      if (!q) return true;
      const hay = [pr.canonical_name, (aliases[pr.product_id] || []).join(' '),
        Object.keys(agg[pr.product_id] || {}).map(id => tIdx[id] || '').join(' ')].join(' ').toLowerCase();
      return q.split(/\s+/).every(w => hay.indexOf(w) !== -1);
    })
    .map(pr => {
      const topics = Object.keys(agg[pr.product_id] || {})
        .map(tid => ({
          topic_id: tid, name: tIdx[tid] || tid,
          mention_count: agg[pr.product_id][tid].count,
          sentiment: dominant_(agg[pr.product_id][tid].sentiments),
        }))
        .sort((a, b) => b.mention_count - a.mention_count)
        .map((t, i) => { t.rank = i + 1; return t; });
      return {
        product_id: pr.product_id,
        name: pr.canonical_name,
        aliases: (aliases[pr.product_id] || []).slice(0, 6),
        brand: pr.brand,
        category: pr.category,
        total_mentions: topics.reduce((s, t) => s + t.mention_count, 0),
        top_topics: topics.slice(0, 3),
      };
    })
    .sort((a, b) => b.total_mentions - a.total_mentions);

  cachePut_(ck, out);
  return out;
}

/* ---------- action: getProduct ---------- */

/** 兼容旧 API：与 getPage 共用同一套读物化详情响应，避免字段漂移。 */
function buildProductDetail_(id) {
  return buildPage_(id);
}

/* ---------- action: getTopic ---------- */

/**
 * Topic 详情。话题归属于产品:
 * 传入某产品下的话题 id 时,同时聚合所有同名话题(其他产品下)形成一个跨产品对比视图,
 * 同名话题在该产品下高亮(own: true)。
 */
function buildTopicDetail_(topicId, daysParam) {
  if (!topicId) throw new Error('缺少 id 参数');
  const days = parseDays_(daysParam);
  const allTopics = readTable('Topics');
  const topic = allTopics.find(t => t.topic_id === topicId);
  if (!topic) throw new Error('Topic 不存在: ' + topicId);
  const pIdx = productIndex_();
  const agg = aggregateFeedback_(days);

  // 同名话题集合(话题按产品隔离后,"同名不同产品"的话题实体各自独立)
  const sameNameIds = new Set(allTopics.filter(t => t.name === topic.name).map(t => t.topic_id));

  const products = [];
  Object.keys(agg).forEach(pid => {
    let total = 0, sentiments = [], summaries = [], quotes = [];
    let own = false;
    Object.keys(agg[pid]).forEach(tid => {
      if (!sameNameIds.has(tid)) return;
      const t = agg[pid][tid];
      total += t.count;
      sentiments = sentiments.concat(t.sentiments);
      if (tid === topicId) own = true;
      if (!summaries.length) summaries = t.summaries;
      if (!quotes.length) quotes = t.quotes;
    });
    if (!total) return;
    products.push({
      product_id: pid,
      name: (pIdx[pid] || {}).canonical_name || pid,
      own: own,
      summary: summaries[0] || '',
      mention_count: total,
      sentiment: dominant_(sentiments),
      evidence: quotes,
    });
  });
  products.sort((a, b) => b.mention_count - a.mention_count);
  return { topic_id: topic.topic_id, name: topic.name,
           product: (pIdx[topic.product_id] || {}).canonical_name || '',
           keywords: topic.keywords, scope: scopeLabel_(days), products: products };
}

/* ---------- action: search ---------- */

function globalSearch_(q) {
  q = String(q || '').toLowerCase().trim();
  if (!q) return { products: [], topics: [] };
  const aliases = aliasesByProduct_();
  const products = readTable('Products')
    .filter(pr => pr.status !== 'merged' && pr.category !== 'brand')
    .filter(pr => {
      const hay = (pr.canonical_name + ' ' + (aliases[pr.product_id] || []).join(' ')).toLowerCase();
      return q.split(/\s+/).every(w => hay.indexOf(w) !== -1);
    })
    .map(pr => ({ product_id: pr.product_id, name: pr.canonical_name, brand: pr.brand, category: pr.category }));
  const topics = readTable('Topics')
    .filter(t => (t.name + ' ' + t.keywords).toLowerCase().indexOf(q) !== -1)
    .map(t => ({ topic_id: t.topic_id, name: t.name }));
  return { products: products.slice(0, 20), topics: topics.slice(0, 20) };
}

/* ---------- action: listEvents ---------- */

function buildEvents_(daysParam) {
  // V2.1 P0：Events 已退出新 Pipeline；保留只读接口避免旧前端报错。
  const days = parseDays_(daysParam);
  return {
    scope: scopeLabel_(days),
    retired: true,
    events: [],
    note: 'Events 已停用（V2.1 P0），历史表保留但不再新增。',
  };
}

/* ---------- action: syncStatus ---------- */

function buildSyncStatus_() {
  return {
    files: readTable('ProcessedFiles'),
    issues: readTable('Issues').map(r => ({ issue: r.issue_no, date: r.date, status: r.status })),
    counts: {
      products: readTable('Products').length,
      topics: readTable('Topics').length,
      documents: readTable('Documents').length,
      feedback: readTable('Feedback').length,
      pending: readTable('PendingQueue').filter(r => r.status === 'open').length,
    },
  };
}

/* ---------- 话题情绪分布(Feedback 版) ---------- */

/** 分母 = 可判断情绪的独立反馈数(unknown 不计入) */
function buildTopicSentiment_(productId, daysParam) {
  if (!productId) throw new Error('缺少 id 参数');
  const days = parseDays_(daysParam);
  const ids = windowDocIds_(days);
  const tIdx = topicIndex_();
  const groups = {};
  readTable('Feedback').forEach(f => {
    if (f.product_id !== productId || !ids.has(f.doc_id)) return;
    const g = groups[f.topic_id] = groups[f.topic_id] || { pos: 0, neg: 0, neu: 0, unk: 0 };
    const s = f.sentiment || 'unknown';
    if (s === 'positive') g.pos++;
    else if (s === 'negative') g.neg++;
    else if (s === 'neutral') g.neu++;
    else g.unk++;
  });
  const topics = Object.keys(groups).map(tid => {
    const g = groups[tid];
    const valid = g.pos + g.neg + g.neu;
    const pp = valid ? Math.round(g.pos / valid * 100) : 0;
    const np = valid ? Math.round(g.neg / valid * 100) : 0;
    return {
      topic_id: tid, name: tIdx[tid] || tid,
      pos: g.pos, neg: g.neg, neu: g.neu, unknown: g.unk,
      valid: valid, total: valid + g.unk,
      pct: valid ? { pos: pp, neg: np, neu: 100 - pp - np } : null,
      small_sample: valid < 5,
    };
  }).sort((a, b) => b.valid - a.valid).slice(0, 8);
  return { product_id: productId, scope: scopeLabel_(days), source: 'feedback', topics: topics };
}

/** 取反馈:topicId 为空 = 该产品全部话题 */
function getFeedback_(productId, topicId, sentiment, limit) {
  const docs = docIndex_();
  return readTable('Feedback')
    .filter(f => f.product_id === productId && f.sentiment === sentiment
             && (!topicId || f.topic_id === topicId))
    .slice(0, limit || 20)
    .map(f => {
      const d = docs[f.doc_id] || {};
      return { quote: f.quote, sentiment: f.sentiment, confidence: f.sentiment_confidence,
               source: d.title || '', url: d.url || '' };
    });
}

/* ---------- 跨产品诉求概览(过滤卖点评价) ---------- */
function buildNeedsOverview_(daysParam) {
  const days = parseDays_(daysParam);
  const ids = windowDocIds_(days);
  const pIdx = productIndex_();
  const docs = docIndex_();
  const groups = {};
  readTable('UserNeeds').forEach(n => {
    if (!ids.has(n.doc_id)) return;
    if (n.need_type === 'evaluation') return; // 卖点评价不进诉求面板
    const cat = n.category || '其他';
    const g = groups[cat] = groups[cat] || { count: 0, products: {}, items: [] };
    g.count++;
    const pname = (pIdx[n.product_id] || {}).canonical_name || n.product_id;
    g.products[pname] = 1;
    if (g.items.length < 3) {
      const d = docs[n.doc_id] || {};
      g.items.push({ product: pname, description: n.description,
                     evidence: n.evidence_quote, source: d.title || '' });
    }
  });
  const needs = Object.keys(groups).map(cat => ({
    category: cat,
    count: groups[cat].count,
    product_count: Object.keys(groups[cat].products).length,
    products: Object.keys(groups[cat].products).slice(0, 4),
    items: groups[cat].items,
  })).sort((a, b) => b.count - a.count).slice(0, 8);
  return { scope: scopeLabel_(days), needs: needs };
}

/* ---------- google.script.run 调度器(页面托管时免跨域) ---------- */
var WRITE_ACTIONS_ = {
  sync: 1,
  rebuildPages: 1,
  refreshProductSpecs: 1,
  runSpecTaskQueue: 1
};

function apiDispatch(action, params) {
  params = params || {};
  action = String(action || '');
  try {
    const isWrite = !!WRITE_ACTIONS_[action];
    assertAllowedUser_(isWrite);
    // 外部触发器/脚本入口继续使用 WRITE_TOKEN；登录态 UI 的写操作由 Google 用户身份保护。
    if (action === 'sync' || action === 'rebuildPages' || action === 'runSpecTaskQueue') {
      assertWriteToken_(params.token);
    }
    switch (action) {
      case 'listProducts': return buildProductList_(params);
      case 'getProduct':   return buildProductDetail_(params.id, params.days);
      case 'getTopic':     return buildTopicDetail_(params.id, params.days);
      case 'search':       return globalSearch_(params.q || '');
      case 'listEvents':   return buildEvents_(params.days);
      case 'getPage':      return buildPage_(params.id);
      case 'listPages':    return buildAllPages_();
      case 'listNeeds':    return buildNeedsOverview_(params.days);
      case 'topicSentiment': return buildTopicSentiment_(params.id, params.days);
      case 'getFeedback':  return getFeedback_(params.product_id, params.topic_id, params.sentiment);
      case 'searchReviews': return searchProductReviewsV2_(params.id, params.q || '', params);
      case 'compareProducts': return compareProducts_(params.names || '');
      case 'refreshProductSpecs': return refreshProductSpecifications_(params.ids || '');
      case 'specTaskStatus': return buildSpecificationTaskStatus_();
      case 'runSpecTaskQueue': return processSpecificationTasks_(params.limit || 3);
      case 'rebuildPages': return rebuildProductPages_();
      case 'sync':          return autoSync();
      case 'syncStatus':    return buildSyncStatus_();
      default: return { error: 'unknown action: ' + action };
    }
  } catch (err) {
    return { error: String(err).slice(0, 500) };
  }
}
