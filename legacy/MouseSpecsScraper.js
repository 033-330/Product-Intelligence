/**
 * MouseSpecsScraper.gs
 * Product Intelligence - configurable official mouse-specification scraper.
 *
 * Required sheets:
 *   Products: product_id, canonical_name, brand, category, official_url
 *   Brand_Extraction_Rules: managed by BrandExtractionRules.gs
 *   Mouse_Specs: the 26 canonical headers listed in MOUSE_SPECS_HEADERS
 *
 * Public entry points:
 *   setupMouseSpecsScraper()
 *   refreshLegacyMouseSpecs_(ids)  // API-compatible; ids optional/comma-separated
 *   testMouseSpecsScraper(productId)
 *   previewMouseSpecsForProduct(productId)
 *   testAllMouseSpecRuleMatches()
 *
 * Notes:
 * - UrlFetchApp cannot execute client-side JavaScript. Some sites may need a custom parser.
 * - Parsing a page is not the same as verifying every value. New data is marked PENDING_REVIEW.
 * - Add future brand parsers in msParseBrandSpecific_() and add a rule row in Brand_Extraction_Rules.
 */

const MOUSE_SPECS_SCRAPER_CONFIG = {
  productsSheet: 'Products',
  rulesSheet: 'Brand_Extraction_Rules',
  specsSheet: 'Mouse_Specs',
  logSheet: 'Mouse_Specs_Log',
  defaultCategory: 'mouse',
  timeoutNote: 'Apps Script UrlFetchApp has execution/time limits; run batches if needed.',
  userAgent: 'Mozilla/5.0 (compatible; ProductIntelligenceBot/1.0)',
  maxHtmlCharsForParsing: 2000000
};

const MOUSE_SPECS_HEADERS = [
  'product_id', 'sensor_name', 'dpi_min', 'dpi_max', 'max_speed_ips',
  'max_acceleration_g', 'max_polling_rate_hz', 'connection_type',
  'wireless_technology', 'wired_connection', 'bluetooth_support',
  'button_count', 'switch_type', 'switch_lifecycle', 'switch_lifecycle_unit',
  'weight_g', 'length_mm', 'width_mm', 'height_mm', 'battery_life_hours',
  'battery_life_conditions', 'onboard_memory', 'software_requirement',
  'source_url', 'last_fetched_at', 'verification_status'
];

const MOUSE_SPECS_LABELS = {
  sensor_name: 'Sensor',
  dpi_min: 'Minimum DPI',
  dpi_max: 'Maximum DPI',
  max_speed_ips: 'Maximum speed',
  max_acceleration_g: 'Maximum acceleration',
  max_polling_rate_hz: 'Maximum polling rate',
  connection_type: 'Connection',
  wireless_technology: 'Wireless technology',
  wired_connection: 'Wired connection',
  bluetooth_support: 'Bluetooth',
  button_count: 'Number of buttons',
  switch_type: 'Switch type',
  switch_lifecycle: 'Switch lifecycle',
  switch_lifecycle_unit: 'Switch lifecycle unit',
  weight_g: 'Weight',
  length_mm: 'Length',
  width_mm: 'Width',
  height_mm: 'Height',
  battery_life_hours: 'Battery life',
  battery_life_conditions: 'Battery life conditions',
  onboard_memory: 'Onboard memory',
  software_requirement: 'Software'
};

/**
 * Adds any missing Mouse_Specs columns without deleting existing data.
 * Also creates the scrape log sheet.
 */
function setupMouseSpecsScraper() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet. Run this from the spreadsheet-bound Apps Script project.');

  var specs = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.specsSheet);
  if (!specs) specs = ss.insertSheet(MOUSE_SPECS_SCRAPER_CONFIG.specsSheet);
  msEnsureHeaders_(specs, MOUSE_SPECS_HEADERS);

  var log = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.logSheet);
  if (!log) log = ss.insertSheet(MOUSE_SPECS_SCRAPER_CONFIG.logSheet);
  msEnsureHeaders_(log, [
    'logged_at', 'product_id', 'product_name', 'brand', 'official_url',
    'rule_id', 'status', 'fields_found', 'message'
  ]);

  return {
    success: true,
    specs_sheet: specs.getName(),
    specs_headers: MOUSE_SPECS_HEADERS.length,
    log_sheet: log.getName()
  };
}

/**
 * API-compatible main function.
 * ids may be omitted (all mouse products), a comma-separated string, or an array.
 * Example: refreshLegacyMouseSpecs_('PROD-0060,PROD-0026')
 */
