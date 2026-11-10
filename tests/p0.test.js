'use strict';

/* tests/p0.test.js — V2.1 P0 纯函数测试（不依赖 GAS 运行时） */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = {
  console,
  Date,
  JSON,
  Math,
  String,
  Number,
  Object,
  Array,
  RegExp,
  Error,
  Set,
  Map,
  Logger: { log: function() {} },
  CONFIG: {
    SEGMENTER_VERSION: 'v2',
    SEGMENT_TARGET_CHARS: 4500,
    SEGMENT_MAX_CHARS: 6000,
    SEGMENT_TARGET_TOKENS: 2200,
    SEGMENT_MAX_TOKENS: 3000,
    SEGMENT_OVERLAP_CHARS: 120,
  },
  normalizeAlias: function(s) {
    return String(s || '').toLowerCase()
      .normalize('NFKC')
      .replace(/[\s\-_·.,;:!?'"()[\]\/\\]/g, '');
  },
  normalizeBrand_: function(b) { return String(b || ''); },
  readTable: function() { return []; },
  appendRow: function() { return {}; },
  sheet_: function() { return {}; },
  nextId: function() { return 'X-0001'; },
};

vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'Pipeline.js'), 'utf8'),
  sandbox,
  { filename: 'Pipeline.js' }
);

const results = [];
function check(name, pass, detail) {
  results.push({ name: name, pass: !!pass, detail: detail || '' });
}

/* ---------------- 结构感知分块 ---------------- */

const sample = [
  '# 第 14 期 产品跟踪',
  '',
  '## 鼠标新品',
  '',
  'Logitech G PRO X SUPERLIGHT 2 DEX 是本期重点，重量 60 g，售价 159.99 美元。',
  '不少用户认为这个价格偏高，但也有用户认可 60 g 的重量与 8 kHz 回报率。',
  '',
  '| 参数 | 数值 |',
  '| 重量 | 60 g |',
  '| DPI | 44000 |',
  '| 回报率 | 8000 Hz |',
  '',
  '## 键盘讨论',
  '',
  'Razer Huntsman V3 Pro 的模拟光轴引发讨论。',
  '- 支持 Rapid Trigger',
  '- 价格较高',
  '- 手感存在争议',
].join('\n');

const file = {
  getName: function() { return '第14期测试.txt'; },
  getUrl: function() { return 'smoke://test'; },
};

const first = sandbox.buildDeterministicSegments_(file, sample);
const second = sandbox.buildDeterministicSegments_(file, sample);
const docs = first.documents || [];

check('分块非空', docs.length > 0, 'docs=' + docs.length);
check('按章节切出多个分块', docs.length >= 2, 'docs=' + docs.length);
check('segment_id 稳定', JSON.stringify(docs.map(function(d) { return d.segment_id; }))
  === JSON.stringify((second.documents || []).map(function(d) { return d.segment_id; })));
check('content_hash 为 8 位', docs.every(function(d) { return /^[0-9a-f]{8}$/.test(d.content_hash); }));
check('parent_section 非空', docs.every(function(d) { return !!d.parent_section; }));
check('start/end offset 有效', docs.every(function(d) {
  return Number(d.start_offset) >= 0 && Number(d.end_offset) >= Number(d.start_offset);
}));

const tableDoc = docs.filter(function(d) {
  return String(d.text).indexOf('| 重量 | 60 g |') >= 0;
})[0];
check('表格未被拆散', !!tableDoc
  && String(tableDoc.text).indexOf('| DPI | 44000 |') >= 0
  && String(tableDoc.text).indexOf('| 回报率 | 8000 Hz |') >= 0);

check('所有分块覆盖原文关键句', docs.map(function(d) { return d.text; }).join('\n').indexOf('Razer Huntsman V3 Pro') >= 0);

/* ---------------- 产品名称强制校验 ---------------- */

const existing = [
  { product_id: 'PROD-0001', canonical_name: 'G PRO X SUPERLIGHT 2 DEX' },
];

const vOk = sandbox.validateProductNameBeforeWrite_('G PRO X SUPERLIGHT 2 DEX', {
  nameAsWritten: 'G PRO X SUPERLIGHT 2 DEX',
  sourceText: sample,
  existingProducts: [],
});
check('原文名称通过', vOk.ok === true, JSON.stringify(vOk));

const vBrand = sandbox.validateProductNameBeforeWrite_('Logitech', {
  nameAsWritten: 'Logitech',
  sourceText: sample,
  existingProducts: [],
});
check('品牌名被拒绝', vBrand.ok === false, vBrand.reason);

const vCategory = sandbox.validateProductNameBeforeWrite_('游戏鼠标', {
  nameAsWritten: '游戏鼠标',
  sourceText: sample,
  existingProducts: [],
});
check('品类名被拒绝', vCategory.ok === false, vCategory.reason);

const vFakeSuffix = sandbox.validateProductNameBeforeWrite_('G PRO X SUPERLIGHT 2 DEX (Hypothetical)', {
  nameAsWritten: 'G PRO X SUPERLIGHT 2 DEX',
  sourceText: sample,
  existingProducts: [],
});
check('AI 标注后缀被拒绝', vFakeSuffix.ok === false, vFakeSuffix.reason);

const vNotInSource = sandbox.validateProductNameBeforeWrite_('Imaginary Mouse X99', {
  nameAsWritten: 'Imaginary Mouse X99',
  sourceText: sample,
  existingProducts: [],
});
check('原文不存在的名称被拒绝', vNotInSource.ok === false, vNotInSource.reason);

const vDup = sandbox.validateProductNameBeforeWrite_('G PRO X SUPERLIGHT 2 DEX', {
  nameAsWritten: 'G PRO X SUPERLIGHT 2 DEX',
  sourceText: sample,
  existingProducts: existing,
});
check('重复产品返回 existingId', vDup.ok === false && vDup.existingId === 'PROD-0001', JSON.stringify(vDup));

const vEmpty = sandbox.validateProductNameBeforeWrite_('   ', {
  nameAsWritten: '',
  sourceText: sample,
  existingProducts: [],
});
check('空名称被拒绝', vEmpty.ok === false, vEmpty.reason);

/* ---------------- 其他纯函数 ---------------- */

check('token 估算对中文有效', sandbox.estimateTokens_('这是一段中文测试文本') >= 8,
  'tokens=' + sandbox.estimateTokens_('这是一段中文测试文本'));
check('contentHash_ 稳定', sandbox.contentHash_('abc') === sandbox.contentHash_('abc'));
check('contentHash_ 区分内容', sandbox.contentHash_('abc') !== sandbox.contentHash_('abd'));
check('docKey_ 优先 segment_id',
  sandbox.docKey_({ segment_id: 'SEG-1-abc', url: 'u', title: 't' }) === 'seg:SEG-1-abc');
check('docKey_ 兼容历史键',
  sandbox.docKey_({ url: 'https://a', title: 'B' }) === sandbox.normalizeAlias('https://a|B'));

let failed = 0;
results.forEach(function(r) {
  console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? ' — ' + r.detail : ''));
  if (!r.pass) failed++;
});
console.log('p0 tests: ' + (failed ? 'FAIL (' + failed + ')' : 'PASS'));
process.exitCode = failed ? 1 : 0;