/* SpecificationTasks.gs — 分类规格字典、可重试任务队列与官方规格采集。
 * 唯一的规格采集主链路：任务队列 / 手动刷新 / 比较都复用这里的解析与写表函数。 */

var SPEC_CATEGORY_SEEDS_ = [
  ['mouse','鼠标'],['trackball','轨迹球'],['pointing_device','指向设备'],['keyboard','键盘'],['combo','键鼠套装'],['headset','游戏耳机'],['headphones','耳机'],['earbuds','耳塞'],['speaker','扬声器'],['webcam','网络摄像头'],['conference_camera','会议摄像头'],['conference_system','会议系统'],['speakerphone','扬声器电话'],['microphone','麦克风'],['gaming_controller','游戏控制器'],['racing_wheel','赛车方向盘'],['flight_simulation','飞行模拟设备'],['presenter','演示器'],['tablet_accessory','平板配件'],['lighting','灯光'],['mousepad','鼠标垫'],['receiver','接收器'],['stand','支架'],['accessory','配件']
];
var SPEC_DEFINITION_SEEDS_ = [
  ['weight_g','重量','*','physical','number','g','',1,1,'weight','convert_to_grams',0,10,1,'重量统一为克'],
  ['length_mm','长度','*','physical','number','mm','',1,1,'dimensions','convert_to_mm',0,20,1,'长度统一为毫米'],
  ['width_mm','宽度','*','physical','number','mm','',1,1,'dimensions','convert_to_mm',0,21,1,'宽度统一为毫米'],
  ['height_mm','高度','*','physical','number','mm','',1,1,'dimensions','convert_to_mm',0,22,1,'高度统一为毫米'],
  ['connectivity','连接方式','*','connectivity','string','','wired;LIGHTSPEED;Bluetooth;2.4GHz;USB-C;USB-A',1,1,'connectivity','normalize_connectivity',0,30,1,'可多值，保留来源原文'],
  ['battery_life_hours','电池续航','*','power','number','hours','',1,1,'battery','normalize_hours',0,40,1,'需记录测试条件'],
  ['sensor','传感器','mouse','sensor','string','','',0,1,'sensor','trim',0,50,1,'鼠标适用'],
  ['max_dpi','最高 DPI','mouse','sensor','number','DPI','',0,1,'dpi','numeric',0,51,1,'鼠标适用'],
  ['max_polling_rate_hz','最高轮询率','mouse','performance','number','Hz','',0,1,'polling','normalize_hz',0,52,1,'鼠标适用'],
  ['buttons','按键数','mouse','controls','number','buttons','',0,1,'buttons','numeric',0,53,1,'鼠标适用'],
  ['switch_type','微动类型','mouse','controls','string','','',0,1,'switch','trim',0,54,1,'鼠标适用'],
  ['switch_lifecycle','微动寿命','mouse','durability','number','clicks','',0,1,'switch_lifecycle','numeric',0,55,1,'点击寿命'],
  ['onboard_memory','板载内存','mouse','software','string','','yes;no',0,1,'memory','normalize_boolean',0,56,1,'是否支持板载配置'],
  ['software_requirement','软件要求','*','software','string','','',0,1,'software','trim',0,60,1,'官方软件信息'],
  ['layout','配列/布局','keyboard','layout','string','','',0,1,'layout','trim',0,70,1,'键盘适用'],
  ['microphone','麦克风','headset','audio','string','','',0,1,'microphone','trim',0,80,1,'耳机适用'],
  ['compatibility','兼容性','*','compatibility','string','','',0,1,'compatibility','trim',0,90,1,'兼容平台/设备'],
  ['msrp','建议零售价','*','commercial','string','','',0,1,'price','preserve_currency',0,100,1,'保留币种']
];

/* ---------- 官方页面访问白名单与抓取 ---------- */

var OFFICIAL_PRODUCT_DOMAINS_ = [
  'logitech.com','logitechg.com','gaming.logitech.com','razer.com','steelseries.com',
  'corsair.com','hyperx.com','sony.com','asus.com','rog.asus.com','apple.com',
  'dell.com','alienware.com','hp.com','lenovo.com','msi.com','acer.com','samsung.com',
  'microsoft.com','support.microsoft.com','bose.com','sennheiser-hearing.com',
  'jbl.com','audio-technica.com','shure.com','keychron.com','wooting.com'
];