function refreshLegacyMouseSpecs_(ids, options) {
  options = options || {};
  var requestedIds = msNormalizeIds_(ids);
  var previewOnly = options.previewOnly === true;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet.');

  var productsSheet = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.productsSheet);
  if (!productsSheet) throw new Error('Missing sheet: ' + MOUSE_SPECS_SCRAPER_CONFIG.productsSheet);

  var specsSheet = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.specsSheet);
  if (!specsSheet && !previewOnly) {
    setupMouseSpecsScraper();
    specsSheet = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.specsSheet);
  }
  if (specsSheet) msEnsureHeaders_(specsSheet, MOUSE_SPECS_HEADERS);

  var products = msReadProducts_(productsSheet);
  var selected = products.filter(function(p) {
    if (requestedIds.length && requestedIds.indexOf(String(p.product_id)) < 0) return false;
    var category = msNormalizeText_(p.category);
    return !category || /mouse|mice|榧犳爣/i.test(category);
  });

  if (!selected.length) {
    return {
      success: true, total: 0, updated: 0, failed: 0,
      message: requestedIds.length
        ? 'No matching mouse products found for IDs: ' + requestedIds.join(', ')
        : 'No mouse products with usable product rows were found.'
    };
  }

  var results = [];
  selected.forEach(function(product) {
    try {
      var result = msScrapeOneProduct_(product, { previewOnly: previewOnly });
      results.push(result);
      if (!previewOnly && specsSheet && result.specs &&
          ['PARSED', 'PARTIAL', 'PAGE_FETCHED_NO_SPECS'].indexOf(result.status) >= 0) {
        msSaveMouseSpecs_(specsSheet, product.product_id, result.specs, product.official_url, result.status);
      }
      msWriteScrapeLog_(result);
    } catch (err) {
      var failed = {
        product_id: product.product_id,
        product_name: product.canonical_name,
        brand: product.brand,
        official_url: product.official_url,
        rule_id: '',
        status: 'ERROR',
        fields_found: [],
        message: String(err && err.message ? err.message : err),
        specs: {}
      };
      results.push(failed);
      msWriteScrapeLog_(failed);
    }
  });

  var updated = results.filter(function(r) {
    return r.status === 'PARSED' || r.status === 'PARTIAL';
  }).length;
  var failedCount = results.length - updated;

  return {
    success: failedCount === 0,
    preview_only: previewOnly,
    total: results.length,
    updated: previewOnly ? 0 : updated,
    failed: failedCount,
    results: results
  };
}

/** Test a single product without writing to Mouse_Specs. */
function testMouseSpecsScraper(productId) {
  if (!productId) throw new Error('Provide a product_id, e.g. PROD-0060.');
  return refreshLegacyMouseSpecs_(String(productId), { previewOnly: true });
}

/** Alias with a name that makes the no-write behavior explicit. */
function previewMouseSpecsForProduct(productId) {
  return testMouseSpecsScraper(productId);
}

/** Tests rule matching for every mouse product that has an official URL. */
function testAllMouseSpecRuleMatches() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.productsSheet);
  if (!sheet) throw new Error('Missing Products sheet.');
  var products = msReadProducts_(sheet);
  var results = products.filter(function(p) {
    return p.official_url && (!p.category || /mouse|mice|榧犳爣/i.test(p.category));
  }).map(function(p) {
    var rule = msGetRuleForProduct_(p, true);
    return {
      product_id: p.product_id,
      product_name: p.canonical_name,
      brand: p.brand,
      url: p.official_url,
      matched: !!rule,
      rule_id: rule ? rule.rule_id || '' : '',
      parser_function: rule ? rule.parser_function || '' : '',
      rule_status: rule ? rule.rule_status || '' : ''
    };
  });
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

/** Scrape one product: rule match -> fetch -> brand parser -> normalize -> result. */
function msScrapeOneProduct_(product, options) {
  options = options || {};
  var rule = msGetRuleForProduct_(product, true);
  if (!product.official_url) {
    return msResult_(product, rule, 'NO_OFFICIAL_URL', {}, [], 'Products.official_url is empty.');
  }
  if (!rule) {
    return msResult_(product, null, 'NO_MATCHING_RULE', {}, [],
      'No Brand_Extraction_Rules row matched this brand/category/official URL.');
  }
  var statusText = String(rule.rule_status || '').toUpperCase();
  if (statusText && ['ACTIVE', 'TESTING', 'ENABLED'].indexOf(statusText) < 0) {
    return msResult_(product, rule, 'RULE_INACTIVE', {}, [],
      'Matched rule is not enabled. Current rule_status=' + rule.rule_status);
  }

  var fetched;
  try {
    fetched = msFetchOfficialPage_(product.official_url);
  } catch (err) {
    return msResult_(product, rule, 'FETCH_FAILED', {}, [],
      String(err && err.message ? err.message : err));
  }
  if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
    return msResult_(product, rule, 'FETCH_FAILED', {}, [],
      'HTTP ' + fetched.statusCode + '; HTML length=' + fetched.html.length);
  }

  var parsed = msParseBrandSpecific_(product, rule, fetched.html);
  var normalized = msNormalizeMouseSpecs_(parsed, product, rule);
  var found = Object.keys(normalized).filter(function(k) {
    return normalized[k] !== '' && normalized[k] !== null && normalized[k] !== undefined;
  });

  var resultStatus = found.length >= 5 ? 'PARSED' : (found.length ? 'PARTIAL' : 'PAGE_FETCHED_NO_SPECS');
  var result = msResult_(product, rule, resultStatus, normalized, found,
    found.length
      ? 'HTTP ' + fetched.statusCode + '; HTML length=' + fetched.html.length
      : 'Page fetched but no recognized specification fields were extracted. HTTP ' +
        fetched.statusCode + '; HTML length=' + fetched.html.length);
  result.http_status = fetched.statusCode;
  result.html_length = fetched.html.length;
  result.parser_used = parsed.__parser_used || 'unknown';
  result.preview_only = options.previewOnly === true;
  return result;
}

function msResult_(product, rule, status, specs, fields, message) {
  return {
    product_id: product.product_id || '',
    product_name: product.canonical_name || '',
    brand: product.brand || '',
    official_url: product.official_url || '',
    rule_id: rule ? rule.rule_id || '' : '',
    status: status,
    fields_found: fields || [],
    message: message || '',
    specs: specs || {},
    fetched_at: new Date()
  };
}

