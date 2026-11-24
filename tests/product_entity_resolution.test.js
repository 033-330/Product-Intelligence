const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['Store.js', 'Gemini.js', 'ProductUrlVerification.js', 'Pipeline.js', 'SpecIntelligence.js'];
const sources = files.reduce(function(out, file) {
  out[file] = fs.readFileSync(path.join(root, file), 'utf8');
  return out;
}, {});

const headers = {
  Products: [
    'product_id', 'canonical_name', 'brand', 'category', 'first_seen_issue', 'status', 'created_at',
    'official_url', 'official_url_status', 'official_url_checked_at', 'official_url_notes',
    'official_name', 'identity_source', 'identity_checked_at', 'identity_status',
    'resolution_status', 'identity_evidence', 'confirmed_at', 'confirmed_by',
  ],
  ProductAliases: ['alias', 'product_id', 'normalized', 'created_at', 'alias_status', 'evidence', 'source'],
  Product_Candidates: [
    'candidate_id', 'raw_mention', 'normalized_mention', 'canonical_candidate', 'brand', 'category',
    'sku', 'generation', 'variant', 'product_url_candidate', 'source', 'source_type',
    'identity_score', 'url_score', 'url_verified', 'resolution_status', 'proposed_product_id',
    'product_id', 'evidence_json', 'reject_reason', 'issue_no', 'created_at', 'updated_at',
  ],
  PendingQueue: ['item_id', 'item_type', 'payload_json', 'reason', 'status', 'created_at'],
  UrlVerificationTasks: [
    'task_id', 'product_id', 'url', 'status', 'priority', 'attempt_count', 'max_attempts',
    'next_attempt_at', 'created_at', 'started_at', 'finished_at', 'last_error', 'result', 'notes', 'checked_at',
  ],
  Specification_Dictionary: [
    'spec_id', 'category', 'canonical_field', 'display_name', 'description', 'data_type',
    'canonical_unit', 'normalization_rule', 'comparison_direction', 'required', 'aliases',
    'created_at', 'updated_at',
  ],
  Product_Specifications_Raw: [
    'raw_id', 'product_id', 'canonical_field', 'raw_field_name', 'raw_value', 'extracted_value',
    'source_url', 'source_title', 'source_type', 'evidence_text', 'extraction_method',
    'model_version', 'fetched_at', 'verification_status', 'rejection_reason',
  ],
  Product_Specifications: [
    'product_id', 'canonical_field', 'normalized_value', 'normalized_unit', 'selected_source_url',
    'source_type', 'evidence_text', 'verification_status', 'confidence', 'last_verified_at',
  ],
};

function createSheet(headerList, initialRows) {
  const h = headerList.slice();
  const rows = (initialRows || []).map(function(row) {
    return h.map(function(key) { return row[key] === undefined ? '' : row[key]; });
  });
  return {
    getDataRange: function() {
      return {
        getValues: function() {
          return [h.slice()].concat(rows.map(function(r) { return r.slice(); }));
        },
      };
    },
    getLastColumn: function() { return h.length; },
    getLastRow: function() { return rows.length + 1; },
    getRange: function(row, col, numRows, numCols) {
      return {
        getValues: function() {
          if (numRows && numCols) {
            const out = [];
            for (let r = 0; r < numRows; r++) {
              const line = [];
              for (let c = 0; c < numCols; c++) line.push(h[col - 1 + c]);
              out.push(line);
            }
            return out;
          }
          return [[h[col - 1]]];
        },
        setValues: function(values) {
          for (let r = 0; r < values.length; r++) {
            for (let c = 0; c < values[r].length; c++) {
              const targetRow = row - 1 + r;
              const targetCol = col - 1 + c;
              if (targetRow === 0) h[targetCol] = values[r][c];
              else {
                while (rows.length < targetRow) rows.push(h.map(() => ''));
                rows[targetRow - 1][targetCol] = values[r][c];
              }
            }
          }
        },
        setValue: function(value) {
          const targetRow = row - 1;
          const targetCol = col - 1;
          if (targetRow === 0) h[targetCol] = value;
          else rows[targetRow - 1][targetCol] = value;
        },
      };
    },
    appendRow: function(values) { rows.push(values.slice()); },
    clearContents: function() { rows.length = 0; },
  };
}

