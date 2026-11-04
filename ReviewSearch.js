/* ReviewSearch.gs — 可解释的评论检索。基础搜索不依赖 AI；只返回 Feedback 中的真实记录。 */
var REVIEW_QUERY_GROUPS_ = [
  { key:'battery_life', label:'Battery life', terms:['battery life','battery lasts','battery drain','battery drains','short battery','poor battery','battery performance','battery','续航','电池','掉电','电量'] },
  { key:'connection', label:'Connection issues', terms:['connection issues','connectivity','disconnects','disconnect','disconnected','drop connection','connection drops','bluetooth issues','bluetooth','wireless connection','pairing','reconnect','断连','连接不稳定','连接问题','蓝牙','配对'] },
  { key:'scroll_wheel', label:'Scroll wheel', terms:['scroll wheel','scrolling','wheel click','middle click','滚轮','滚动'] },
  { key:'click_feel', label:'Click feel', terms:['click feel','clicking','click force','double click','switch feel','点击手感','双击','按键'] },
  { key:'weight', label:'Weight', terms:['weight','heavy','lightweight','too heavy','重量','太重','轻量'] },
  { key:'sensor', label:'Sensor / tracking', terms:['sensor','tracking','dpi','cursor jitter','spin out','传感器','追踪','DPI','丢帧'] },
  { key:'software', label:'Software', terms:['software','firmware','driver','logitech g hub','ghub','synapse','软件','驱动','固件'] },
  { key:'durability', label:'Durability', terms:['durability','broke','broken','build quality','wear out','寿命','耐用','损坏','做工'] },
  { key:'comfort', label:'Comfort / ergonomics', terms:['comfort','comfortable','ergonomic','hand pain','wrist pain','手感','舒适','人体工学','手腕疼'] }
];
var REVIEW_STOP_WORDS_ = {find:1,reviews:1,review:1,mentioning:1,mention:1,about:1,with:1,and:1,or:1,the:1,a:1,an:1,for:1,to:1,of:1,in:1,on:1,issues:1,issue:1,users:1,user:1,show:1,me:1,what:1,are:1,do:1,does:1,how:1,common:1,complaints:1,complaint:1};
function reviewNormalize_(s) { return String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function reviewExtractTerms_(query) {
  var q = reviewNormalize_(query), groups = [];
  REVIEW_QUERY_GROUPS_.forEach(function(g) {
    var found = g.terms.filter(function(t) { return q.indexOf(reviewNormalize_(t)) >= 0; });
    if (found.length) groups.push({key:g.key,label:g.label,terms:g.terms});
  });
  if (!groups.length) {
    var tokens = q.split(/\s+/).filter(function(t){return t.length > 1 && !REVIEW_STOP_WORDS_[t];});
    if (tokens.length) groups.push({key:'custom',label:'关键词匹配',terms:tokens});
  }
  return groups;
}
function reviewMatchedTerms_(text, groups) {
  var normalized = reviewNormalize_(text), hits = [], labels = [];
  groups.forEach(function(g) {
    var groupHit = false;
    g.terms.forEach(function(term) {
      var n = reviewNormalize_(term);
      if (n && normalized.indexOf(n) >= 0) {
        groupHit = true;
        // Return the literal synonym, but highlight only if it is actually present in original text.
        var re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        var m = String(text || '').match(re);
        if (m && hits.indexOf(m[0]) < 0) hits.push(m[0]);
      }
    });
    if (groupHit) labels.push(g.label);
  });
  return {terms:hits,labels:labels,groupCount:labels.length};
}
function reviewDateValue_(v) {
  if (!v) return null;
  var d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function searchProductReviewsV2_(productId, query, params) {
  params = params || {};
  if (!productId) throw new Error('缺少产品 ID');
  query = String(query || '').trim();
  if (!query) throw new Error('请输入要检索的关键词或问题');
  var feedback = readTable('Feedback').filter(function(f) {
    return String(f.product_id) === String(productId) && String(f.quote || '').trim();
  });
  var docs = {};
  readTable('Documents').forEach(function(d) { docs[String(d.doc_id)] = d; });
  var groups = reviewExtractTerms_(query);
  var from = reviewDateValue_(params.dateFrom), to = reviewDateValue_(params.dateTo);
  var sentiment = String(params.sentiment || 'all').toLowerCase();
  var all = [];
  feedback.forEach(function(f, i) {
    var d = docs[String(f.doc_id)] || {};
    var date = reviewDateValue_(d.published_at || f.created_at);
    if (sentiment !== 'all' && String(f.sentiment || 'unknown').toLowerCase() !== sentiment) return;
    if (from && (!date || date < from)) return;
    if (to && (!date || date > new Date(to.getTime() + 86400000 - 1))) return;
    var hit = reviewMatchedTerms_(String(f.quote || ''), groups);
    if (!hit.groupCount) return;
    var score = hit.groupCount * 5 + hit.terms.length;
    var matchType = hit.groupCount > 1 ? 'keyword' : (hit.terms.some(function(t){return reviewNormalize_(t) !== reviewNormalize_(query);}) ? 'synonym' : 'keyword');
    all.push({feedback_id:String(f.feedback_id || ('row-' + i)), quote:String(f.quote || ''), sentiment:String(f.sentiment || 'unknown').toLowerCase(),
      source:String(d.title || ''), url:String(d.url || ''), published_at:d.published_at || f.created_at || '', platform:String(d.platform || ''), doc_id:String(f.doc_id || ''),
      matched_terms:hit.terms, matched_topics:hit.labels, match_type:matchType, score:score, relevance:Math.min(1, score / (groups.length * 6 || 6)),
      reason:'匹配主题：' + hit.labels.join('、')});
  });
  // Optional semantic retrieval is opt-in. It can only add existing Feedback rows; it never generates review text.
  var enabled = PropertiesService.getScriptProperties().getProperty('ENABLE_SEMANTIC_REVIEW_SEARCH') === 'true';
  var semanticAdded = 0;
  if (enabled && hasConfiguredAIKey_()) {
    try {
      var matchedIds = {}; all.forEach(function(r){matchedIds[r.feedback_id]=true;});
      var semanticPool = feedback.filter(function(f){
        if(!String(f.quote||'').trim() || matchedIds[String(f.feedback_id)])return false;
        if(sentiment!=='all' && String(f.sentiment||'unknown').toLowerCase()!==sentiment)return false;
        var sd=docs[String(f.doc_id)]||{}, dt=reviewDateValue_(sd.published_at||f.created_at);
        if(from && (!dt||dt<from))return false; if(to && (!dt||dt>new Date(to.getTime()+86400000-1)))return false; return true;
      }).slice(0,40);
      if (semanticPool.length) {
        var semanticPayload = semanticPool.map(function(f,i){return {index:i,quote:String(f.quote||'').slice(0,700)};});
        var semanticPrompt = '你是严谨的用户研究检索器。查询：'+query+'\n判断候选评论是否在语义上直接讨论查询问题。只能从输入候选中选取，不能生成或改写评论。返回 JSON：{"matches":[{"index":0,"relevance":0.8,"reason":"简短说明"}]}。relevance 为 0 到 1，只有明确相关才返回。候选：'+JSON.stringify(semanticPayload);
        var semanticResponse = extractJson_(callAI(semanticPrompt,null,{maxTokens:3000}));
        (semanticResponse.matches||[]).forEach(function(m){
          var ix=Number(m.index), rel=Number(m.relevance); if(!Number.isInteger(ix)||!semanticPool[ix]||rel<0.65)return;
          var f=semanticPool[ix], d=docs[String(f.doc_id)]||{};
          all.push({feedback_id:String(f.feedback_id),quote:String(f.quote),sentiment:String(f.sentiment||'unknown').toLowerCase(),source:String(d.title||''),url:String(d.url||''),published_at:d.published_at||f.created_at||'',platform:String(d.platform||''),doc_id:String(f.doc_id||''),matched_terms:[],matched_topics:['AI 语义匹配'],match_type:'semantic',score:rel*4,relevance:rel,reason:String(m.reason||'AI 判断语义相关')});
          semanticAdded++;
        });
      }
    } catch(semanticError) { Logger.log('语义检索失败，继续返回关键词结果：'+String(semanticError).slice(0,300)); }
  }
  all.sort(function(a,b) { return b.score-a.score || String(b.published_at).localeCompare(String(a.published_at)); });
  var total = all.length, page = Math.max(1, parseInt(params.page,10) || 1), pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize,10) || 20));
  var result = all.slice((page-1)*pageSize, page*pageSize);
  var note = enabled ? '关键词与同义词匹配优先；已尝试语义检索补充 '+semanticAdded+' 条真实评论。' : '当前使用关键词与同义词检索；如需语义检索，可在 Script Properties 中将 ENABLE_SEMANTIC_REVIEW_SEARCH 设为 true。';
  return {product_id:String(productId), query:query, total:total, page:page, pageSize:pageSize, results:result, parsedGroups:groups.map(function(g){return {label:g.label,terms:g.terms};}), note:note};
}