/** Reads the Products table by header names, not fixed column positions. */
function msReadProducts_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(msHeaderKey_);
  var idx = {
    product_id: msHeaderIndex_(headers, ['product_id', 'product id', 'id']),
    canonical_name: msHeaderIndex_(headers, ['canonical_name', 'product_name', 'name', 'canonical name']),
    brand: msHeaderIndex_(headers, ['brand', 'brand_name', 'manufacturer']),
    category: msHeaderIndex_(headers, ['category', 'product_category', 'product category']),
    official_url: msHeaderIndex_(headers, ['official_url', 'product_url', 'url', 'official url'])
  };
  if (idx.product_id < 0) throw new Error('Products sheet needs a product_id column.');
  if (idx.brand < 0) throw new Error('Products sheet needs a brand column.');
  return values.slice(1).map(function(row) {
    return {
      product_id: msCell_(row, idx.product_id),
      canonical_name: msCell_(row, idx.canonical_name),
      brand: msCell_(row, idx.brand),
      category: msCell_(row, idx.category),
      official_url: msCell_(row, idx.official_url)
    };
  }).filter(function(p) { return p.product_id !== ''; });
}

function msGetRuleForProduct_(product, includeInactive) {
  if (typeof getBrandExtractionRuleForProduct === 'function') {
    try {
      return getBrandExtractionRuleForProduct(
        product.brand,
        product.category || MOUSE_SPECS_SCRAPER_CONFIG.defaultCategory,
        product.official_url,
        { includeInactive: includeInactive === true }
      );
    } catch (err) {
      // Fall through to a small, self-contained rule-table matcher.
    }
  }
  return msFallbackRuleMatch_(product, includeInactive);
}

/** Fallback matcher, so this scraper can still work if the helper file is absent. */
function msFallbackRuleMatch_(product, includeInactive) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.rulesSheet);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(msHeaderKey_);
  var col = {};
  [
    'rule_id', 'brand_id', 'brand_name', 'entity_type', 'product_category',
    'official_domain', 'product_url_pattern', 'parser_function', 'rule_status',
    'extraction_method', 'data_selector', 'field_mapping_json',
    'normalization_rules_json', 'fetch_method'
  ].forEach(function(k) { col[k] = msHeaderIndex_(headers, [k]); });

  var candidates = values.slice(1).map(function(row) {
    var obj = {};
    Object.keys(col).forEach(function(k) { obj[k] = col[k] >= 0 ? row[col[k]] : ''; });
    return obj;
  }).filter(function(r) {
    if (!includeInactive && r.rule_status && String(r.rule_status).toUpperCase() !== 'ACTIVE') return false;
    var brandMatches = String(r.brand_name || r.brand_id || '').toLowerCase()
      .indexOf(String(product.brand || '').toLowerCase()) >= 0 ||
      String(product.brand || '').toLowerCase()
        .indexOf(String(r.brand_name || r.brand_id || '').toLowerCase()) >= 0;
    if (!brandMatches) return false;
    if (r.product_category && !/mouse|mice|榧犳爣/i.test(String(r.product_category))) return false;
    if (r.official_domain && !msIsDomainMatch_(product.official_url, String(r.official_domain))) return false;
    if (r.product_url_pattern && !msUrlPatternMatch_(product.official_url, String(r.product_url_pattern))) return false;
    return true;
  });
  return candidates.length ? candidates[0] : null;
}

/** Gets official page HTML. Redirects are followed by default. */
function msFetchOfficialPage_(url) {
  if (!/^https:\/\/[a-z0-9.-]+\//i.test(String(url || ''))) {
    throw new Error('Only an https official_url is allowed: ' + url);
  }
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': MOUSE_SPECS_SCRAPER_CONFIG.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  var html = response.getContentText();
  if (html.length > MOUSE_SPECS_SCRAPER_CONFIG.maxHtmlCharsForParsing) {
    html = html.slice(0, MOUSE_SPECS_SCRAPER_CONFIG.maxHtmlCharsForParsing);
  }
  return { statusCode: response.getResponseCode(), html: html };
}

/**
 * Dispatches brand parsers. Future brand slots are deliberately explicit.
 * To add a brand: implement msParseBrandXSpecs_(), then add its branch here
 * or route it using the rule's parser_function.
 */
function msParseBrandSpecific_(product, rule, html) {
  var brand = String(product.brand || '').toLowerCase();
  var ruleId = String(rule.rule_id || '').toLowerCase();
  var parserName = String(rule.parser_function || '').toLowerCase();

  if (brand.indexOf('logitech') >= 0 || ruleId.indexOf('logitech') >= 0 ||
      parserName.indexOf('parselogitech') >= 0) {
    var logitech = msParseLogitechSpecs_(html);
    if (Object.keys(logitech).length) {
      logitech.__parser_used = 'Logitech embedded data';
      return logitech;
    }
  }
  if (brand.indexOf('razer') >= 0 || ruleId.indexOf('razer') >= 0 ||
      parserName.indexOf('parserazer') >= 0) {
    var razer = msParseRazerSpecs_(html);
    if (Object.keys(razer).length) {
      razer.__parser_used = 'Razer embedded JSON/features';
      return razer;
    }
  }

  // Generic fallback works for many product pages with JSON-LD Product/Offer data.
  var generic = msParseGenericJsonLd_(html);
  if (Object.keys(generic).length) {
    generic.__parser_used = 'Generic JSON-LD';
    return generic;
  }

  // Extension point for additional manufacturers. Keep empty parsers returning {}.
  var custom = msParseOtherBrandSpecs_(product, rule, html);
  custom.__parser_used = custom.__parser_used || 'Other-brand extension';
  return custom;
}