function makeSandbox(aiMapping, options) {
  options = options || {};
  const sheets = {};
  function ensureSheet(name) {
    if (!sheets[name]) sheets[name] = createSheet(headers[name] || ['value']);
    return sheets[name];
  }
  Object.keys(headers).forEach(ensureSheet);
  const products = [
    {
      product_id: 'P001', canonical_name: 'GPW5 Ultra', brand: 'Logitech', category: 'mouse',
      first_seen_issue: 'I001', status: 'active', created_at: '2026-01-01T00:00:00.000Z',
      official_url: 'https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.html',
      official_url_status: 'verified', official_url_checked_at: '2026-11-01T00:00:00.000Z',
      official_url_notes: 'confirmed', official_name: 'PRO X SUPERLIGHT 2',
      identity_source: 'official_catalog', identity_checked_at: '2026-11-01T00:00:00.000Z',
      identity_status: 'confirmed', resolution_status: 'confirmed',
      identity_evidence: 'official catalog exact name', confirmed_at: '2026-11-01T00:00:00.000Z',
      confirmed_by: 'catalog_review',
    },
    {
      product_id: 'P002', canonical_name: 'Viper V3 Pro', brand: 'Razer', category: 'mouse',
      first_seen_issue: 'I002', status: 'active', created_at: '2026-01-02T00:00:00.000Z',
      official_url: 'https://www.razer.com/gaming-mice/razer-viper-v3-pro',
      official_url_status: 'verified', official_url_checked_at: '2026-11-01T00:00:00.000Z',
      official_url_notes: 'confirmed', official_name: 'Razer Viper V3 Pro',
      identity_source: 'official_catalog', identity_checked_at: '2026-11-01T00:00:00.000Z',
      identity_status: 'confirmed', resolution_status: 'confirmed',
      identity_evidence: 'official catalog exact name', confirmed_at: '2026-11-01T00:00:00.000Z',
      confirmed_by: 'catalog_review',
    },
    {
      product_id: 'P003', canonical_name: 'OP1 8K', brand: 'Endgame Gear', category: 'mouse',
      first_seen_issue: 'I003', status: 'active', created_at: '2026-01-03T00:00:00.000Z',
      official_url: 'https://www.endgamegear.com/op1-8k',
      official_url_status: 'verified', official_url_checked_at: '2026-11-01T00:00:00.000Z',
      official_url_notes: 'confirmed', official_name: 'OP1 8K',
      identity_source: 'official_catalog', identity_checked_at: '2026-11-01T00:00:00.000Z',
      identity_status: 'confirmed', resolution_status: 'confirmed',
      identity_evidence: 'official catalog exact name', confirmed_at: '2026-11-01T00:00:00.000Z',
      confirmed_by: 'catalog_review',
    },
    {
      product_id: 'P004', canonical_name: 'Unknown Prototype', brand: 'Unknown', category: 'mouse',
      first_seen_issue: 'I004', status: 'auto', created_at: '2026-01-04T00:00:00.000Z',
      official_url: '', official_url_status: 'pending', official_url_checked_at: '',
      official_url_notes: '', official_name: '', identity_source: 'ai_hint',
      identity_checked_at: '', identity_status: 'unverified', resolution_status: 'unverified',
      identity_evidence: '', confirmed_at: '', confirmed_by: '',
    },
  ];
  const aliases = [
    {alias: 'GPW5 Ultra', product_id: 'P001', alias_status: 'confirmed', source: 'catalog'},
    {alias: 'PRO X SUPERLIGHT 2', product_id: 'P001', alias_status: 'confirmed', source: 'catalog'},
    {alias: 'Viper V3 Pro', product_id: 'P002', alias_status: 'confirmed', source: 'catalog'},
    {alias: 'OP1 8K', product_id: 'P003', alias_status: 'confirmed', source: 'catalog'},
  ];
  sheets.Products = createSheet(headers.Products, products);
  sheets.ProductAliases = createSheet(headers.ProductAliases, aliases);

  const sandbox = {
    console,
    Logger: {log: () => {}},
    CONFIG: {
      SPREADSHEET_ID: 'test-sheet',
      BRAND_SYNONYMS: {},
      PRODUCT_IDENTITY_ENABLED: false,
      PRODUCT_IDENTITY_MAX_PER_RUN: 0,
    },
    SpreadsheetApp: {openById: () => ({getSheetByName: name => ensureSheet(name)})},
    CacheService: {getScriptCache: () => ({get: () => null, put: () => {}})},
    PropertiesService: {getScriptProperties: () => ({getProperty: () => null})},
    Utilities: {computeSha256: value => require('crypto').createHash('sha256').update(String(value)).digest('base64')},
    UrlFetchApp: {fetch: () => { throw new Error('not used'); }},
    LockService: {getScriptLock: () => ({waitLock: () => {}, releaseLock: () => {}})},
    Drive: {},
    Session: {getActiveUser: () => ({getEmail: () => 'test@example.com'})},
    scriptProperty_: () => '',
    hasConfiguredAIKey_: () => false,
    cacheGet_: () => null,
    cachePut_: () => {},
    detectBrandDomains_: () => ['logitechg.com', 'razer.com', 'endgamegear.com'],
    callAI: () => ({mapping: aiMapping || []}),
  };
  vm.createContext(sandbox);
  files.forEach(function(file) {
    new vm.Script(sources[file], {filename: file}).runInContext(sandbox);
  });
  sandbox.__pages = options.pages || {};
  sandbox.__extractionByProduct = options.extractionByProduct || {};
  sandbox.isAllowedOfficialProductUrl_ = url => /(logitechg\.com|razer\.com|endgamegear\.com)/i.test(String(url));
  sandbox.searchOfficialProductCandidates_ = () => [];
  sandbox.crawl4aiCanRender_ = () => false;
  sandbox.inspectOfficialProductUrl_ = function(url) {
    const page = sandbox.__pages[String(url)] || {title: 'Official Product'};
    return {status: 'matched', code: 200, title: page.title || 'Official Product', via: 'stub'};
  };
  sandbox.UrlFetchApp = {
    fetch: function(url) {
      const page = sandbox.__pages[String(url)] || {html: '<title>Official Product</title><body>Official Product</body>'};
      return {
        getResponseCode: () => 200,
        getContentText: () => page.html || '',
        getHeaders: () => ({}),
      };
    },
  };
  sandbox.clearCache = () => {};
  sandbox.callAI = function(prompt, schema, opts) {
    sandbox.__lastAiCall = {prompt, schema, opts};
    if (String(prompt).includes('严格的产品规格抽取器')) {
      const match = String(prompt).match(/product_id=([^；;\s]+)/);
      const productId = match ? match[1] : '';
      return sandbox.__extractionByProduct[productId] || {
        product_id: productId,
        product_name: '',
        source_url: '',
        specifications: [],
        missing_fields: ['weight_g'],
        extraction_warnings: [],
      };
    }
    return {mapping: aiMapping || []};
  };
  sandbox.__sheets = sheets;
  return sandbox;
}

