const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sandbox = { console, Date, Math, JSON, RegExp, String, Number, Object, Array, Set, Map };
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

load('Store.js');
load('ReviewSearch.js');

assert.strictEqual(sandbox.normalizeAlias('Logitech G Pro-X'), 'logitechgprox');
assert.strictEqual(sandbox.normalizeAlias('  ＧＰＲＯ  '), 'gpro');
assert.strictEqual(sandbox.normalizeAlias('罗技·GPW'), '罗技gpw');

assert.strictEqual(sandbox.bigramSim_('无线连接', '无线连接'), 1);
assert.strictEqual(sandbox.bigramSim_('无线连接', '电池续航'), 0);
const partial = sandbox.bigramSim_('无线连接问题', '无线连接');
assert(partial > 0 && partial < 1);

let groups = sandbox.reviewExtractTerms_('battery life and connection issues');
assert.strictEqual(JSON.stringify(groups.map(g => g.key)), JSON.stringify(['battery_life', 'connection']));

groups = sandbox.reviewExtractTerms_('GPW5 续航');
assert.strictEqual(groups.length, 1);
assert.strictEqual(groups[0].key, 'battery_life');

assert.strictEqual(sandbox.reviewExtractTerms_('').length, 0);

groups = sandbox.reviewExtractTerms_('battery life and connection issues');
let matched = sandbox.reviewMatchedTerms_(
  'The battery life is great but bluetooth disconnects sometimes',
  groups
);
assert(matched.labels.indexOf('Battery life') >= 0);
assert(matched.labels.indexOf('Connection issues') >= 0);
assert(matched.terms.indexOf('battery life') >= 0);
assert(matched.terms.indexOf('bluetooth') >= 0);

matched = sandbox.reviewMatchedTerms_('nothing relevant here', groups);
assert.strictEqual(matched.groupCount, 0);
assert.strictEqual(matched.terms.length, 0);

console.log('pure tests: PASS');

load('Gemini.js');
sandbox.Logger = { log: function () {} };
sandbox.aiProviderOrder_ = function () { return ['gemini', 'openrouter']; };
sandbox.aiProviderKey_ = function () { return 'test-key'; };

let providerCalls = [];
sandbox.callGeminiProvider_ = function () {
  providerCalls.push('gemini');
  return 'gemini-ok';
};
sandbox.callOpenRouterProvider_ = function () {
  providerCalls.push('openrouter');
  throw new Error('should not be called');
};
assert.strictEqual(sandbox.callAI('hello'), 'gemini-ok');
assert.strictEqual(JSON.stringify(providerCalls), JSON.stringify(['gemini']));

providerCalls = [];
sandbox.callGeminiProvider_ = function () {
  providerCalls.push('gemini');
  throw new Error('quota exceeded');
};
sandbox.callOpenRouterProvider_ = function () {
  providerCalls.push('openrouter');
  return 'openrouter-ok';
};
assert.strictEqual(sandbox.callAI('hello'), 'openrouter-ok');
assert.strictEqual(JSON.stringify(providerCalls), JSON.stringify(['gemini', 'openrouter']));

console.log('ai fallback tests: PASS');