/** Logitech-specific extraction: inRiverTechSpecs, productDimensions, JSON-LD and nearby text. */
function msParseLogitechSpecs_(html) {
  var out = {};
  var blocks = msExtractEmbeddedJsonCandidates_(html);
  blocks.forEach(function(obj) { msWalkObjectForSpecs_(obj, out); });

  // Logitech pages often include inRiverTechSpecs as a JSON-like embedded object.
  var markerPositions = ['inRiverTechSpecs', 'productDimensions'];
  markerPositions.forEach(function(marker) {
    var start = 0;
    while ((start = html.indexOf(marker, start)) >= 0) {
      var snippet = html.slice(Math.max(0, start - 200), Math.min(html.length, start + 18000));
      msParseLooseSpecText_(snippet, out);
      start += marker.length;
    }
  });
  msParseLooseSpecText_(html, out);
  return msRemoveInternalKeys_(out);
}

/** Razer-specific extraction: embedded feature objects, featureValues and JSON-LD. */
function msParseRazerSpecs_(html) {
  var out = {};
  msExtractEmbeddedJsonCandidates_(html).forEach(function(obj) {
    msWalkObjectForSpecs_(obj, out);
  });

  // Restrict text-based scans to feature-related regions when possible, then use full HTML fallback.
  var markers = ['mice-mice-specifications', 'featureValues', 'specifications', 'features'];
  var foundMarker = false;
  markers.forEach(function(marker) {
    var start = 0;
    while ((start = html.indexOf(marker, start)) >= 0) {
      foundMarker = true;
      var snippet = html.slice(Math.max(0, start - 200), Math.min(html.length, start + 25000));
      msParseLooseSpecText_(snippet, out);
      start += marker.length;
    }
  });
  if (!foundMarker || !Object.keys(out).length) msParseLooseSpecText_(html, out);
  return msRemoveInternalKeys_(out);
}

/** Generic parser for Product JSON-LD and similar embedded schema.org objects. */
function msParseGenericJsonLd_(html) {
  var out = {};
  msExtractEmbeddedJsonCandidates_(html).forEach(function(obj) {
    msWalkObjectForSpecs_(obj, out);
  });
  msParseLooseSpecText_(html, out);
  return msRemoveInternalKeys_(out);
}

/**
 * FUTURE BRAND EXTENSION POINT.
 * Add parsers for SteelSeries, Corsair, Endgame Gear, Zowie, etc. here.
 * Example:
 * if (/steelseries/i.test(product.brand)) return msParseSteelSeriesSpecs_(html);
 */
function msParseOtherBrandSpecs_(product, rule, html) {
  // Keep this function intentionally empty: generic JSON-LD is already tried.
  // Add a brand-specific parser here when its official site requires custom logic.
  return {};
}

/** Extract JSON/JSON-LD script bodies and selected assignment/object snippets. */
function msExtractEmbeddedJsonCandidates_(html) {
  var candidates = [];
  var scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  var match;
  while ((match = scriptRegex.exec(html)) !== null) {
    var body = match[1] || '';
    if (!body.trim()) continue;
    var typeMatch = (match[0].match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (/json|ld\+json|application\/javascript|text\/javascript/i.test(typeMatch) ||
        /"@type"\s*:\s*"(Product|WebPage)|inRiverTechSpecs|featureValues|productDimensions/i.test(body)) {
      var parsed = msTryParseJsonVariants_(body);
      parsed.forEach(function(item) { candidates.push(item); });
    }
  }

  // Try to parse JSON-like values around known embedded-data markers.
  ['inRiverTechSpecs', 'productDimensions', 'featureValues', 'mice-mice-specifications'].forEach(function(marker) {
    var pos = 0;
    while ((pos = html.indexOf(marker, pos)) >= 0) {
      var start = html.indexOf('{', pos);
      if (start >= 0 && start - pos < 500) {
        var chunk = msExtractBalancedJson_(html, start, 120000);
        if (chunk) {
          try { candidates.push(JSON.parse(chunk)); } catch (e) {}
        }
      }
      pos += marker.length;
    }
  });
  return candidates;
}

/** Parse plain JSON, JSON wrapped in assignment syntax, or JSON-LD arrays. */
function msTryParseJsonVariants_(body) {
  var results = [];
  var text = String(body || '').trim();
  if (!text) return results;
  try { results.push(JSON.parse(text)); return results; } catch (e) {}
  var first = text.indexOf('{');
  var last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    var candidate = text.slice(first, last + 1);
    try { results.push(JSON.parse(candidate)); } catch (e2) {
      // Some embedded scripts are JavaScript objects rather than strict JSON.
      // Avoid eval; extract key/value text with regex instead.
    }
  }
  return results;
}