function table(sandbox, name) {
  return sandbox.readTable(name);
}

const tests = [];
function test(name, fn) { tests.push({name, fn}); }

test('resolve schema no longer asks AI for URL fields', () => {
  const s = makeSandbox();
  const prompt = s.buildResolvePrompt_(['PRO X Superlight 3']);
  const schema = vm.runInContext('RESOLVE_SCHEMA', s);
  assert.ok(prompt.includes('不负责官网 URL 核验'));
  assert.ok(prompt.includes('不得输出任何 URL'));
  assert.ok(!JSON.stringify(schema).includes('official_url'));
  assert.ok(JSON.stringify(schema).includes('identity_evidence'));
  const candidateSchema = vm.runInContext('CANDIDATE_DISCOVERY_SCHEMA', s);
  assert.ok(JSON.stringify(candidateSchema).includes('product_url_candidate'));
});

test('current confirmed products resolve by exact alias without AI or new products', () => {
  const s = makeSandbox();
  const extracts = [
    {name_as_written: 'GPW5 Ultra', canonical_guess: 'GPW5 Ultra', brand_guess: 'Logitech', category_guess: 'mouse'},
    {name_as_written: 'Viper V3 Pro', canonical_guess: 'Viper V3 Pro', brand_guess: 'Razer', category_guess: 'mouse'},
    {name_as_written: 'OP1 8K', canonical_guess: 'OP1 8K', brand_guess: 'Endgame Gear', category_guess: 'mouse'},
  ];
  const resolved = s.resolveProducts_(extracts, 'I100', 'GPW5 Ultra Viper V3 Pro OP1 8K');
  assert.deepStrictEqual(Array.from(resolved).sort(), ['P001', 'P002', 'P003']);
  assert.strictEqual(s.__lastAiCall, undefined);
  assert.strictEqual(table(s, 'Products').length, 4);
  assert.strictEqual(table(s, 'Product_Candidates').length, 0);
});

