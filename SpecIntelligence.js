const SPEC_PIV1_SHEETS = {
  dictionary: 'Specification_Dictionary',
  raw: 'Product_Specifications_Raw',
  canonical: 'Product_Specifications'
};

const SPEC_PIV1_MOUSE_FIELDS = [
  {spec_id:'SPEC-MOUSE-001',category:'mouse',canonical_field:'weight_g',display_name:'重量',description:'产品本体重量',data_type:'number',canonical_unit:'g',normalization_rule:'convert_to_grams',comparison_direction:'lower',required:0,aliases:'weight;重量;gram;grams;克'},
  {spec_id:'SPEC-MOUSE-002',category:'mouse',canonical_field:'sensor_name',display_name:'传感器型号',description:'传感器官方名称',data_type:'string',canonical_unit:'',normalization_rule:'trim',comparison_direction:'neutral',required:0,aliases:'sensor;sensor name;传感器;感应器'},
  {spec_id:'SPEC-MOUSE-003',category:'mouse',canonical_field:'max_dpi',display_name:'最高 DPI',description:'官方标称最高 DPI/CPI',data_type:'number',canonical_unit:'DPI',normalization_rule:'numeric',comparison_direction:'higher',required:0,aliases:'dpi;cpi;max dpi;maximum dpi;最高dpi'},
  {spec_id:'SPEC-MOUSE-004',category:'mouse',canonical_field:'max_tracking_speed_ips',display_name:'最高跟踪速度',description:'官方标称最高 IPS',data_type:'number',canonical_unit:'IPS',normalization_rule:'numeric',comparison_direction:'higher',required:0,aliases:'ips;tracking speed;max speed;跟踪速度'},
  {spec_id:'SPEC-MOUSE-005',category:'mouse',canonical_field:'max_acceleration_g',display_name:'最大加速度',description:'官方标称最大加速度',data_type:'number',canonical_unit:'G',normalization_rule:'numeric',comparison_direction:'higher',required:0,aliases:'acceleration;max acceleration;加速度'},
  {spec_id:'SPEC-MOUSE-006',category:'mouse',canonical_field:'polling_rate_hz',display_name:'轮询率',description:'官方标称无线或有线轮询率',data_type:'number',canonical_unit:'Hz',normalization_rule:'normalize_hz',comparison_direction:'higher',required:0,aliases:'polling rate;report rate;回报率;轮询率;hz'},
  {spec_id:'SPEC-MOUSE-007',category:'mouse',canonical_field:'switch_type',display_name:'微动类型',description:'主按键微动或开关类型',data_type:'string',canonical_unit:'',normalization_rule:'trim',comparison_direction:'neutral',required:0,aliases:'switch;switch type;micro switch;微动;按键开关'},
  {spec_id:'SPEC-MOUSE-008',category:'mouse',canonical_field:'connectivity',display_name:'连接方式',description:'官方列出的连接方式',data_type:'string',canonical_unit:'',normalization_rule:'trim',comparison_direction:'neutral',required:0,aliases:'connectivity;connection;wireless;wired;连接方式;无线;有线'},
  {spec_id:'SPEC-MOUSE-009',category:'mouse',canonical_field:'battery_life_hours',display_name:'电池续航',description:'官方标称续航小时数',data_type:'number',canonical_unit:'hours',normalization_rule:'normalize_hours',comparison_direction:'higher',required:0,aliases:'battery life;battery;hours;续航;电池'},
  {spec_id:'SPEC-MOUSE-010',category:'mouse',canonical_field:'dimensions_length_mm',display_name:'长度',description:'产品长度',data_type:'number',canonical_unit:'mm',normalization_rule:'convert_to_mm',comparison_direction:'lower',required:0,aliases:'length;dimension length;长度'},
  {spec_id:'SPEC-MOUSE-011',category:'mouse',canonical_field:'dimensions_width_mm',display_name:'宽度',description:'产品宽度',data_type:'number',canonical_unit:'mm',normalization_rule:'convert_to_mm',comparison_direction:'lower',required:0,aliases:'width;dimension width;宽度'},
  {spec_id:'SPEC-MOUSE-012',category:'mouse',canonical_field:'dimensions_height_mm',display_name:'高度',description:'产品高度',data_type:'number',canonical_unit:'mm',normalization_rule:'convert_to_mm',comparison_direction:'lower',required:0,aliases:'height;dimension height;高度'},
  {spec_id:'SPEC-MOUSE-013',category:'mouse',canonical_field:'onboard_memory',display_name:'板载内存',description:'是否支持板载配置存储',data_type:'string',canonical_unit:'',normalization_rule:'trim',comparison_direction:'neutral',required:0,aliases:'onboard memory;onboard profiles;板载内存;板载配置'}
];

const SPEC_PIV1_SOURCE_PRIORITY = {
  official_product: 100,
  official_technical: 95,
  official_support: 90,
  official_pdf: 85,
  third_party: 50
};

function seedSpecificationDictionary_() {
  try {
    var existing = readTable(SPEC_PIV1_SHEETS.dictionary);
    if (!existing.length) {
      var now = new Date().toISOString();
      SPEC_PIV1_MOUSE_FIELDS.forEach(function(f) {
        appendRow(SPEC_PIV1_SHEETS.dictionary, {
          spec_id:f.spec_id,
          category:f.category,
          canonical_field:f.canonical_field,
          display_name:f.display_name,
          description:f.description,
          data_type:f.data_type,
          canonical_unit:f.canonical_unit,
          normalization_rule:f.normalization_rule,
          comparison_direction:f.comparison_direction,
          required:f.required,
          aliases:f.aliases,
          created_at:now,
          updated_at:now
        });
      });
    }
  } catch (e) {
    Logger.log('规格字典初始化跳过：' + String(e));
  }
}

function specPocSetting_(name, fallback) {
  var value = typeof scriptProperty_ === 'function' ? scriptProperty_(name) : '';
  return value === null || value === undefined || value === '' ? fallback : value;
}

function spiEnsureSheets_() {
  var ss = ss_();
  var missing = Object.keys(SPEC_PIV1_SHEETS).some(function(k) { return !ss.getSheetByName(SPEC_PIV1_SHEETS[k]); });
  if (missing) setupSheets();
}