/** Returns one balanced {...} substring while respecting quoted strings. */
function msExtractBalancedJson_(text, start, maxChars) {
  var depth = 0, inString = false, escaped = false;
  var end = Math.min(text.length, start + (maxChars || 50000));
  for (var i = start; i < end; i++) {
    var ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

/** Walk arbitrary nested JSON and map common spec labels into canonical fields. */
function msWalkObjectForSpecs_(node, out, depth) {
  depth = depth || 0;
  if (depth > 18 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach(function(item) { msWalkObjectForSpecs_(item, out, depth + 1); });
    return;
  }
  if (typeof node !== 'object') return;

  var keys = Object.keys(node);
  keys.forEach(function(key) {
    var value = node[key];
    var normalizedKey = msNormalizeSpecKey_(key);
    var extracted = msMapSpecLabelToField_(normalizedKey, value);
    if (extracted) msSetIfBetter_(out, extracted.key, extracted.value);
    if (value && typeof value === 'object') {
      // Many sites use {name:"Weight", value:"60 g"} or {label, featureValues}.
      var label = node.name || node.label || node.title || node.featureName || node.specificationName || '';
      if (label) {
        var labelMatch = msMapSpecLabelToField_(msNormalizeSpecKey_(label), value);
        if (labelMatch) msSetIfBetter_(out, labelMatch.key, labelMatch.value);
      }
      msWalkObjectForSpecs_(value, out, depth + 1);
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      var direct = msMapSpecLabelToField_(normalizedKey, value);
      if (direct) msSetIfBetter_(out, direct.key, direct.value);
    }
  });

  // Handle arrays/objects where labels and values are sibling properties.
  var labelValue = node.name || node.label || node.title || node.featureName ||
    node.specificationName || node.key || node.attribute || '';
  var rawValue = node.value !== undefined ? node.value :
    (node.featureValue !== undefined ? node.featureValue :
      (node.values !== undefined ? node.values : node.content));
  if (labelValue && rawValue !== undefined) {
    var pair = msMapSpecLabelToField_(msNormalizeSpecKey_(labelValue), rawValue);
    if (pair) msSetIfBetter_(out, pair.key, pair.value);
  }
}

/** Scan text around embedded labels as a fallback when strict JSON parsing is impossible. */
function msParseLooseSpecText_(text, out) {
  if (!text || !out) return;
  var s = msDecodeHtmlEntities_(String(text));
  var patterns = [
    { key: 'sensor_name', re: /(?:sensor(?:\s+name)?|optical\s+sensor)\s*["']?\s*[:=]\s*["']?([^"',}<\n]{2,100})/ig },
    { key: 'dpi_min', re: /(?:minimum\s+dpi|min(?:imum)?\s+dpi|dpi\s+range)\s*["']?\s*[:=]\s*["']?([\d,]+)\s*(?:-|to|~)/ig },
    { key: 'dpi_max', re: /(?:maximum\s+dpi|max(?:imum)?\s+dpi|up\s+to\s+dpi|dpi\s+range)\s*["']?\s*[:=]\s*["']?([\d,]+)/ig },
    { key: 'max_speed_ips', re: /(?:max(?:imum)?\s+speed|speed)\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*(?:ips|inches\s+per\s+second)/ig },
    { key: 'max_acceleration_g', re: /(?:max(?:imum)?\s+acceleration|acceleration)\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*g\b/ig },
    { key: 'max_polling_rate_hz', re: /(?:max(?:imum)?\s+polling(?:\s+rate)?|polling\s+rate)\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*(?:hz|khz)?/ig },
    { key: 'button_count', re: /(?:number\s+of\s+buttons|buttons|button\s+count)\s*["']?\s*[:=]\s*["']?(\d{1,2})/ig },
    { key: 'weight_g', re: /(?:weight|mass)\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*g\b/ig },
    { key: 'length_mm', re: /(?:length|depth)\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*mm\b/ig },
    { key: 'width_mm', re: /width\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*mm\b/ig },
    { key: 'height_mm', re: /height\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*mm\b/ig },
    { key: 'battery_life_hours', re: /(?:battery\s+life|battery\s+duration|up\s+to)\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*(?:hours|hour|hrs|hr|h)\b/ig },
    { key: 'switch_lifecycle', re: /(?:switch\s+life|lifecycle|clicks)\s*["']?\s*[:=]\s*["']?([\d,.]+)\s*(million|billion)?\s*(?:clicks)?/ig }
  ];
  patterns.forEach(function(p) {
    var m;
    while ((m = p.re.exec(s)) !== null) {
      var val = m[1];
      if (p.key === 'dpi_min' || p.key === 'dpi_max' || p.key === 'max_speed_ips' ||
          p.key === 'max_acceleration_g' || p.key === 'max_polling_rate_hz' ||
          p.key === 'button_count' || p.key === 'weight_g' || p.key === 'length_mm' ||
          p.key === 'width_mm' || p.key === 'height_mm' || p.key === 'battery_life_hours' ||
          p.key === 'switch_lifecycle') {
        val = msParseNumber_(val);
      } else {
        val = msCleanText_(val);
      }
      msSetIfBetter_(out, p.key, val);
      if (p.key === 'switch_lifecycle' && m[2]) {
        out.switch_lifecycle_unit = String(m[2]).toLowerCase();
      }
    }
  });

  // Human-readable specifications often occur as label/value text rather than JSON keys.
  var plain = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  var extra = [
    { re: /HERO\s*2/i, key: 'sensor_name', value: 'HERO 2' },
    { re: /LIGHTFORCE/i, key: 'switch_type', value: 'LIGHTFORCE hybrid switches' },
    { re: /Focus Pro\s+(\d+)K\s+Optical Sensor(?:\s+Gen-?(\d+))?/i, key: 'sensor_name', build: function(m) { return 'Focus Pro ' + m[1] + 'K Optical Sensor' + (m[2] ? ' Gen-' + m[2] : ''); } },
    { re: /Razer Optical Mouse Switches?\s+Gen-?(\d+)/i, key: 'switch_type', build: function(m) { return 'Razer Optical Mouse Switches Gen-' + m[1]; } },
    { re: /(?:LIGHTSPEED|HyperSpeed Wireless(?:\s+Gen-?\d+)?)/i, key: 'wireless_technology', build: function(m) { return m[0]; } },
    { re: /Bluetooth/i, key: 'bluetooth_support', value: 'Yes' },
    { re: /onboard memory|on-board memory/i, key: 'onboard_memory', value: 'Yes' },
    { re: /Razer Synapse/i, key: 'software_requirement', value: 'Razer Synapse' },
    { re: /Logitech G HUB/i, key: 'software_requirement', value: 'Logitech G HUB' }
  ];
  extra.forEach(function(p) {
    var m = plain.match(p.re);
    if (m) msSetIfBetter_(out, p.key, p.build ? p.build(m) : p.value);
  });
}

/** Map keys/labels from different manufacturers to canonical Mouse_Specs fields. */
function msMapSpecLabelToField_(key, value) {
  var k = msNormalizeSpecKey_(key);
  var v = msScalarValue_(value);
  if (v === '' || v === null || v === undefined) return null;

  var rules = [
    ['sensor_name', /^(sensor|sensorname|opticalsensor|sensornameandtype|sensortechnology|sensormodel)$/],
    ['dpi_min', /^(dpimin|minimumdpi|mindpi|minimumresolution|minimumcpi)$/],
    ['dpi_max', /^(dpimax|maximumdpi|maxdpi|upto\d*dpi|resolution|maxresolution|maximumresolution|cpi)$/],
    ['max_speed_ips', /^(maxspeed|maxspeedips|maximumspeed|speed|trackingspeed|maximumtracking speed|ips|inchespersecond)$/],
    ['max_acceleration_g', /^(maxacceleration|maximumacceleration|acceleration|accelerationg|maxaccelerationg)$/],
    ['max_polling_rate_hz', /^(pollingrate|pollingratehz|maxpollingrate|maxpollingratehz|reportrate|maximumreportrate|usbreportrate|reportingrate)$/],
    ['connection_type', /^(connection|connectivity|connectiontype|connectivitytechnology)$/],
    ['wireless_technology', /^(wireless|wirelesstechnology|wirelessconnection|wirelesstechnologytype)$/],
    ['wired_connection', /^(wired|wiredconnection|cable|cabletype|usbconnection|wiredconnectivity)$/],
    ['bluetooth_support', /^(bluetooth|bluetoothsupport|bluetoothconnectivity)$/],
    ['button_count', /^(buttons|numberofbuttons|buttoncount|programmablebuttons|totalbuttons)$/],
    ['switch_type', /^(switch|switchtype|switchtechnology|leftandrightbuttons|buttonswitches|switches)$/],
    ['switch_lifecycle', /^(switchlife|switchlifecycle|lifecycle|clicklifecycle|switchdurability|durability)$/],
    ['weight_g', /^(weight|weightg|productweight|mass|mouseweight)$/],
    ['length_mm', /^(length|lengthmm|depth|depthmm|productlength)$/],
    ['width_mm', /^(width|widthmm|productwidth)$/],
    ['height_mm', /^(height|heightmm|productheight)$/],
    ['battery_life_hours', /^(batterylife|batterylifehours|batteryhours|battery|batteryperformance|batteryduration)$/],
    ['battery_life_conditions', /^(batterylifeconditions|batterylifeup to|batterynotes|batterylifedetails)$/],
    ['onboard_memory', /^(onboardmemory|onboardprofile|onboardprofiles|onboardstorage|memoryprofiles)$/],
    ['software_requirement', /^(software|softwarerequirement|softwarecompatibility|configurationsoftware|driver|application)$/]
  ];
  for (var i = 0; i < rules.length; i++) {
    if (rules[i][1].test(k)) {
      var val = v;
      if (rules[i][0] === 'dpi_min' || rules[i][0] === 'dpi_max' ||
          rules[i][0] === 'max_speed_ips' || rules[i][0] === 'max_acceleration_g' ||
          rules[i][0] === 'max_polling_rate_hz' || rules[i][0] === 'button_count' ||
          rules[i][0] === 'weight_g' || rules[i][0] === 'length_mm' ||
          rules[i][0] === 'width_mm' || rules[i][0] === 'height_mm' ||
          rules[i][0] === 'battery_life_hours' || rules[i][0] === 'switch_lifecycle') {
        var number = msParseNumber_(v);
        if (number !== '') val = number;
      }
      if (rules[i][0] === 'switch_lifecycle' && typeof v === 'string') {
        var unit = v.match(/\b(million|billion)\b/i);
        if (unit) val = msParseNumber_(v);
      }
      return { key: rules[i][0], value: val };
    }
  }

  // Recognize labels that combine ranges/units or appear with slightly different wording.
  if (/\bdpi\b|resolution|cpi/i.test(k)) {
    var nums = String(v).match(/[\d,]+/g);
    if (nums && nums.length >= 2) {
      return { key: 'dpi_max', value: msParseNumber_(nums[nums.length - 1]) };
    }
    if (nums && nums.length === 1) return { key: 'dpi_max', value: msParseNumber_(nums[0]) };
  }
  if (/polling|reportrate/i.test(k)) return { key: 'max_polling_rate_hz', value: msParseRate_(v) };
  if (/weight/i.test(k)) return { key: 'weight_g', value: msParseUnitNumber_(v, 'g') };
  if (/length|depth/i.test(k)) return { key: 'length_mm', value: msParseUnitNumber_(v, 'mm') };
  if (/width/i.test(k)) return { key: 'width_mm', value: msParseUnitNumber_(v, 'mm') };
  if (/height/i.test(k)) return { key: 'height_mm', value: msParseUnitNumber_(v, 'mm') };
  if (/sensor/i.test(k)) return { key: 'sensor_name', value: v };
  if (/switch/i.test(k) && !/life|click|durab/i.test(k)) return { key: 'switch_type', value: v };
  return null;
}

/** Normalize parsed values and fill in non-source metadata. */
function msNormalizeMouseSpecs_(raw, product, rule) {
  raw = raw || {};
  var out = {};
  MOUSE_SPECS_HEADERS.forEach(function(header) {
    if (header === 'product_id') out[header] = String(product.product_id || '');
    else if (header === 'source_url') out[header] = String(product.official_url || '');
    else if (header === 'last_fetched_at') out[header] = new Date();
    else if (header === 'verification_status') out[header] = 'PENDING_REVIEW';
    else if (raw[header] !== undefined && raw[header] !== null && raw[header] !== '') {
      out[header] = raw[header];
    } else out[header] = '';
  });

  // Normalize numbers and known units without guessing missing values.
  [
    'dpi_min', 'dpi_max', 'max_speed_ips', 'max_acceleration_g',
    'max_polling_rate_hz', 'button_count', 'switch_lifecycle',
    'weight_g', 'length_mm', 'width_mm', 'height_mm', 'battery_life_hours'
  ].forEach(function(key) {
    if (out[key] !== '' && out[key] !== null && out[key] !== undefined) {
      var n = msParseNumber_(out[key]);
      if (n !== '') out[key] = n;
    }
  });

  if (out.max_polling_rate_hz !== '' && typeof out.max_polling_rate_hz === 'string') {
    out.max_polling_rate_hz = msParseRate_(out.max_polling_rate_hz);
  }
  if (out.switch_lifecycle !== '' && !out.switch_lifecycle_unit) {
    var lifeText = String(raw.switch_lifecycle || '');
    if (/billion/i.test(lifeText)) out.switch_lifecycle_unit = 'billion clicks';
    else if (/million/i.test(lifeText)) out.switch_lifecycle_unit = 'million clicks';
    else if (out.switch_lifecycle) out.switch_lifecycle_unit = 'clicks';
  }
  if (!out.connection_type) {
    var connectionBits = [];
    if (out.wireless_technology) connectionBits.push(String(out.wireless_technology));
    if (out.wired_connection) connectionBits.push('Wired');
    if (out.bluetooth_support && /yes|supported|built.?in/i.test(String(out.bluetooth_support))) connectionBits.push('Bluetooth');
    if (connectionBits.length) out.connection_type = connectionBits.join(' / ');
  }
  return out;
}

/**
 * Upsert one row per product_id.
 * Existing non-empty spec values are retained when a fresh scrape returns blanks.
 * source_url/time/status are always refreshed for a successful fetch result.
 */
function msSaveMouseSpecs_(sheet, productId, fresh, sourceUrl, scrapeStatus) {
  var lastCol = Math.max(sheet.getLastColumn(), MOUSE_SPECS_HEADERS.length);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(msHeaderKey_);
  var idCol = msHeaderIndex_(headers, ['product_id']);
  if (idCol < 0) throw new Error('Mouse_Specs sheet is missing product_id.');

  var lastRow = sheet.getLastRow();
  var rows = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var targetRow = -1;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol]).trim() === String(productId).trim()) {
      targetRow = i + 2;
      break;
    }
  }

  var old = targetRow > 0 ? rows[targetRow - 2] : new Array(lastCol).fill('');
  var output = old.slice();
  while (output.length < lastCol) output.push('');

  MOUSE_SPECS_HEADERS.forEach(function(header) {
    var col = msHeaderIndex_(headers, [header]);
    if (col < 0) return;
    var value = fresh[header];
    if (header === 'product_id') {
      output[col] = productId;
    } else if (header === 'source_url') {
      output[col] = sourceUrl || value || output[col] || '';
    } else if (header === 'last_fetched_at') {
      output[col] = new Date();
    } else if (header === 'verification_status') {
      output[col] = (scrapeStatus === 'PARSED' || scrapeStatus === 'PARTIAL')
        ? 'PENDING_REVIEW'
        : (output[col] || scrapeStatus || 'PENDING_REVIEW');
    } else if (value !== '' && value !== null && value !== undefined) {
      output[col] = value;
    }
  });

  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, 1, lastCol).setValues([output]);
  } else {
    sheet.appendRow(output);
  }
}

/** Append operational logs without failing the scrape if logging itself has an issue. */
function msWriteScrapeLog_(result) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(MOUSE_SPECS_SCRAPER_CONFIG.logSheet);
    if (!sheet) {
      sheet = ss.insertSheet(MOUSE_SPECS_SCRAPER_CONFIG.logSheet);
      msEnsureHeaders_(sheet, [
        'logged_at', 'product_id', 'product_name', 'brand', 'official_url',
        'rule_id', 'status', 'fields_found', 'message'
      ]);
    }
    sheet.appendRow([
      new Date(),
      result.product_id || '',
      result.product_name || '',
      result.brand || '',
      result.official_url || '',
      result.rule_id || '',
      result.status || '',
      (result.fields_found || []).join(', '),
      result.message || ''
    ]);
  } catch (e) {
    Logger.log('Could not write Mouse_Specs_Log: ' + e);
  }
}

