const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'SpecIntelligence.js'), 'utf8');

function createSandbox() {
  const tables = {
    Products: [{
      product_id: 'P001',
      canonical_name: 'GPW5 Ultra',
      brand: 'Logitech',
      category: 'mouse',
      official_name: 'PRO X SUPERLIGHT 2',
      aliases: 'GPW5 Ultra; PRO X SUPERLIGHT 2'
    }],
    Specification_Dictionary: [
      {category: 'mouse', canonical_field: 'weight_g', data_type: 'number', canonical_unit: 'g', normalization_rule: 'convert_to_grams'},
      {category: 'mouse', canonical_field: 'polling_rate_hz', data_type: 'number', canonical_unit: 'Hz', normalization_rule: 'normalize_hz'},
      {category: 'mouse', canonical_field: 'sensor_name', data_type: 'string', canonical_unit: '', normalization_rule: 'trim'}
    ],
    Product_Specifications_Raw: [],
    Product_Specifications: []
  };
  const sheets = {};
  function makeSheet() {
    return {
      getLastColumn: () => 1,
      getLastRow: () => 1,
      getRange: () => ({getValues: () => [['']], setValues: () => {}}),
      clear: () => {},
      appendRow: () => {},
      getRange: () => ({setValues: () => {}})
    };
  }
  const sandbox = {
    console,
    Logger: {log: () => {}},
    CONFIG: {SPREADSHEET_ID: 'test-sheet', CACHE_SECONDS: 300},
    CacheService: {getScriptCache: () => ({get: () => null, put: () => {}})},
    PropertiesService: {getScriptProperties: () => ({getProperty: () => null})},
    Utilities: {computeSha256: value => require('crypto').createHash('sha256').update(String(value)).digest('base64')},
    LockService: {getScriptLock: () => ({waitLock: () => {}, releaseLock: () => {}})},
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: name => {
          if (!sheets[name]) sheets[name] = makeSheet();
          return sheets[name];
        },
        insertSheet: name => {
          sheets[name] = makeSheet();
          return sheets[name];
        }
      })
    },
    UrlFetchApp: {fetch: () => { throw new Error('not used'); }},
    Drive: {},
    Session: {getActiveUser: () => ({getEmail: () => 'test@example.com'})},
    scriptProperty_: () => '',
    ss_: () => sandbox.SpreadsheetApp.openById('test-sheet'),
    readTable: name => (tables[name] || []).slice(),
    sheet_: name => sheets[name] || (sheets[name] = makeSheet()),
    rewriteTable_: (name, rows) => { tables[name] = rows.slice(); },
    clearCache: () => {},
    setupSheets: () => {},
    isAllowedOfficialProductUrl_: url => /(logitechg\.com|razer\.com|endgamegear\.com)/i.test(String(url)),
    productPageMatchesMulti_: () => true,
    inspectOfficialProductUrl_: () => ({status: 'verified'}),
    searchOfficialProductCandidates_: () => ({candidates: []}),
    crawl4aiCanRender_: () => false,
    crawl4aiDiscoverOfficialUrls_: () => ({candidates: []}),
    crawl4aiRenderPage_: () => null,
    callAI: () => ({ok: true, result: {}}),
    __tables: tables,
    __sheets: sheets
  };
  vm.createContext(sandbox);
  new vm.Script(source, {filename: 'SpecIntelligence.js'}).runInContext(sandbox);
  return sandbox;
}

function sourceContent(overrides = {}) {
  return Object.assign({
    source_url: 'https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.html',
    source_title: 'Official product page',
    source_type: 'official_product',
    product_id: 'P001',
    text: 'Weight: Approx. 60 grams. Sensor: HERO 2.',
    content_hash: 'hash-1',
    fetched_at: '2026-11-23T00:00:00.000Z',
    verification: {status: 'verified'}
  }, overrides);
}

function extracted(overrides = {}) {
  return Object.assign({
    source_content: sourceContent(),
    specifications: [
      {canonical_field: 'weight_g', raw_field_name: 'Weight', raw_value: 'Approx. 60 grams', evidence_text: 'Weight: Approx. 60 grams', confidence: 0.95},
      {canonical_field: 'sensor_name', raw_field_name: 'Sensor', raw_value: 'HERO 2', evidence_text: 'Sensor: HERO 2', confidence: 0.92}
    ],
    missing_fields: [],
    extraction_warnings: []
  }, overrides);
}

const tests = [];
function test(name, fn) { tests.push({name, fn}); }

test('source file parses as JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(source, {filename: 'SpecIntelligence.js'}));
});

test('source classification and priority', () => {
  const s = createSandbox();
  assert.strictEqual(s.spiClassifySpecSource_('https://www.logitechg.com/p.html'), 'official_product');
  assert.strictEqual(s.spiClassifySpecSource_('https://support.razer.com/kb/specs'), 'official_support');
  assert.strictEqual(s.spiClassifySpecSource_('https://www.rtings.com/mouse/reviews/x'), 'third_party');
  assert.strictEqual(s.spiSourcePriority_('official_pdf'), 85);
});