test('Superlight 3 is quarantined instead of mapped to 2 DEX', () => {
  const mapping = [{
    name: 'PRO X Superlight 3',
    product_id: 'P001',
    canonical_name: 'PRO X SUPERLIGHT 2 DEX',
    brand: 'Logitech',
    category: 'mouse',
    resolution: 'ambiguous',
    identity_evidence: 'generation 3 conflicts with generation 2; DEX variant mismatch',
    confidence: 0.72,
  }];
  const s = makeSandbox(mapping);
  const extract = {
    name_as_written: 'PRO X Superlight 3',
    canonical_guess: 'PRO X Superlight 3',
    brand_guess: 'Logitech',
    category_guess: 'mouse',
  };
  const resolved = s.resolveProducts_([extract], 'I101', 'newsletter mentions PRO X Superlight 3');
  assert.strictEqual(resolved.size, 0);
  assert.strictEqual(extract.product_id, undefined);
  const candidates = table(s, 'Product_Candidates');
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].raw_mention, 'PRO X Superlight 3');
  assert.strictEqual(candidates[0].canonical_candidate, 'PRO X SUPERLIGHT 2 DEX');
  assert.strictEqual(candidates[0].resolution_status, 'ambiguous');
  assert.strictEqual(candidates[0].proposed_product_id, 'P001');
  assert.strictEqual(candidates[0].product_id, '');
  assert.strictEqual(table(s, 'Products').length, 4);
});

test('spec pipeline rejects unconfirmed product before crawling', () => {
  const s = makeSandbox();
  assert.strictEqual(s.spiProductReadyForSpecs_(table(s, 'Products').find(p => p.product_id === 'P001')), true);
  assert.strictEqual(s.spiProductReadyForSpecs_(table(s, 'Products').find(p => p.product_id === 'P004')), false);
  const report = s.syncProductSpecifications('P004');
  assert.strictEqual(report.status, 'product_not_confirmed');
  assert.ok(report.reject_reason.includes('未确认'));
});

test('confirmed candidate promotion creates product only with verified URL', () => {
  const s = makeSandbox();
  const candidate = s.upsertProductCandidate_('狗五', {
    canonical_candidate: 'PRO X SUPERLIGHT 2',
    brand: 'Logitech',
    category: 'mouse',
    source: 'manual_review',
    source_type: 'human',
    resolution_status: 'confirmed',
    url_verified: false,
    product_url_candidate: 'https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.html',
    evidence: {official_name: 'PRO X SUPERLIGHT 2'},
  }, {issue_no: 'I200'});
  assert.strictEqual(candidate.candidate_id, 'CAND-0001');
  assert.throws(() => s.promoteProductCandidate_('CAND-0001', {url_verified: false}), /URL 未核验/);
  const productId = s.promoteProductCandidate_('CAND-0001', {
    url_verified: true,
    canonical_name: 'PRO X SUPERLIGHT 2',
    evidence_text: 'Official product name: PRO X SUPERLIGHT 2',
    confirmed_by: 'test_reviewer',
  });
  assert.strictEqual(productId, 'PROD-0005');
  const product = table(s, 'Products').find(p => p.product_id === productId);
  assert.strictEqual(product.identity_status, 'confirmed');
  assert.strictEqual(product.official_url_status, 'verified');
  assert.strictEqual(product.official_name, 'PRO X SUPERLIGHT 2');
  assert.ok(table(s, 'ProductAliases').some(a => a.alias === '狗五' && a.product_id === productId && a.alias_status === 'confirmed'));
});