/** Header and value helpers. */
function msEnsureHeaders_(sheet, requiredHeaders) {
  var lastCol = sheet.getLastColumn();
  if (sheet.getLastRow() === 0 || lastCol === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    sheet.setFrozenRows(1);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(v) {
    return String(v || '').trim();
  });
  var normalized = existing.map(msHeaderKey_);
  requiredHeaders.forEach(function(h) {
    if (normalized.indexOf(msHeaderKey_(h)) < 0) {
      existing.push(h);
      normalized.push(msHeaderKey_(h));
    }
  });
  if (existing.length > lastCol) sheet.getRange(1, 1, 1, existing.length).setValues([existing]);
  sheet.setFrozenRows(1);
}

function msHeaderKey_(value) {
  return String(value === null || value === undefined ? '' : value)
    .trim().toLowerCase().replace(/[\s\-]+/g, '_');
}
function msHeaderIndex_(normalizedHeaders, variants) {
  for (var i = 0; i < variants.length; i++) {
    var key = msHeaderKey_(variants[i]);
    var idx = normalizedHeaders.indexOf(key);
    if (idx >= 0) return idx;
  }
  return -1;
}
function msCell_(row, idx) {
  if (idx < 0 || idx >= row.length || row[idx] === null || row[idx] === undefined) return '';
  return String(row[idx]).trim();
}
function msNormalizeText_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}
function msNormalizeIds_(ids) {
  if (ids === null || ids === undefined || ids === '') return [];
  var arr = Array.isArray(ids) ? ids : String(ids).split(',');
  return arr.map(function(v) { return String(v).trim(); }).filter(Boolean);
}
function msNormalizeSpecKey_(key) {
  return String(key === null || key === undefined ? '' : key)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function msScalarValue_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return msCleanText_(value);
  if (Array.isArray(value)) return value.map(msScalarValue_).filter(function(x) { return x !== ''; }).join(', ');
  if (typeof value === 'object') {
    var preferred = ['value', 'featureValue', 'text', 'label', 'name', 'content', 'displayValue'];
    for (var i = 0; i < preferred.length; i++) {
      if (value[preferred[i]] !== undefined) return msScalarValue_(value[preferred[i]]);
    }
    return '';
  }
  return '';
}
function msCleanText_(value) {
  return msDecodeHtmlEntities_(String(value === null || value === undefined ? '' : value)
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^["']|["']$/g, ''));
}
function msDecodeHtmlEntities_(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}
function msParseNumber_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : '';
  var s = String(value === null || value === undefined ? '' : value).replace(/,/g, '');
  var m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : '';
}
function msParseRate_(value) {
  var n = msParseNumber_(value);
  if (n === '') return '';
  if (/khz/i.test(String(value))) return n * 1000;
  return n;
}
function msParseUnitNumber_(value, unit) {
  var s = String(value || '');
  if (unit === 'g' && /\bkg\b/i.test(s)) {
    var kg = msParseNumber_(s);
    return kg === '' ? '' : kg * 1000;
  }
  return msParseNumber_(s);
}
function msSetIfBetter_(out, key, value) {
  if (!key || value === '' || value === null || value === undefined) return;
  if (typeof value === 'string') value = msCleanText_(value);
  if (value === '') return;
  var existing = out[key];
  // Prefer explicit, non-generic values; don't replace a useful value with a vague one.
  if (existing === undefined || existing === '' || existing === null) {
    out[key] = value;
    return;
  }
  if (String(existing).length < String(value).length && !/^(yes|no|true|false)$/i.test(String(value))) {
    out[key] = value;
  }
}
function msRemoveInternalKeys_(obj) {
  Object.keys(obj).forEach(function(k) {
    if (k.indexOf('__') === 0) delete obj[k];
  });
  return obj;
}
function msIsDomainMatch_(url, domain) {
  try {
    var host = String(url).match(/^https?:\/\/([^\/?#]+)/i);
    if (!host) return false;
    var hostname = host[1].toLowerCase().replace(/^www\./, '');
    var expected = String(domain).toLowerCase().replace(/^www\./, '');
    return hostname === expected || hostname.slice(-(expected.length + 1)) === '.' + expected;
  } catch (e) { return false; }
}
function msUrlPatternMatch_(url, pattern) {
  var escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp('^' + escaped + '$', 'i').test(String(url)); }
  catch (e) { return String(url).indexOf(String(pattern).replace(/\*/g, '')) === 0; }
}
function testLogitechMouseSpecs() {
  return testMouseSpecsScraper('PROD-0060');
}

function testRazerMouseSpecs() {
  return testMouseSpecsScraper('PROD-0026');
}