test('normalization handles grams, kilograms, kHz, and strings', () => {
  const s = createSandbox();
  assert.deepStrictEqual(s.spiNormalizeSpec_({raw_value: 'Approx. 60 grams'}, {data_type: 'number', canonical_unit: 'g', normalization_rule: 'convert_to_grams'}).value, 60);
  assert.strictEqual(s.spiNormalizeSpec_({raw_value: '0.06 kg'}, {data_type: 'number', canonical_unit: 'g', normalization_rule: 'convert_to_grams'}).value, 60);
  assert.strictEqual(s.spiNormalizeSpec_({raw_value: '4 kHz'}, {data_type: 'number', canonical_unit: 'Hz', normalization_rule: 'normalize_hz'}).value, 4000);
  assert.strictEqual(s.spiNormalizeSpec_({raw_value: 'HERO 2'}, {data_type: 'string'}).value, 'HERO 2');
});

test('evidence must appear in source text', () => {
  const s = createSandbox();
  assert.strictEqual(s.spiEvidenceSupported_('Weight: Approx. 60 grams', sourceContent().text), true);
  assert.strictEqual(s.spiEvidenceSupported_('Weight: 999 grams', sourceContent().text), false);
});

test('raw id is deterministic and content scoped', () => {
  const s = createSandbox();
  const a = s.spiRawId_('P001', 'weight_g', 'u1', '60 g', 'Weight: 60 g', 'h1');
  const b = s.spiRawId_('P001', 'weight_g', 'u1', '60 g', 'Weight: 60 g', 'h1');
  const c = s.spiRawId_('P001', 'weight_g', 'u1', '63 g', 'Weight: 63 g', 'h2');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('validation accepts evidence-backed values and rejects unsupported evidence', () => {
  const s = createSandbox();
  const result = s.validateProductSpecifications('P001', extracted({
    specifications: [
      {canonical_field: 'weight_g', raw_field_name: 'Weight', raw_value: 'Approx. 60 grams', evidence_text: 'Weight: Approx. 60 grams', confidence: 0.95},
      {canonical_field: 'sensor_name', raw_field_name: 'Sensor', raw_value: 'HERO 2', evidence_text: 'not in page', confidence: 0.9}
    ]
  }));
  assert.strictEqual(result.status, 'validated');
  assert.strictEqual(result.accepted.length, 1);
  assert.strictEqual(result.accepted[0].normalized_value, 60);
  assert.strictEqual(result.rejected[0].reason, 'evidence_not_in_source');
});

test('conflicts use higher-priority existing observations', () => {
  const s = createSandbox();
  s.__tables.Product_Specifications_Raw.push({
    raw_id: 'old-third-party',
    product_id: 'P001',
    canonical_field: 'weight_g',
    verification_status: 'accepted',
    extracted_value: JSON.stringify({normalized_value: 63, normalized_unit: 'g', confidence: 0.9}),
    source_url: 'https://example.com/review',
    source_type: 'third_party',
    evidence_text: 'Weight: 63 g',
    fetched_at: '2026-11-22T00:00:00.000Z'
  });
  const result = s.validateProductSpecifications('P001', extracted());
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].resolved_by, 'source_priority');
  assert.strictEqual(result.selected_winners[0].normalized_value, 60);
});

test('canonical update uses selected winners and preserves traceability', () => {
  const s = createSandbox();
  const result = s.validateProductSpecifications('P001', extracted());
  const write = s.updateCanonicalSpecifications(result);
  assert.strictEqual(write.written, 2);
  const row = s.getCanonicalSpecificationEvidence_('P001', 'weight_g');
  assert.strictEqual(Number(row.normalized_value), 60);
  assert.strictEqual(row.source_type, 'official_product');
  assert.ok(row.raw_id);
  assert.ok(row.evidence_text);
});

test('Gemini extraction prompt enforces evidence and unknown handling', () => {
  const s = createSandbox();
  let captured = null;
  s.callAI = (prompt, schema, opts) => {
    captured = {prompt, schema, opts};
    return {ok: true, result: {specifications: [], missing_fields: ['weight_g'], extraction_warnings: []}};
  };
  const result = s.extractProductSpecifications('P001', sourceContent());
  assert.ok(captured);
  assert.strictEqual(captured.opts.provider, 'gemini');
  assert.ok(captured.prompt.includes('evidence_text'));
  assert.ok(captured.prompt.includes('不得推断'));
  assert.ok(captured.prompt.includes('missing_fields'));
  assert.ok(captured.schema.required.includes('missing_fields'));
  assert.strictEqual(result.extraction_method, 'gemini_flash_evidence_prompt_v1');
});

let passed = 0;
for (const {name, fn} of tests) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err && err.stack || err);
    process.exitCode = 1;
  }
}
console.log(passed + '/' + tests.length + ' tests passed');