function isAllowedOfficialProductUrl_(url) {
  try {
    var host = String(url).match(/^https?:\/\/([^\/:?#]+)/i);
    if (!host) return false;
    var h = host[1].toLowerCase().replace(/^www\./,'');
    return OFFICIAL_PRODUCT_DOMAINS_.some(function(d){ return h === d || h.slice(-(d.length+1)) === '.'+d; });
  } catch(e) { return false; }
}

// 按品牌名选主域名，搜索查询只限定品牌相关站点，避免 20 个 site: OR 稀释产品名权重。
function detectBrandDomains_(productName) {
  var s = String(productName || '').toLowerCase();
  if (/^logitech\s*g\b|logitechg/.test(s)) return ['logitechg.com', 'logitech.com'];
  if (/^logitech\b/.test(s)) return ['logitech.com', 'logitechg.com'];
  if (/^razer\b/.test(s)) return ['razer.com'];
  if (/^steelseries\b/.test(s)) return ['steelseries.com'];
  if (/^corsair\b/.test(s)) return ['corsair.com'];
  if (/^hyperx\b/.test(s)) return ['hyperx.com'];
  if (/^sony\b/.test(s)) return ['sony.com'];
  if (/^asus\b|^rog\b/.test(s)) return ['asus.com', 'rog.asus.com'];
  if (/^apple\b/.test(s)) return ['apple.com'];
  if (/^dell\b|^alienware\b/.test(s)) return ['dell.com', 'alienware.com'];
  if (/^hp\b/.test(s)) return ['hp.com'];
  if (/^lenovo\b/.test(s)) return ['lenovo.com'];
  if (/^msi\b/.test(s)) return ['msi.com'];
  if (/^acer\b/.test(s)) return ['acer.com'];
  if (/^samsung\b/.test(s)) return ['samsung.com'];
  if (/^microsoft\b/.test(s)) return ['microsoft.com'];
  if (/^bose\b/.test(s)) return ['bose.com'];
  if (/^sennheiser\b/.test(s)) return ['sennheiser-hearing.com'];
  if (/^jbl\b/.test(s)) return ['jbl.com'];
  if (/^audio.?technica\b/.test(s)) return ['audio-technica.com'];
  if (/^shure\b/.test(s)) return ['shure.com'];
  if (/^keychron\b/.test(s)) return ['keychron.com'];
  if (/^wooting\b/.test(s)) return ['wooting.com'];
  return OFFICIAL_PRODUCT_DOMAINS_.slice(0, 6);
}

// URL slug 猜测：针对 URL 规律已知的品牌站，零搜索成本，命中率最高。
// logitechg/logitech 产品页模式：/en-us/shop/p/{slug} 或 .html
function guessProductUrlCandidates_(productName) {
  var raw = String(productName || '').toLowerCase().trim();
  if (!raw) return [];
  var stripped = raw.replace(/^(logitech\s*g|logitech|razer|steelseries|corsair|hyperx|sony|asus|rog|apple|dell|alienware|hp|lenovo|msi|acer|samsung|microsoft|bose|sennheiser|jbl|audio-technica|shure|keychron|wooting)\s+/i, '').trim();
  if (!stripped) return [];

  function toSlug(s) { return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  var slugs = [toSlug(stripped)];
  var noCat = stripped.replace(/\s+(gaming\s+)?(mouse|keyboard|headset|headphones|earbuds|speaker|microphone|camera|webcam)$/i, '').trim();
  if (noCat && noCat !== stripped) slugs.push(toSlug(noCat));
  var noWireless = stripped.replace(/\s+(wireless|wired|bluetooth)\s*/gi, ' ').trim();
  if (noWireless && noWireless !== stripped) slugs.push(toSlug(noWireless));

  var seen = {};
  var out = [];
  slugs.forEach(function(slug) {
    if (!slug || seen[slug]) return;
    seen[slug] = 1;
    out.push('https://www.logitechg.com/en-us/shop/p/' + slug + '.html');
    out.push('https://www.logitechg.com/en-us/shop/p/' + slug);
    out.push('https://www.logitech.com/en-us/shop/p/' + slug + '.html');
    out.push('https://www.logitech.com/en-us/shop/p/' + slug);
  });
  return out;
}

function searchOfficialProductCandidates_(productName) {
  var q = String(productName || '').trim();
  if (!q) return [];

  // 1) slug 猜测候选排最前：零搜索成本，verifyProductUrl_ 会逐个 fetch 验证存在性。
  var slugCandidates = guessProductUrlCandidates_(q);
  var all = [], seenAll = {};
  slugCandidates.forEach(function(u) { if (!seenAll[u]) { seenAll[u] = 1; all.push(u); } });

  // 2) 搜索引擎：精确产品名 + 限定品牌主域名 + buy 引导产品页，避免分类页/旧款。
  var brandDomains = detectBrandDomains_(q);
  var domainQuery = brandDomains.map(function(d){return 'site:'+d;}).join(' OR ');
  var query = '"' + q + '" (' + domainQuery + ') buy';
  var engines = [
    'https://www.google.com/search?num=10&q=' + encodeURIComponent(query),
    'https://www.bing.com/search?count=10&q=' + encodeURIComponent(query),
    'https://www.html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
  ];
  for (var e=0;e<engines.length;e++) {
    try {
      var response = UrlFetchApp.fetch(engines[e], {muteHttpExceptions:true, followRedirects:true,
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'}});
      if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) continue;
      var html = response.getContentText().slice(0, 500000);
      var found = [], seen = {};
      var re = /href=["']([^"']+)["']/gi, m;
      while ((m = re.exec(html)) !== null && found.length < 60) {
        var href = m[1].replace(/&amp;/g,'&');
        var target = '';
        if (href.indexOf('/url?') === 0) {
          var qm = href.match(/[?&](?:q|url)=([^&]+)/);
          if (qm) { try { target = decodeURIComponent(qm[1]); } catch(ex) { target = qm[1]; } }
        } else if (/duckduckgo\.com\/l\//i.test(href)) {
          var dm = href.match(/[?&]uddg=([^&]+)/);
          if (dm) { try { target = decodeURIComponent(dm[1]); } catch(ex3) { target = dm[1]; } }
        } else if (/^https?:\/\//i.test(href)) {
          target = href;
          if (/^https?:\/\/www\.bing\.com\/ck\/a\?/i.test(target)) {
            var um = target.match(/[?&]u=a1([^&]+)/i);
            if (um) { try { target = Utilities.newBlob(Utilities.base64DecodeWebSafe(um[1].replace(/^a1/,''))).getDataAsString(); } catch(ex2) {} }
          }
        } else if (href.indexOf('//') === 0) {
          target = 'https:' + href;
        }
        if (!target || !isAllowedOfficialProductUrl_(target)) continue;
        target = target.split('#')[0];
        if (/[?&](?:gclid|ved|usg|utm_)/i.test(target)) target = target.split('?')[0];
        if (!seen[target]) { seen[target] = true; found.push(target); }
      }
      found.forEach(function(u) {
        if (!seenAll[u]) { seenAll[u] = true; all.push(u); }
      });
    } catch(ignore) { /* try next public search engine */ }
  }
  // 三个搜索引擎都拿不到可用链接时（常见于 GAS 出口被拦或结果页是 JS 渲染），用 Crawl4AI 渲染搜索结果页兜底。
  if (all.length <= slugCandidates.length && typeof crawl4aiCanRender_ === 'function' && crawl4aiCanRender_()) {
    try {
      crawl4aiDiscoverOfficialUrls_(query).forEach(function(u) {
        if (!seenAll[u]) { seenAll[u] = true; all.push(u); }
      });
    } catch (e) { Logger.log('Crawl4AI 搜索结果兜底失败：' + String(e).slice(0, 200)); }
  }

  // 搜索结果按产品页特征排序；slug 候选已在最前，不参与重排。
  var slugSet = {};
  slugCandidates.forEach(function(u) { slugSet[u] = 1; });
  var slugPart = all.filter(function(u) { return slugSet[u]; });
  var searchPart = all.filter(function(u) { return !slugSet[u]; });
  searchPart.sort(function(a,b){
    function score(u){var path=(u.split('/').slice(3).join('/')||'').toLowerCase(); var n=0;
      if (/product|products|gaming|mouse|keyboard|headset|spec|p\//.test(path)) n+=3;
      if (/support|search|category|accessories/.test(path)) n-=2;
      if (path) n+=1;
      return n;}
    return score(b)-score(a);
  });
  var productLike = searchPart.filter(function(u){ return /^https:\/\//i.test(u) && u.split('/').length > 4; });
  return slugPart.concat(productLike.length ? productLike : searchPart).slice(0, 12);
}


function searchOfficialProductPage_(productName) {
  return searchOfficialProductCandidates_(productName)[0] || null;
}

/**
 * 规格页面抓取入口：按 activeSpecCrawler_() 分派。
 * crawl4ai → Crawl4AI Cloud /extract（可渲染 JS 页面，自带 LLM 抽取，不需要 Gemini Key）
 * urlfetch → 本地抓 HTML + Gemini/OpenRouter 抽取（无 Crawl4AI Key 时的回退）
 * 两条路径输出结构一致，saveOfficialSpecs_() 无需区分。
 */
function extractOfficialSpecs_(productName, url) {
  if (activeSpecCrawler_() === 'crawl4ai') return extractSpecsViaCrawl4AI_(productName, url);
  return extractOfficialSpecsViaFetch_(productName, url);
}

function extractOfficialSpecsViaFetch_(productName, url) {
  if (!isAllowedOfficialProductUrl_(url)) throw new Error('搜索结果不是允许访问的品牌官网');
  var response = UrlFetchApp.fetch(url, {muteHttpExceptions:true, followRedirects:true,
    headers:{'User-Agent':'Mozilla/5.0 (compatible; ProductIntelligence/1.0)'}});
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('官网页面返回 HTTP '+code);
  var html = response.getContentText().slice(0, 180000);
  var text = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi,' ').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"')
    .replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').slice(0,35000);
  var prompt = '你是严谨的产品规格提取器。以下内容来自公开品牌官网。提取页面明确提供的产品名称、品牌、型号和规格；不得使用训练记忆补全，不得推测。只返回 JSON：' +
    '{"product_name":"","brand":"","model":"","specs":[{"spec_key":"weight_g","spec_label":"重量","value":"60","unit":"g","raw_value":"60 g"}]}。' +
    '优先使用统一字段：weight_g, length_mm, width_mm, height_mm, sensor, max_dpi, max_polling_rate_hz, buttons, connectivity, wireless_protocol, battery_life_hours, charging, compatibility, switch_type, layout, microphone, msrp。' +
    '重量统一 g，尺寸 mm，DPI 保留 DPI，回报率 Hz，续航 hours；价格必须保留币种。若没有明确规格则省略。' +
    '\n用户输入产品名：'+productName+'\n官方来源 URL：'+url+'\n网页文本：'+text;
  var parsed = extractJson_(callAI(prompt, null, {maxTokens:4096}));
  return {name:String(parsed.product_name || productName), brand:String(parsed.brand || ''), model:String(parsed.model || ''),
    official_url:url, specs:(parsed.specs || []).filter(function(s){return s && s.spec_key && String(s.value || '').trim();}) ,
    source_url:url, fetched_at:new Date().toISOString(), verification_status:'ai_extracted_unverified'};
}

/* ---------- 字典初始化 ---------- */

function seedProductCategories_() {
  try {
    var existing=readTable('ProductCategories');
    if(!existing.length) SPEC_CATEGORY_SEEDS_.forEach(function(c,i){appendRow('ProductCategories',{category_key:c[0],category_label:c[1],is_active:1,display_order:i+1});});
  } catch(e) { Logger.log('产品类别初始化跳过：'+e); }
}

function seedSpecificationDefinitions_() {
  try {
    var defs = readTable('SpecificationDefinitions');
    if (!defs.length) SPEC_DEFINITION_SEEDS_.forEach(function(r){appendRow('SpecificationDefinitions',{spec_key:r[0],spec_label:r[1],category:r[2],subcategory:r[3],data_type:r[4],unit:r[5],allowed_values:r[6],is_common:r[7],is_comparable:r[8],comparison_group:r[9],normalization_rule:r[10],is_required:r[11],display_order:r[12],is_active:r[13],definition_notes:r[14]});});
  } catch(e) { Logger.log('规格字典初始化跳过：' + e); }
}

/* ---------- 任务队列 ---------- */

function enqueueSpecificationTask_(productId, reason, priority) {
  if (!ss_().getSheetByName('SpecificationTasks')) setupSheets();
  var pid = String(productId || '').trim(); if (!pid) return null;
  var tasks = readTable('SpecificationTasks');
  var active = tasks.some(function(t){return String(t.product_id)===pid && ['queued','running','retry'].indexOf(String(t.status))>=0;});
  if (active) return null;
  var product = readTable('Products').filter(function(p){return String(p.product_id)===pid;})[0];
  if (!product) return null;
  var pstatus = String(product.status || '').toLowerCase();
  if (pstatus === 'merged' || pstatus === 'brand' || pstatus === 'quarantined') return null;
  if (String(product.category || '').toLowerCase() === 'brand') return null;
  // 没有通过官网 URL 核验的产品不进入规格采集，避免把无法溯源的数据写入规格表。
  if (!isProductUrlVerified_(product)) return null;
  var taskId = nextId('SPEC-TASK','SpecificationTasks','task_id');
  appendRow('SpecificationTasks',{task_id:taskId,product_id:pid,task_type:'initial_fetch',status:'queued',priority:Number(priority)||3,attempt_count:0,max_attempts:3,next_attempt_at:new Date().toISOString(),created_at:new Date().toISOString(),started_at:'',finished_at:'',last_error:'',source_url:product.official_url||'',parser_version:'v1',task_notes:String(reason||'')});
  return taskId;
}

function enqueueMissingSpecificationTasks_() {
  var products = readTable('Products').filter(function(p){return p.status!=='merged' && p.category!=='brand';});
  var specs = readTable('ProductSpecifications'); var created=[];
  products.forEach(function(p){
    var has = specs.some(function(s){return String(s.product_id)===String(p.product_id) && String(s.value||'').trim() && !/deprecated/i.test(String(s.verification_status||''));});
    if (!has) { var id=enqueueSpecificationTask_(p.product_id,'missing_specifications',2); if(id) created.push(id); }
  });
  return {queued:created.length,task_ids:created};
}

function updateSpecificationTask_(taskId, updates) {
  var sh=sheet_('SpecificationTasks'), vals=sh.getDataRange().getValues(); if(vals.length<2)return false;
  var headers=vals[0].map(function(h){return String(h).trim();}), ix={}; headers.forEach(function(h,i){ix[h]=i;});
  for(var r=1;r<vals.length;r++) if(String(vals[r][ix.task_id])===String(taskId)) {
    Object.keys(updates).forEach(function(k){if(ix[k]!=null) sh.getRange(r+1,ix[k]+1).setValue(updates[k]);}); return true;
  }
  return false;
}

function saveOfficialSpecs_(product, sourceUrl, parsed, parserName) {
  var specs = (parsed.specs||[]).filter(function(s){return s && s.spec_key && String(s.value==null?'':s.value).trim()!=='';});
  if (!specs.length) throw new Error('官网页面未提取到可保存的明确参数');
  var now=new Date().toISOString(), old=readTable('ProductSpecifications');
  // Only replace a product's records after a non-empty extraction; preserve old data on failure.
  var keep=old.filter(function(r){return String(r.product_id)!==String(product.product_id);});
  specs.forEach(function(s){
    var key=String(s.spec_key), value=String(s.value), unit=String(s.unit||''), raw=String(s.raw_value||s.value);
    keep.push({spec_id:String(product.product_id)+'-'+key,product_id:product.product_id,spec_key:key,spec_label:String(s.spec_label||key),value:value,unit:unit,raw_value:raw,source_url:sourceUrl,fetched_at:now,verification_status:'parsed_official'});
    appendRow('ProductSpecificationsRaw',{raw_record_id:nextId('SPEC-RAW','ProductSpecificationsRaw','raw_record_id'),product_id:product.product_id,spec_key:key,source_url:sourceUrl,source_type:'official_web',raw_label:String(s.spec_label||key),raw_value:raw,raw_unit:unit,normalized_value:value,normalized_unit:unit,fetched_at:now,parser_name:parserName||'official_page_ai_parser',verification_status:'parsed_official',evidence_notes:'从官方页面提取；建议人工抽查'});
  });
  var sh=sheet_('ProductSpecifications'), headers=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h).trim();});
  sh.clearContents(); sh.getRange(1,1,1,headers.length).setValues([headers]);
  if(keep.length) sh.getRange(2,1,keep.length,headers.length).setValues(keep.map(function(r){return headers.map(function(h){return r[h]!==undefined?r[h]:'';});}));
  return {count:specs.length,fetched_at:now};
}

function resolveOfficialUrl_(product) {
  // 只接受已实际抓取核验、且页面内容与产品匹配的官网 URL。
  return ensureVerifiedProductUrl_(product);
}

function processSpecificationTasks_(limit) {
  limit=Math.max(1,Math.min(10,Number(limit)||3));
  var tasks=readTable('SpecificationTasks').filter(function(t){
    if(['queued','retry'].indexOf(String(t.status))<0)return false;
    var next=t.next_attempt_at?new Date(t.next_attempt_at):null; return !next||isNaN(next.getTime())||next.getTime()<=Date.now();
  }).sort(function(a,b){return Number(b.priority||0)-Number(a.priority||0)||String(a.created_at).localeCompare(String(b.created_at));}).slice(0,limit);
  var products=readTable('Products'), results=[];
  tasks.forEach(function(t){
    var attempts=Number(t.attempt_count||0)+1;
    updateSpecificationTask_(t.task_id,{status:'running',attempt_count:attempts,started_at:new Date().toISOString(),last_error:''});
    try {
      var p=products.filter(function(x){return String(x.product_id)===String(t.product_id);})[0];
      if(!p)throw new Error('产品记录不存在');
      // Crawl4AI 路径自带 LLM 抽取，不需要 Gemini/OpenRouter Key。
      if(activeSpecCrawler_()==='urlfetch' && !hasConfiguredAIKey_())throw new Error('未配置 AI API Key；任务保留为可重试状态');
      var url=resolveOfficialUrl_(p);
      var parsed=extractOfficialSpecs_(String(p.brand||'')+' '+String(p.canonical_name||''),url);
      var saved=saveOfficialSpecs_(p,url,parsed,specParserName_());
      updateSpecificationTask_(t.task_id,{status:'done',finished_at:new Date().toISOString(),source_url:url,last_error:'',task_notes:'采集完成：'+saved.count+' 项规格'});
      results.push({task_id:t.task_id,product_id:p.product_id,status:'done',count:saved.count,url:url});
    } catch(e) {
      var message=String(e).slice(0,500), max=Number(t.max_attempts||3), failed=attempts>=max;
      var delayHours=Math.min(24,Math.pow(2,Math.max(0,attempts-1)));
      updateSpecificationTask_(t.task_id,{status:failed?'failed':'retry',finished_at:failed?new Date().toISOString():'',next_attempt_at:failed?'':new Date(Date.now()+delayHours*3600000).toISOString(),last_error:message});
      results.push({task_id:t.task_id,product_id:t.product_id,status:failed?'failed':'retry',error:message});
    }
  });
  clearCache(); return {processed:results.length,results:results};
}

/** 手动刷新：唯一的产品规格写入口，供前端“重新获取官网规格”使用。 */
function refreshProductSpecifications_(idsRaw) {
  var ids = String(idsRaw || '').split(',').map(function(s){return s.trim();}).filter(Boolean);
  if (!ids.length) throw new Error('缺少产品 ID');
  if (activeSpecCrawler_() === 'urlfetch' && !hasConfiguredAIKey_()) throw new Error('请先在 Script Properties 中配置 CRAWL4AI_API_KEY，或 GEMINI_API_KEY / OPENROUTER_API_KEY');
  var products = readTable('Products').filter(function(p){
    return ids.indexOf(String(p.product_id)) >= 0 && p.status !== 'merged' && p.category !== 'brand';
  });
  var updated = [];
  products.forEach(function(p) {
    try {
      var url = resolveOfficialUrl_(p);
      var live = extractOfficialSpecs_(String(p.brand||'')+' '+String(p.canonical_name||''), url);
      var saved = saveOfficialSpecs_(p, url, live, specParserName_());
      updated.push({product_id:p.product_id, name:p.canonical_name, status:'updated', count:saved.count, source_url:url, fetched_at:saved.fetched_at});
    } catch(e) {
      updated.push({product_id:p.product_id, name:p.canonical_name, status:'error', message:String(e).slice(0,220)});
    }
  });
  clearCache();
  return {results:updated};
}

function buildSpecificationTaskStatus_() {
  var tasks=readTable('SpecificationTasks'), counts={};
  tasks.forEach(function(t){counts[t.status]=(counts[t.status]||0)+1;});
  return {total:tasks.length,counts:counts,recent:tasks.slice(-50).reverse()};
}

function installSpecificationTaskTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()==='runSpecificationTaskQueue')ScriptApp.deleteTrigger(t);});
  ScriptApp.newTrigger('runSpecificationTaskQueue').timeBased().everyHours(6).create();
  return '已安装每 6 小时运行一次的规格任务队列触发器。';
}

function runSpecificationTaskQueue() { return processSpecificationTasks_(3); }