test('three confirmed products produce specs from synthetic official page fixtures', () => {
  const pages = {
    'https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.html': {
      title: 'PRO X SUPERLIGHT 2',
      html: '<html><head><title>PRO X SUPERLIGHT 2</title></head><body><h1>PRO X SUPERLIGHT 2 / GPW5 Ultra</h1><p>Weight: 60 g</p><p>Polling Rate: 1000 Hz</p></body></html>',
    },
    'https://www.razer.com/gaming-mice/razer-viper-v3-pro': {
      title: 'Razer Viper V3 Pro',
      html: '<html><head><title>Razer Viper V3 Pro</title></head><body><h1>Razer Viper V3 Pro</h1><p>Weight: 54 g</p><p>Polling Rate: 8000 Hz</p></body></html>',
    },
    'https://www.endgamegear.com/op1-8k': {
      title: 'OP1 8K',
      html: '<html><head><title>OP1 8K</title></head><body><h1>OP1 8K</h1><p>Weight: 49 g</p><p>Polling Rate: 8000 Hz</p></body></html>',
    },
  };
  const extractionByProduct = {
    P001: {
      product_id: 'P001', product_name: 'GPW5 Ultra', source_url: pages['https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.html'].html,
      specifications: [
        {canonical_field: 'weight_g', raw_field_name: 'Weight', raw_value: '60 g', normalized_value: '60', normalized_unit: 'g', evidence_text: 'Weight: 60 g', confidence: 0.95},
        {canonical_field: 'polling_rate_hz', raw_field_name: 'Polling Rate', raw_value: '1000 Hz', normalized_value: '1000', normalized_unit: 'Hz', evidence_text: 'Polling Rate: 1000 Hz', confidence: 0.95},
      ],
      missing_fields: [], extraction_warnings: [],
    },
    P002: {
      product_id: 'P002', product_name: 'Viper V3 Pro', source_url: pages['https://www.razer.com/gaming-mice/razer-viper-v3-pro'].html,
      specifications: [
        {canonical_field: 'weight_g', raw_field_name: 'Weight', raw_value: '54 g', normalized_value: '54', normalized_unit: 'g', evidence_text: 'Weight: 54 g', confidence: 0.95},
        {canonical_field: 'polling_rate_hz', raw_field_name: 'Polling Rate', raw_value: '8000 Hz', normalized_value: '8000', normalized_unit: 'Hz', evidence_text: 'Polling Rate: 8000 Hz', confidence: 0.95},
      ],
      missing_fields: [], extraction_warnings: [],
    },
    P003: {
      product_id: 'P003', product_name: 'OP1 8K', source_url: pages['https://www.endgamegear.com/op1-8k'].html,
      specifications: [
        {canonical_field: 'weight_g', raw_field_name: 'Weight', raw_value: '49 g', normalized_value: '49', normalized_unit: 'g', evidence_text: 'Weight: 49 g', confidence: 0.95},
        {canonical_field: 'polling_rate_hz', raw_field_name: 'Polling Rate', raw_value: '8000 Hz', normalized_value: '8000', normalized_unit: 'Hz', evidence_text: 'Polling Rate: 8000 Hz', confidence: 0.95},
      ],
      missing_fields: [], extraction_warnings: [],
    },
  };
  const s = makeSandbox([], {pages, extractionByProduct});
  ['P001', 'P002', 'P003'].forEach(function(productId) {
    const report = s.syncProductSpecifications(productId);
    assert.strictEqual(report.status, 'done', JSON.stringify(report));
    assert.strictEqual(report.verification.status, 'verified');
    assert.ok(report.raw_write.written >= 2);
    assert.ok(report.canonical_write.written >= 2);
    assert.ok(report.coverage.fields_verified >= 2);
  });
  const canonical = s.readTable('Product_Specifications');
  const expected = {P001: '60', P002: '54', P003: '49'};
  Object.keys(expected).forEach(function(productId) {
    assert.ok(canonical.some(function(r) {
      return r.product_id === productId && r.canonical_field === 'weight_g' && String(r.normalized_value) === expected[productId];
    }), productId + ' weight_g missing');
  });
});

let passed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log('PASS ' + t.name);
  } catch (err) {
    console.error('FAIL ' + t.name);
    console.error(err && err.stack || err);
    process.exitCode = 1;
  }
}
console.log(passed + '/' + tests.length + ' tests passed');