function spiProductReadyForSpecs_(product) {
  if (!product) return false;
  var urlVerified = typeof isProductUrlVerified_ === 'function'
    ? isProductUrlVerified_(product)
    : (!!String(product.official_url || '').trim() && String(product.official_url_status || '').toLowerCase() === 'verified');
  if (!urlVerified) return false;
  var status = String(product.identity_status || '').toLowerCase();
  var resolution = String(product.resolution_status || '').toLowerCase();
  var source = String(product.identity_source || '').toLowerCase();
  if (source === 'ai_hint' || source === 'fallback_hint') return false;
  return status === 'confirmed'
    || resolution === 'confirmed'
    || (!!String(product.official_name || '').trim() && source !== 'ai');
}

function spiGetProduct_(productId) {
  var rows = readTable('Products');
  var id = String(productId || '').trim();
  return rows.filter(function(p) {
    return String(p.product_id || '').trim() === id || String(p.canonical_name || '').trim() === id;
  })[0] || null;
}

function spiGetDictionary_(category) {
  var rows = [];
  try { rows = readTable(SPEC_PIV1_SHEETS.dictionary); } catch (e) { rows = []; }
  if (!rows.length) {
    rows = SPEC_PIV1_MOUSE_FIELDS.map(function(f) {
      return {
        spec_id:f.spec_id,
        category:f.category,
        canonical_field:f.canonical_field,
        display_name:f.display_name,
        description:f.description,
        data_type:f.data_type,
        canonical_unit:f.canonical_unit,
        normalization_rule:f.normalization_rule,
        comparison_direction:f.comparison_direction,
        required:f.required,
        aliases:f.aliases
      };
    });
  }
  var cat = String(category || 'mouse').toLowerCase();
  return rows.filter(function(r) {
    var c = String(r.category || '').toLowerCase();
    return c === cat || c === '*';
  });
}

function spiHash_(value) {
  var s = String(value || '');
  if (typeof Utilities !== 'undefined' && Utilities.DigestAlgorithm && Utilities.computeDigest) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s);
    return bytes.map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0, 24);
  }
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

function spiRawId_(productId, canonicalField, sourceUrl, rawValue, evidenceText, contentHash) {
  return 'SPIRAW-' + spiHash_([productId, canonicalField, sourceUrl, rawValue, evidenceText, contentHash].join('|'));
}

function spiCanonicalKey_(productId, canonicalField) {
  return String(productId || '') + '|' + String(canonicalField || '');
}

function spiCleanText_(value, maxChars) {
  var s = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  var max = Number(maxChars) || 35000;
  return s.slice(0, max);
}

function spiClassifySpecSource_(url) {
  var u = String(url || '').toLowerCase();
  var official = typeof isAllowedOfficialProductUrl_ === 'function' ? isAllowedOfficialProductUrl_(u) : false;
  if (!official) return 'third_party';
  if (/\.pdf(?:\?|$)/.test(u)) return 'official_pdf';
  if (/(^|\/|\.)support\./.test(u) || /\/support\//.test(u)) return 'official_support';
  if (/\/spec|technical|tech[-_]?spec|specifications/.test(u)) return 'official_technical';
  return 'official_product';
}

function spiSourcePriority_(sourceType) {
  return SPEC_PIV1_SOURCE_PRIORITY[sourceType] || 0;
}

function spiThirdPartyAllowed_() {
  return String(specPocSetting_('SPEC_POC_ALLOW_THIRD_PARTY', '0')).toLowerCase() === '1'
    || String(specPocSetting_('SPEC_POC_ALLOW_THIRD_PARTY', '0')).toLowerCase() === 'true';
}

function spiProductQuery_(product) {
  var parts = [String(product.brand || ''), String(product.canonical_name || ''), String(product.official_name || '')];
  return spiCleanText_(parts.filter(Boolean).join(' '), 180);
}

function spiIdentityForProduct_(product, deadline) {
  if (typeof storedProductIdentity_ === 'function') {
    var stored = storedProductIdentity_(product);
    if (stored && (stored.official_names || []).length) return stored;
  }
  if (typeof resolveProductIdentity_ === 'function') return resolveProductIdentity_(product, deadline);
  return {official_names:[String(product.official_name || product.canonical_name || '')], aliases:[], brand_domains:[], search_queries:[], source:'stored', confidence:'medium'};
}

function spiOfficialNames_(identity, product) {
  if (typeof identityOfficialNames_ === 'function') return identityOfficialNames_(identity, product);
  return (identity && identity.official_names ? identity.official_names : [product.canonical_name]).filter(Boolean);
}

function discoverProductSpecUrls(productId) {
  var product = spiGetProduct_(productId);
  if (!product) return {status:'product_not_found', product_id:String(productId || ''), candidates:[]};
  var query = spiProductQuery_(product);
  var candidates = [];
  var seen = {};
  var deadline = Date.now() + 60000;

  function add(url, via) {
    var u = String(url || '').split('#')[0].trim();
    if (!/^https?:\/\//i.test(u) || seen[u]) return;
    var sourceType = spiClassifySpecSource_(u);
    if (sourceType === 'third_party' && !spiThirdPartyAllowed_()) return;
    seen[u] = 1;
    candidates.push({
      url:u,
      via:via || 'candidate',
      source_type:sourceType,
      source_priority:spiSourcePriority_(sourceType),
      verification_status:'pending',
      evidence:'候选来源来自官网搜索或产品已有官网字段；仍须逐页验证产品身份'
    });
  }

  add(product.official_url, 'products_field');
  if (typeof searchOfficialProductCandidates_ === 'function') {
    try {
      var domains = typeof detectBrandDomains_ === 'function'
        ? detectBrandDomains_(String(product.brand || '') + ' ' + String(product.canonical_name || ''))
        : [];
      searchOfficialProductCandidates_(query, deadline, {queries:[query], domains:domains}).forEach(function(u) { add(u, 'search'); });
    } catch (e) {
      Logger.log('规格 URL 发现失败：' + String(e));
    }
  }
  if (typeof crawl4aiCanRender_ === 'function' && crawl4aiCanRender_()) {
    try {
      crawl4aiDiscoverOfficialUrls_(query, deadline).forEach(function(u) { add(u, 'crawl4ai'); });
    } catch (e) {
      Logger.log('Crawl4AI URL 发现失败：' + String(e));
    }
  }
  candidates.sort(function(a, b) { return b.source_priority - a.source_priority || a.url.localeCompare(b.url); });
  return {status:'ok', product_id:String(product.product_id), product_name:String(product.canonical_name || ''), query:query, candidates:candidates.slice(0, 12)};
}

function verifyProductSpecUrl(productId, url) {
  var product = spiGetProduct_(productId);
  if (!product) return {status:'product_not_found', url:String(url || ''), evidence:{}};
  var target = String(url || '').trim();
  var sourceType = spiClassifySpecSource_(target);
  if (sourceType === 'third_party' && !spiThirdPartyAllowed_()) {
    return {status:'rejected_third_party', url:target, source_type:sourceType, evidence:{reason:'未启用第三方来源'}};
  }
  var deadline = Date.now() + 60000;
  var identity = spiIdentityForProduct_(product, deadline);
  var officialNames = spiOfficialNames_(identity, product);
  var raw = null;
  if (typeof inspectOfficialProductUrl_ === 'function') {
    raw = inspectOfficialProductUrl_(target, product, deadline, null, officialNames, true);
  } else {
    var response = UrlFetchApp.fetch(target, {muteHttpExceptions:true, followRedirects:true});
    var code = response.getResponseCode();
    var html = response.getContentText().slice(0, 180000);
    var page = typeof extractPageIdentity_ === 'function' ? extractPageIdentity_(html) : {strongText:spiCleanText_(html, 2000), fullText:spiCleanText_(html, 35000), identifiers:[]};
    var matched = typeof productPageMatchesMulti_ === 'function'
      ? productPageMatchesMulti_(product, page, officialNames)
      : page.fullText.indexOf(String(product.canonical_name || '')) >= 0;
    raw = {status:matched && code >= 200 && code < 300 ? 'matched' : 'mismatch', code:code, title:page.title || '', via:'urlfetch'};
  }
  var matched = raw && raw.status === 'matched';
  return {
    status: matched ? 'verified' : String((raw && raw.status) || 'check_failed'),
    url: target,
    source_type: sourceType,
    source_priority: spiSourcePriority_(sourceType),
    checked_at: new Date().toISOString(),
    evidence: {
      product_id:String(product.product_id || ''),
      canonical_name:String(product.canonical_name || ''),
      brand:String(product.brand || ''),
      category:String(product.category || ''),
      official_names:officialNames,
      identity_source:String(identity.source || ''),
      title:String((raw && raw.title) || '').slice(0, 300),
      via:String((raw && raw.via) || ''),
      notes:String((raw && raw.notes) || '').slice(0, 900)
    }
  };
}

function spiFetchHtmlSource_(url, productLabel, deadline) {
  var metaKey = 'spec_source_meta:' + url;
  var meta = null;
  try { meta = cacheGet_(metaKey); } catch (e) { meta = null; }
  var headers = {'User-Agent':'Mozilla/5.0 (compatible; ProductIntelligence/1.0)'};
  if (meta && meta.etag) headers['If-None-Match'] = meta.etag;
  if (meta && meta.last_modified) headers['If-Modified-Since'] = meta.last_modified;
  var response = UrlFetchApp.fetch(url, {muteHttpExceptions:true, followRedirects:true, headers:headers});
  var code = response.getResponseCode();
  if (code === 304 && meta && meta.text) {
    return {text:meta.text, title:meta.title || '', strongText:meta.strongText || '', identifiers:meta.identifiers || [], canonical:meta.canonical || '', etag:meta.etag || '', lastModified:meta.last_modified || '', fetched_at:meta.fetched_at || new Date().toISOString(), from_cache:true};
  }
  if (code < 200 || code >= 300) throw new Error('规格来源返回 HTTP ' + code);
  var html = response.getContentText().slice(0, 180000);
  var identity = typeof extractPageIdentity_ === 'function' ? extractPageIdentity_(html) : {title:'', strongText:'', fullText:spiCleanText_(html, 35000), identifiers:[], canonical:''};
  return {
    text:spiCleanText_(identity.fullText || html, 35000),
    title:spiCleanText_(identity.title, 500),
    strongText:spiCleanText_(identity.strongText, 3000),
    identifiers:identity.identifiers || [],
    canonical:String(identity.canonical || ''),
    etag:String(response.getHeaders() && response.getHeaders().ETag || ''),
    lastModified:String(response.getHeaders() && response.getHeaders()['Last-Modified'] || ''),
    fetched_at:new Date().toISOString(),
    from_cache:false
  };
}

function spiFetchPdfSourceText_(url) {
  if (typeof Drive === 'undefined' || !Drive.Files || !Drive.Files.create) throw new Error('PDF 规格来源需要启用 Drive Advanced Service');
  var response = UrlFetchApp.fetch(url, {muteHttpExceptions:true, followRedirects:true});
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('PDF 规格来源返回 HTTP ' + code);
  var file = null;
  try {
    file = Drive.Files.create(
      {name:'__TEMP_SPEC_PDF_' + Date.now(), mimeType:'application/vnd.google-apps.document'},
      response.getBlob(),
      {fields:'id,name,mimeType', ocrLanguage:'en'}
    );
    return spiCleanText_(DocumentApp.openById(file.id).getBody().getText(), 35000);
  } finally {
    if (file && file.id) {
      try { Drive.Files.remove(file.id); } catch (e) { Logger.log('临时 PDF 文档清理失败：' + String(e)); }
    }
  }
}

function crawlProductSpecSource(productId, url) {
  var product = spiGetProduct_(productId);
  if (!product) throw new Error('产品记录不存在: ' + String(productId || ''));
  var verification = verifyProductSpecUrl(productId, url);
  if (verification.status !== 'verified') throw new Error('来源未通过产品身份核验: ' + verification.status);
  var isPdf = /\.pdf(?:\?|$)/i.test(String(url));
  var fetched = isPdf
    ? {text:spiFetchPdfSourceText_(url), title:'', strongText:'', identifiers:[], canonical:'', etag:'', lastModified:'', fetched_at:new Date().toISOString(), from_cache:false}
    : spiFetchHtmlSource_(url, spiProductQuery_(product), Date.now() + 60000);
  var text = spiCleanText_(fetched.text, 35000);
  if (!isPdf && text.length < 3000 && typeof crawl4aiCanRender_ === 'function' && crawl4aiCanRender_()) {
    try {
      var rendered = crawl4aiRenderPage_(url, spiProductQuery_(product), Date.now() + 45000);
      text = spiCleanText_(text + '\n' + rendered.fullText, 35000);
      if (!fetched.title && rendered.title) fetched.title = rendered.title;
      if (!fetched.strongText && rendered.strongText) fetched.strongText = rendered.strongText;
    } catch (e) {
      Logger.log('Crawl4AI 渲染补充失败：' + String(e));
    }
  }
  var contentHash = typeof contentHash_ === 'function' ? contentHash_(text) : spiHash_(text);
  var metaKey = 'spec_source_meta:' + url;
  try {
    cachePut_(metaKey, {
      url:url,
      text:text,
      title:fetched.title,
      strongText:fetched.strongText,
      identifiers:fetched.identifiers,
      canonical:fetched.canonical,
      etag:fetched.etag,
      last_modified:fetched.lastModified,
      content_hash:contentHash,
      fetched_at:fetched.fetched_at
    });
  } catch (e) { Logger.log('规格来源缓存写入失败：' + String(e)); }
  return {
    product_id:String(product.product_id),
    product_name:String(product.canonical_name || ''),
    brand:String(product.brand || ''),
    category:String(product.category || ''),
    source_url:String(url),
    source_title:String(fetched.title || ''),
    source_type:verification.source_type,
    source_priority:verification.source_priority,
    fetched_at:fetched.fetched_at,
    content_hash:contentHash,
    text:text,
    identity:{
      strongText:String(fetched.strongText || ''),
      fullText:text,
      identifiers:fetched.identifiers || [],
      canonical:fetched.canonical || ''
    },
    verification:verification
  };
}

function spiSpecExtractionSchema_() {
  return {
    type:'OBJECT',
    properties:{
      product_id:{type:'STRING'},
      product_name:{type:'STRING'},
      source_url:{type:'STRING'},
      specifications:{type:'ARRAY',items:{type:'OBJECT',properties:{
        canonical_field:{type:'STRING'},
        raw_field_name:{type:'STRING'},
        raw_value:{type:'STRING'},
        normalized_value:{type:'STRING'},
        normalized_unit:{type:'STRING'},
        evidence_text:{type:'STRING'},
        confidence:{type:'NUMBER'}
      },required:['canonical_field','raw_field_name','raw_value','evidence_text']}},
      missing_fields:{type:'ARRAY',items:{type:'STRING'}},
      extraction_warnings:{type:'ARRAY',items:{type:'STRING'}}
    },
    required:['product_id','product_name','source_url','specifications','missing_fields','extraction_warnings']
  };
}

function extractProductSpecifications(productId, sourceContent) {
  if (!sourceContent || !sourceContent.source_url || !sourceContent.text) throw new Error('缺少已抓取的规格来源内容');
  var product = spiGetProduct_(productId) || {
    product_id:sourceContent.product_id,
    canonical_name:sourceContent.product_name,
    brand:sourceContent.brand,
    category:sourceContent.category
  };
  var dictionary = spiGetDictionary_(product.category || 'mouse');
  if (!dictionary.length) throw new Error('该品类尚无规格字典: ' + String(product.category || ''));
  var fieldLines = dictionary.map(function(d) {
    return [d.canonical_field, d.display_name, d.canonical_unit, d.data_type, d.aliases].join(' | ');
  }).join('\n');
  var prompt = [
    '你是严格的产品规格抽取器。只能根据给定来源文本抽取，不得搜索、不得使用记忆、不得推断。',
    '【产品】product_id=' + String(product.product_id || '') + '；name=' + String(product.canonical_name || '') + '；brand=' + String(product.brand || '') + '；category=' + String(product.category || ''),
    '【来源】source_url=' + String(sourceContent.source_url || '') + '；source_title=' + String(sourceContent.source_title || ''),
    '【允许字段】canonical_field | display_name | canonical_unit | data_type | aliases',
    fieldLines,
    '【规则】1. 每个 specification 必须有 evidence_text，且必须逐字来自来源文本。2. 没有证据的字段不要输出。3. raw_value 保留来源原文。4. normalized_value 能数字化就给数字字符串，不能则原文。5. normalized_unit 只写来源明确给出的单位；单位不明则空字符串。6. 不要合并不同技术概念。7. 明确缺失列入 missing_fields。8. 歧义写入 extraction_warnings，并不要输出该字段。',
    '【输出】只输出 JSON，不要 Markdown，不要解释。结构必须符合：',
    JSON.stringify({
      product_id:String(product.product_id || ''),
      product_name:String(product.canonical_name || ''),
      source_url:String(sourceContent.source_url || ''),
      specifications:[{canonical_field:'weight_g',raw_field_name:'Weight',raw_value:'Approx. 60 grams',normalized_value:'60',normalized_unit:'g',evidence_text:'exact source text',confidence:0.98}],
      missing_fields:[],
      extraction_warnings:[]
    }),
    '<<<SPEC_TEXT',
    spiCleanText_(sourceContent.text, 30000),
    'SPEC_TEXT'
  ].join('\n');
  var raw = callAI(prompt, spiSpecExtractionSchema_(), {provider:'gemini', maxTokens:8192, timeoutMs:60000});
  var parsed = typeof raw === 'string' ? extractJson_(raw) : raw;
  var warnings = Array.isArray(parsed.extraction_warnings) ? parsed.extraction_warnings.map(String) : [];
  if (parsed.source_url && String(parsed.source_url) !== String(sourceContent.source_url)) {
    warnings.push('模型返回 source_url 与抓取 URL 不一致，已按抓取 URL 覆盖');
  }
  var specs = Array.isArray(parsed.specifications) ? parsed.specifications.map(function(s) {
    return {
      canonical_field:String((s && s.canonical_field) || '').trim(),
      raw_field_name:String((s && s.raw_field_name) || '').trim(),
      raw_value:String((s && s.raw_value) || ''),
      normalized_value:String((s && s.normalized_value) === undefined || s.normalized_value === null ? '' : s.normalized_value),
      normalized_unit:String((s && s.normalized_unit) || '').trim(),
      evidence_text:String((s && s.evidence_text) || ''),
      confidence:Number(s && s.confidence)
    };
  }) : [];
  return {
    product_id:String(product.product_id || ''),
    product_name:String(product.canonical_name || ''),
    source_url:String(sourceContent.source_url || ''),
    source_content:sourceContent,
    specifications:specs,
    missing_fields:Array.isArray(parsed.missing_fields) ? parsed.missing_fields.map(String) : [],
    extraction_warnings:warnings,
    extraction_method:'gemini_flash_evidence_prompt_v1',
    extracted_at:new Date().toISOString()
  };
}

function spiNormalizeAliasFallback_(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[\s\-_·.,;:!?'"()[\]\/\\]/g, '');
}

function spiEvidenceSupported_(evidenceText, sourceText) {
  var norm = typeof normalizeAlias === 'function' ? normalizeAlias : spiNormalizeAliasFallback_;
  var evidence = norm(evidenceText).slice(0, 600);
  var source = norm(sourceText);
  return evidence.length > 0 && source.indexOf(evidence) >= 0;
}

function spiParseNumber_(rawValue) {
  var s = String(rawValue === null || rawValue === undefined ? '' : rawValue).replace(/,/g, '').trim();
  if (!s || /^(n\/a|na|none|null|unknown|-|—)$/i.test(s)) return null;
  var m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function spiDetectUnit_(rawValue, definition) {
  var s = String(rawValue || '').toLowerCase();
  var rule = String(definition.normalization_rule || '');
  if (rule === 'convert_to_grams' || String(definition.canonical_unit || '').toLowerCase() === 'g') {
    if (/\bkg\b|kilogram/.test(s)) return 'kg';
    if (/\bg\b|gram/.test(s) || /克/.test(s)) return 'g';
  }
  if (rule === 'convert_to_mm' || String(definition.canonical_unit || '').toLowerCase() === 'mm') {
    if (/\bmm\b|millimeter/.test(s) || /毫米/.test(s)) return 'mm';
    if (/\bcm\b|centimeter/.test(s) || /厘米/.test(s)) return 'cm';
    if (/\binch(?:es)?\b|\bin\b/.test(s) || /英寸/.test(s)) return 'in';
  }
  if (String(definition.canonical_unit || '').toLowerCase() === 'dpi') {
    if (/\bdpi\b|\bcpi\b/.test(s)) return 'DPI';
  }
  if (String(definition.canonical_unit || '').toLowerCase() === 'ips') {
    if (/\bips\b|inch(?:es)?\s*\/\s*s/.test(s)) return 'IPS';
  }
  if (String(definition.canonical_unit || '').toLowerCase() === 'hz') {
    if (/\bkhz\b/.test(s)) return 'kHz';
    if (/\bhz\b/.test(s)) return 'Hz';
  }
  if (String(definition.canonical_unit || '').toLowerCase() === 'hours') {
    if (/\bhours?\b|\bhrs?\b|小时/.test(s)) return 'hours';
    if (/\bh\b/.test(s)) return 'h';
  }
  if (String(definition.canonical_unit || '').toLowerCase() === 'g' && /加速度/.test(String(definition.canonical_field || ''))) return 'G';
  return '';
}

function spiConvertUnit_(value, unit, canonicalUnit) {
  var u = String(unit || '').toLowerCase().trim();
  var c = String(canonicalUnit || '').toLowerCase().trim();
  if (!u) u = c;
  if ((!c && !u) || u === c) return {ok:true, value:value, unit:String(canonicalUnit || u)};
  if (c === 'g') {
    if (['g','gram','grams','克'].indexOf(u) >= 0) return {ok:true, value:value, unit:'g'};
    if (['kg','kilogram','kilograms','千克'].indexOf(u) >= 0) return {ok:true, value:value * 1000, unit:'g'};
  }
  if (c === 'mm') {
    if (['mm','millimeter','millimeters','毫米'].indexOf(u) >= 0) return {ok:true, value:value, unit:'mm'};
    if (['cm','centimeter','centimeters','厘米'].indexOf(u) >= 0) return {ok:true, value:value * 10, unit:'mm'};
    if (['in','inch','inches','英寸'].indexOf(u) >= 0) return {ok:true, value:value * 25.4, unit:'mm'};
  }
  if (c === 'dpi' && ['dpi','cpi'].indexOf(u) >= 0) return {ok:true, value:value, unit:'DPI'};
  if (c === 'ips' && ['ips','in/s','inch/s','inches/s'].indexOf(u) >= 0) return {ok:true, value:value, unit:'IPS'};
  if (c === 'g' && u === 'g' && /acceleration/i.test(String(canonicalUnit || ''))) return {ok:true, value:value, unit:'G'};
  if (c === 'hz') {
    if (u === 'hz') return {ok:true, value:value, unit:'Hz'};
    if (u === 'khz') return {ok:true, value:value * 1000, unit:'Hz'};
  }
  if (c === 'hours' && ['h','hr','hrs','hour','hours','小时'].indexOf(u) >= 0) return {ok:true, value:value, unit:'hours'};
  return {ok:false, reason:'unit_mismatch:' + u + '->' + c};
}

function spiNormalizeSpec_(spec, definition) {
  var raw = spec.raw_value !== undefined && spec.raw_value !== null && String(spec.raw_value) !== ''
    ? spec.raw_value
    : spec.normalized_value;
  var rawText = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!rawText) return {ok:false, reason:'empty_value'};
  if (String(definition.data_type || '').toLowerCase() === 'string') {
    return {ok:true, value:rawText, unit:'', raw_value:rawText};
  }
  var number = spiParseNumber_(rawText);
  if (number === null) return {ok:false, reason:'non_numeric'};
  var unit = String(spec.normalized_unit || spiDetectUnit_(rawText, definition) || definition.canonical_unit || '').trim();
  var converted = spiConvertUnit_(number, unit, String(definition.canonical_unit || ''));
  if (!converted.ok) return {ok:false, reason:converted.reason};
  return {ok:true, value:converted.value, unit:converted.unit, raw_value:rawText};
}

function spiRangeWarning_(canonicalField, value) {
  var ranges = {
    weight_g:[20,300],
    max_dpi:[100,50000],
    max_tracking_speed_ips:[50,2000],
    max_acceleration_g:[1,200],
    polling_rate_hz:[125,16000],
    battery_life_hours:[1,500],
    dimensions_length_mm:[40,250],
    dimensions_width_mm:[20,150],
    dimensions_height_mm:[10,100]
  };
  var r = ranges[canonicalField];
  if (!r || typeof value !== 'number' || !isFinite(value)) return '';
  return value < r[0] || value > r[1] ? 'suspicious_range:' + canonicalField + '=' + value : '';
}

function spiIdentityCheck_(product, sourceContent, officialNames) {
  if (!sourceContent || !sourceContent.verification || sourceContent.verification.status !== 'verified') {
    return {ok:false, reason:'source_not_verified'};
  }
  if (String(sourceContent.product_id || '') && String(sourceContent.product_id) !== String(product.product_id || '')) {
    return {ok:false, reason:'source_product_id_mismatch'};
  }
  if (typeof productPageMatchesMulti_ === 'function') {
    var page = sourceContent.identity || {strongText:'', fullText:sourceContent.text || '', identifiers:[]};
    if (!productPageMatchesMulti_(product, page, officialNames || [])) return {ok:false, reason:'page_identity_mismatch'};
  }
  return {ok:true, reason:''};
}

function validateProductSpecifications(productId, extractedData) {
  var product = spiGetProduct_(productId) || spiGetProduct_(extractedData && extractedData.product_id);
  if (!product) throw new Error('产品记录不存在，无法验证规格');
  var sourceContent = (extractedData && extractedData.source_content) || {};
  var dictionary = spiGetDictionary_(product.category || 'mouse');
  var officialNames = spiOfficialNames_(spiIdentityForProduct_(product, Date.now() + 30000), product);
  var identity = spiIdentityCheck_(product, sourceContent, officialNames);
  var warnings = (extractedData && extractedData.extraction_warnings ? extractedData.extraction_warnings.map(String) : []).slice();
  if (!identity.ok) warnings.push('identity_rejected:' + identity.reason);

  var accepted = [];
  var rejected = [];
  var observations = [];
  var specs = extractedData && Array.isArray(extractedData.specifications) ? extractedData.specifications : [];
  var fetchedAt = sourceContent.fetched_at || (extractedData && extractedData.extracted_at) || new Date().toISOString();
  var contentHash = sourceContent.content_hash || '';

  specs.forEach(function(spec) {
    var field = String((spec && spec.canonical_field) || '').trim();
    var definition = dictionary.filter(function(d) { return String(d.canonical_field) === field; })[0];
    var evidence = String((spec && spec.evidence_text) || '');
    var sourceUrl = String((spec && spec.source_url) || sourceContent.source_url || '');
    var reason = '';
    var normalized = null;
    if (!identity.ok) reason = identity.reason;
    else if (!definition) reason = 'unknown_field';
    else if (!evidence.trim()) reason = 'missing_evidence';
    else if (!spiEvidenceSupported_(evidence, sourceContent.text || '')) reason = 'evidence_not_in_source';
    else if (sourceUrl && sourceContent.source_url && sourceUrl !== sourceContent.source_url) reason = 'source_url_mismatch';
    else {
      normalized = spiNormalizeSpec_(spec, definition);
      if (!normalized.ok) reason = normalized.reason;
      else if (!(Number(spec.confidence) >= 0.5)) reason = 'low_confidence';
    }
    var extractedValue = {
      normalized_value:normalized && normalized.ok ? normalized.value : '',
      normalized_unit:normalized && normalized.ok ? normalized.unit : String((spec && spec.normalized_unit) || ''),
      confidence:Number(spec && spec.confidence) || 0
    };
    var observation = {
      raw_id:spiRawId_(product.product_id, field, sourceUrl, String((spec && spec.raw_value) || ''), evidence, contentHash),
      product_id:String(product.product_id),
      canonical_field:field,
      raw_field_name:String((spec && spec.raw_field_name) || ''),
      raw_value:String((spec && spec.raw_value) || ''),
      extracted_value:JSON.stringify(extractedValue),
      source_url:sourceUrl,
      source_title:String(sourceContent.source_title || ''),
      source_type:String(sourceContent.source_type || spiClassifySpecSource_(sourceUrl)),
      evidence_text:evidence,
      extraction_method:String((extractedData && extractedData.extraction_method) || 'gemini_flash_evidence_prompt_v1'),
      model_version:String(specPocSetting_('SPEC_PIV1_MODEL_VERSION', 'v1')),
      fetched_at:fetchedAt,
      verification_status:reason ? 'rejected' : 'accepted',
      rejection_reason:reason,
      content_hash:contentHash,
      source_priority:spiSourcePriority_(String(sourceContent.source_type || spiClassifySpecSource_(sourceUrl)))
    };
    observations.push(observation);
    if (reason) {
      rejected.push({canonical_field:field, reason:reason, raw_value:observation.raw_value});
      return;
    }
    var rangeWarning = spiRangeWarning_(field, normalized.value);
    if (rangeWarning) warnings.push(rangeWarning);
    accepted.push({
      product_id:String(product.product_id),
      canonical_field:field,
      normalized_value:normalized.value,
      normalized_unit:normalized.unit,
      selected_source_url:sourceUrl,
      source_type:observation.source_type,
      source_priority:observation.source_priority,
      evidence_text:evidence,
      verification_status:'verified_by_evidence',
      confidence:Number(spec.confidence) || 0.5,
      last_verified_at:fetchedAt,
      raw_id:observation.raw_id,
      fetched_at:fetchedAt,
      warnings:rangeWarning ? [rangeWarning] : []
    });
  });

  var currentRawIds = {};
  observations.forEach(function(o) { currentRawIds[String(o.raw_id)] = 1; });
  var priorAccepted = [];
  try {
    readTable(SPEC_PIV1_SHEETS.raw).forEach(function(row) {
      if (String(row.product_id || '') !== String(product.product_id || '')) return;
      if (String(row.verification_status || '') !== 'accepted') return;
      if (currentRawIds[String(row.raw_id || '')]) return;
      var parsed = {};
      try { parsed = JSON.parse(String(row.extracted_value || '{}')); } catch (e) { parsed = {}; }
      if (parsed.normalized_value === undefined || parsed.normalized_value === '') return;
      var priorType = String(row.source_type || spiClassifySpecSource_(row.source_url));
      priorAccepted.push({
        product_id:String(product.product_id),
        canonical_field:String(row.canonical_field || ''),
        normalized_value:parsed.normalized_value,
        normalized_unit:String(parsed.normalized_unit || ''),
        selected_source_url:String(row.source_url || ''),
        source_type:priorType,
        source_priority:spiSourcePriority_(priorType),
        evidence_text:String(row.evidence_text || ''),
        verification_status:'verified_by_evidence',
        confidence:Number(parsed.confidence) || 0.5,
        last_verified_at:String(row.fetched_at || ''),
        raw_id:String(row.raw_id || ''),
        fetched_at:String(row.fetched_at || ''),
        warnings:[]
      });
    });
  } catch (e) { Logger.log('读取既有规格观察失败：' + String(e)); }

  var conflicts = [];
  var selectedWinners = [];
  var byField = {};
  accepted.concat(priorAccepted).forEach(function(item) {
    var key = item.canonical_field;
    if (!byField[key]) byField[key] = [];
    byField[key].push(item);
  });
  Object.keys(byField).forEach(function(field) {
    var items = byField[field];
    items.sort(function(a, b) {
      return b.source_priority - a.source_priority || String(b.fetched_at).localeCompare(String(a.fetched_at));
    });
    selectedWinners.push(items[0]);
    if (items.length < 2) return;
    var values = {};
    items.forEach(function(i) { values[String(i.normalized_value) + '|' + String(i.normalized_unit)] = 1; });
    if (Object.keys(values).length < 2) return;
    var unresolved = items[0].source_priority === items[1].source_priority;
    if (unresolved) selectedWinners = selectedWinners.filter(function(i) { return i.canonical_field !== field; });
    conflicts.push({
      canonical_field:field,
      unresolved:unresolved,
      selected_source_url:unresolved ? '' : items[0].selected_source_url,
      resolved_by:unresolved ? '' : (items[0].source_priority > items[1].source_priority ? 'source_priority' : 'newer_verified_source'),
      observations:items.map(function(i) {
        return {raw_id:i.raw_id, normalized_value:i.normalized_value, normalized_unit:i.normalized_unit, source_url:i.selected_source_url, source_type:i.source_type, source_priority:i.source_priority, fetched_at:i.fetched_at};
      })
    });
  });

  var acceptedFields = {};
  selectedWinners.forEach(function(i) { acceptedFields[i.canonical_field] = 1; });
  var missingFields = dictionary.filter(function(d) { return !acceptedFields[String(d.canonical_field)]; }).map(function(d) { return String(d.canonical_field); });
  if (extractedData && Array.isArray(extractedData.missing_fields)) {
    extractedData.missing_fields.forEach(function(f) {
      if (missingFields.indexOf(String(f)) >= 0 || dictionary.some(function(d) { return String(d.canonical_field) === String(f); })) {
        if (missingFields.indexOf(String(f)) < 0) missingFields.push(String(f));
      }
    });
  }

  return {
    product_id:String(product.product_id),
    status:identity.ok ? 'validated' : 'identity_rejected',
    accepted:accepted,
    selected_winners:selectedWinners,
    rejected:rejected,
    conflicts:conflicts,
    warnings:warnings,
    missing_fields:missingFields,
    raw_observations:observations,
    source_content:sourceContent,
    validated_at:new Date().toISOString()
  };
}

function spiAppendRows_(sheetName, rows) {
  if (!rows.length) return 0;
  var sh = sheet_(sheetName);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(h) { return String(h == null ? '' : h).trim(); });
  var start = Math.max(2, sh.getLastRow() + 1);
  var values = rows.map(function(r) { return headers.map(function(h) { return r[h] !== undefined && r[h] !== null ? r[h] : ''; }); });
  sh.getRange(start, 1, values.length, headers.length).setValues(values);
  return values.length;
}

function writeRawSpecifications(data) {
  spiEnsureSheets_();
  var observations = data && Array.isArray(data.raw_observations) ? data.raw_observations : (Array.isArray(data) ? data : []);
  if (!observations.length) return {written:0, skipped:0};
  var existing = readTable(SPEC_PIV1_SHEETS.raw);
  var ids = {};
  existing.forEach(function(r) { ids[String(r.raw_id || '')] = 1; });
  var rows = [];
  observations.forEach(function(o) {
    var id = String(o.raw_id || spiRawId_(o.product_id, o.canonical_field, o.source_url, o.raw_value, o.evidence_text, o.content_hash));
    if (ids[id]) return;
    ids[id] = 1;
    rows.push({
      raw_id:id,
      product_id:o.product_id,
      canonical_field:o.canonical_field,
      raw_field_name:o.raw_field_name,
      raw_value:o.raw_value,
      extracted_value:o.extracted_value,
      source_url:o.source_url,
      source_title:o.source_title,
      source_type:o.source_type,
      evidence_text:o.evidence_text,
      extraction_method:o.extraction_method,
      model_version:o.model_version,
      fetched_at:o.fetched_at,
      verification_status:o.verification_status,
      rejection_reason:o.rejection_reason,
      content_hash:o.content_hash
    });
  });
  return {written:spiAppendRows_(SPEC_PIV1_SHEETS.raw, rows), skipped:observations.length - rows.length};
}

function spiShouldReplaceCanonical_(existing, incoming) {
  if (!existing) return true;
  if (String(existing.verification_status || '') === 'rejected') return true;
  var oldPriority = spiSourcePriority_(String(existing.source_type || spiClassifySpecSource_(existing.selected_source_url)));
  var newPriority = Number(incoming.source_priority) || 0;
  if (newPriority > oldPriority) return true;
  if (newPriority < oldPriority) return false;
  var oldTime = Date.parse(String(existing.last_verified_at || '')) || 0;
  var newTime = Date.parse(String(incoming.last_verified_at || '')) || 0;
  return newTime >= oldTime;
}

function updateCanonicalSpecifications(data) {
  spiEnsureSheets_();
  var winners = data && Array.isArray(data.selected_winners) ? data.selected_winners : (data && Array.isArray(data.accepted) ? data.accepted : []);
  var accepted = winners.slice();
  var conflicts = data && Array.isArray(data.conflicts) ? data.conflicts : [];
  var unresolved = {};
  conflicts.forEach(function(c) { if (c.unresolved) unresolved[String(c.canonical_field)] = 1; });
  accepted = accepted.filter(function(a) { return !unresolved[String(a.canonical_field)]; });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var keep = readTable(SPEC_PIV1_SHEETS.canonical);
    var index = {};
    keep.forEach(function(r, i) { index[spiCanonicalKey_(r.product_id, r.canonical_field)] = i; });
    var written = 0;
    var skipped = 0;
    accepted.forEach(function(item) {
      var key = spiCanonicalKey_(item.product_id, item.canonical_field);
      var existing = index[key] === undefined ? null : keep[index[key]];
      if (!spiShouldReplaceCanonical_(existing, item)) {
        skipped++;
        return;
      }
      var row = {
        product_id:item.product_id,
        canonical_field:item.canonical_field,
        normalized_value:item.normalized_value,
        normalized_unit:item.normalized_unit,
        selected_source_url:item.selected_source_url,
        source_type:item.source_type,
        evidence_text:item.evidence_text,
        verification_status:item.verification_status,
        confidence:item.confidence,
        last_verified_at:item.last_verified_at,
        raw_id:item.raw_id,
        fetched_at:item.fetched_at,
        warnings:(item.warnings || []).join('; ')
      };
      if (existing) keep[index[key]] = row;
      else {
        index[key] = keep.length;
        keep.push(row);
      }
      written++;
    });
    rewriteTable_(SPEC_PIV1_SHEETS.canonical, keep);
    clearCache();
    return {written:written, skipped:skipped, unresolved:Object.keys(unresolved)};
  } finally {
    lock.releaseLock();
  }
}

function getCanonicalSpecificationEvidence_(productId, canonicalField) {
  spiEnsureSheets_();
  var key = spiCanonicalKey_(productId, canonicalField);
  return readTable(SPEC_PIV1_SHEETS.canonical).filter(function(r) {
    return spiCanonicalKey_(r.product_id, r.canonical_field) === key;
  })[0] || null;
}

function spiEmptyCoverage_(dictionary) {
  return {
    total_fields:dictionary.length,
    fields_extracted:0,
    fields_verified:0,
    fields_missing:dictionary.map(function(d) { return String(d.canonical_field); }),
    fields_conflicting:0,
    sources:{discovered:0, verified:0, crawled:0, urls:[]}
  };
}

function spiBuildCoverageReport_(dictionary, discovery, verification, crawled, extracted, validated) {
  var extractedFields = {};
  (extracted.specifications || []).forEach(function(s) { extractedFields[String(s.canonical_field)] = 1; });
  var verifiedFields = {};
  var winners = Array.isArray(validated.selected_winners) ? validated.selected_winners : (validated.accepted || []);
  winners.forEach(function(s) { verifiedFields[String(s.canonical_field)] = 1; });
  return {
    total_fields:dictionary.length,
    fields_extracted:Object.keys(extractedFields).length,
    fields_verified:Object.keys(verifiedFields).length,
    fields_missing:(validated.missing_fields || []).slice(),
    fields_conflicting:(validated.conflicts || []).length,
    sources:{
      discovered:(discovery && discovery.candidates ? discovery.candidates.length : 0),
      verified:verification && verification.status === 'verified' ? 1 : 0,
      crawled:crawled ? 1 : 0,
      urls:crawled ? [String(crawled.source_url)] : []
    }
  };
}

function syncProductSpecifications(productId) {
  var report = {status:'started', product_id:String(productId || ''), started_at:new Date().toISOString()};
  try {
    spiEnsureSheets_();
    var product = spiGetProduct_(productId);
    if (!product) {
      report.status = 'product_not_found';
      return report;
    }
    if (!spiProductReadyForSpecs_(product)) {
      report.status = 'product_not_confirmed';
      report.identity_status = String(product.identity_status || '');
      report.resolution_status = String(product.resolution_status || '');
      report.official_url_status = String(product.official_url_status || '');
      report.reject_reason = '产品身份或官网 URL 未确认，禁止进入规格抓取';
      return report;
    }
    var dictionary = spiGetDictionary_(product.category || 'mouse');
    report.coverage = spiEmptyCoverage_(dictionary);
    if (!dictionary.length) {
      report.status = 'unsupported_category';
      report.category = String(product.category || '');
      return report;
    }
    var discovery = discoverProductSpecUrls(productId);
    report.discovery = {status:discovery.status, candidates:discovery.candidates.length};
    var verification = null;
    if (String(product.official_url || '') && isProductUrlVerified_(product)) {
      verification = verifyProductSpecUrl(productId, product.official_url);
    }
    if (!verification || verification.status !== 'verified') {
      var candidates = discovery.candidates.slice(0, 5);
      for (var i = 0; i < candidates.length; i++) {
        var candidateVerification = verifyProductSpecUrl(productId, candidates[i].url);
        if (candidateVerification.status === 'verified') {
          verification = candidateVerification;
          break;
        }
      }
    }
    if (!verification || verification.status !== 'verified') {
      report.status = 'source_unverified';
      report.verification = verification;
      return report;
    }
    report.verification = verification;
    var crawled = crawlProductSpecSource(productId, verification.url);
    report.crawl = {source_url:crawled.source_url, source_type:crawled.source_type, content_hash:crawled.content_hash, chars:crawled.text.length};
    var extracted = extractProductSpecifications(productId, crawled);
    var validated = validateProductSpecifications(productId, extracted);
    var rawWrite = writeRawSpecifications(validated);
    var canonicalWrite = updateCanonicalSpecifications(validated);
    report.status = validated.status === 'identity_rejected' ? 'identity_rejected' : 'done';
    report.raw_write = rawWrite;
    report.canonical_write = canonicalWrite;
    report.coverage = spiBuildCoverageReport_(dictionary, discovery, verification, crawled, extracted, validated);
    report.rejected = validated.rejected;
    report.conflicts = validated.conflicts;
    report.warnings = validated.warnings;
    report.finished_at = new Date().toISOString();
    return report;
  } catch (e) {
    report.status = 'error';
    report.error = String(e && e.message ? e.message : e).slice(0, 500);
    report.finished_at = new Date().toISOString();
    return report;
  }
}

function setupPocSheets() {
  var message = setupSheets();
  Logger.log(message);
  return message;
}

function runPocSyncGpw5Ultra() {
  var report = syncProductSpecifications('P001');
  Logger.log(JSON.stringify(report));
  return report;
}

function runPocSyncViperV3Pro() {
  var report = syncProductSpecifications('P002');
  Logger.log(JSON.stringify(report));
  return report;
}

function runPocSyncOp18k() {
  var report = syncProductSpecifications('P003');
  Logger.log(JSON.stringify(report));
  return report;
}

function runPocSyncAllProducts() {
  var reports = ['P001', 'P002', 'P003'].map(function(productId) {
    return syncProductSpecifications(productId);
  });
  Logger.log(JSON.stringify(reports));
  return reports;
}
