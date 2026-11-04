#!/usr/bin/env node
/* tests/crawl4ai.manual.js — 单独测试 Crawl4AI Cloud /extract 的手动脚本。
 *
 * 设计目标：不改生产代码，直接复用 Crawl4AI.js 里的 instruction / schema /
 * unwrap / 归一化逻辑，只把 GAS 的 UrlFetchApp 换成 Node fetch，因此测的是
 * 真实抽取链路，而不是另写一份实现。
 *
 * 用法：
 *   node tests/crawl4ai.manual.js <url> [产品名] [--mode=specs|render] [--raw]
 *   node tests/crawl4ai.manual.js --self-test      # 本地 mock，不消耗配额
 *
 * 环境变量：
 *   CRAWL4AI_API_KEY   必填（--self-test 除外）
 *   CRAWL4AI_BASE      可选，默认 https://api.crawl4ai.com
 *
 * 退出码：0 通过，1 失败。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE = 'https://api.crawl4ai.com';
const DEFAULT_URL = 'https://example.com';
const DEFAULT_PRODUCT = 'Example Domain';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const opts = {
    url: '',
    product: '',
    mode: 'specs',
    raw: false,
    selfTest: false,
    maxAttempts: 3,
    timeoutMs: 40000
  };
  const positional = [];
  argv.forEach(arg => {
    if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--raw') opts.raw = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.indexOf('--mode=') === 0) opts.mode = arg.slice('--mode='.length).trim();
    else if (arg.indexOf('--max-attempts=') === 0) opts.maxAttempts = Number(arg.split('=')[1]);
    else if (arg.indexOf('--timeout=') === 0) opts.timeoutMs = Number(arg.split('=')[1]);
    else positional.push(arg);
  });
  opts.url = positional[0] || DEFAULT_URL;
  opts.product = positional[1] || DEFAULT_PRODUCT;
  return opts;
}

function printUsage() {
  console.log([
    '用法：',
    '  node tests/crawl4ai.manual.js <url> [产品名] [--mode=specs|render] [--raw]',
    '  node tests/crawl4ai.manual.js --self-test',
    '',
    '环境变量：',
    '  CRAWL4AI_API_KEY   必填（--self-test 除外）',
    '  CRAWL4AI_BASE      可选，默认 ' + DEFAULT_BASE,
    '',
    '示例：',
    '  CRAWL4AI_API_KEY=xxx node tests/crawl4ai.manual.js "https://www.logitechg.com/..." "Logitech G Pro X Superlight 2"',
    '  CRAWL4AI_API_KEY=xxx node tests/crawl4ai.manual.js "https://example.com" --mode=render'
  ].join('\n'));
}

/* 把 Crawl4AI.js 装进 VM，注入它唯一依赖的两个全局函数。
 * 本地手动测试不做域名白名单限制，所以 isAllowedOfficialProductUrl_ 恒为 true。 */
function createSandbox(env) {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    RegExp,
    String,
    Number,
    Object,
    Array,
    Set,
    Map,
    Error,
    encodeURIComponent,
    parseInt,
    parseFloat,
    isNaN
  };
  sandbox.scriptProperty_ = key => String((env && env[key]) || '').trim();
  sandbox.isAllowedOfficialProductUrl_ = () => true;
  sandbox.Utilities = { sleep: () => {} };
  vm.createContext(sandbox);
  const file = path.join(ROOT, 'Crawl4AI.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'Crawl4AI.js' });
  return sandbox;
}

/* 与 Crawl4AI.js 的 crawl4aiExtract_ 保持同样的重试语义：
 * 429 读 retry_after_s 等待，503/5xx 退避，402 不重试。 */
async function requestExtract(opts) {
  const { base, apiKey, url, instruction, schema, timeoutMs, maxAttempts } = opts;
  const doFetch = opts.fetchImpl || fetch;
  const body = JSON.stringify({ url, instruction, schema });
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(base + '/extract', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + apiKey
        },
        body,
        signal: controller.signal
      });
      const text = await response.text();
      const result = {
        status: response.status,
        text,
        ms: Date.now() - startedAt,
        attempts: attempt
      };
      if (response.status >= 200 && response.status < 300) {
        result.ok = true;
        return result;
      }
      if (response.status === 402) {
        result.ok = false;
        result.error = '余额不足（402），不重试';
        return result;
      }
      if (response.status === 429 && attempt < maxAttempts) {
        let waitS = 5;
        try {
          const body429 = JSON.parse(text);
          if (body429.retry_after_s) waitS = Math.max(1, Number(body429.retry_after_s));
        } catch (e) { /* 非 JSON 就用默认 5 秒 */ }
        waitS = Math.min(30, waitS);
        console.log('  [重试] HTTP 429 限流，等待 ' + waitS + 's 后重试（第 ' + attempt + ' 次失败）');
        await sleep(waitS * 1000);
        continue;
      }
      if ((response.status === 503 || response.status >= 500) && attempt < maxAttempts) {
        const waitMs = 4000 * attempt;
        console.log('  [重试] HTTP ' + response.status + '，等待 ' + (waitMs / 1000) + 's 后重试（第 ' + attempt + ' 次失败）');
        await sleep(waitMs);
        continue;
      }
      result.ok = false;
      result.error = 'HTTP ' + response.status;
      return result;
    } catch (e) {
      if (attempt < maxAttempts) {
        const waitMs = 4000 * attempt;
        console.log('  [重试] 请求异常：' + e.message + '，等待 ' + (waitMs / 1000) + 's 后重试');
        await sleep(waitMs);
        continue;
      }
      return {
        ok: false,
        status: 0,
        text: '',
        ms: Date.now() - startedAt,
        attempts: attempt,
        error: '请求超时或网络错误：' + e.message
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, text: '', ms: Date.now() - startedAt, attempts: maxAttempts, error: '重试次数耗尽' };
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) + '\n...（已截断，共 ' + s.length + ' 字符）' : s;
}

/* 执行一次测试，返回结构化结果供 main / self-test 共用。
 * deps.fetchImpl 仅供离线自测注入假实现，正常调用不传。 */
async function run(opts, env, deps) {
  const base = String((env && env.CRAWL4AI_BASE) || process.env.CRAWL4AI_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = String((env && env.CRAWL4AI_API_KEY) || process.env.CRAWL4AI_API_KEY || '').trim();
  const sandbox = createSandbox(env || {});

  const mode = opts.mode === 'render' ? 'render' : 'specs';
  const instruction = mode === 'render'
    ? sandbox.c4aiPageInstruction_(opts.product, opts.url)
    : sandbox.c4aiInstruction_(opts.product, opts.url);
  const schema = mode === 'render' ? sandbox.c4aiRenderSchema_() : sandbox.c4aiSpecSchema_();

  if (!apiKey) {
    throw new Error('缺少 CRAWL4AI_API_KEY。请先设置环境变量，或改用 --self-test 做离线验证。');
  }

  console.log('=== Crawl4AI 单次测试 ===');
  console.log('模式  ：' + mode);
  console.log('产品  ：' + opts.product);
  console.log('URL   ：' + opts.url);
  console.log('基址  ：' + base);
  console.log('超时  ：' + opts.timeoutMs + ' ms，最多尝试 ' + opts.maxAttempts + ' 次');

  const response = await requestExtract({
    base,
    apiKey,
    url: opts.url,
    instruction,
    schema,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    fetchImpl: deps && deps.fetchImpl
  });

  console.log('---');
  console.log('HTTP  ：' + response.status);
  console.log('耗时  ：' + response.ms + ' ms');
  console.log('尝试  ：' + response.attempts + ' 次');
  console.log('响应  ：' + String(response.text || '').length + ' 字符');

  if (!response.ok) {
    console.log('错误  ：' + (response.error || '未知'));
    console.log('响应体：' + truncate(response.text, 800));
    return { ok: false, mode, response, sandbox };
  }

  if (opts.raw) {
    console.log('\n--- 原始响应 ---');
    console.log(truncate(response.text, 8000));
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch (e) {
    console.log('错误  ：响应不是合法 JSON');
    console.log('响应体：' + truncate(response.text, 800));
    return { ok: false, mode, response, sandbox };
  }

  let payload;
  try {
    payload = sandbox.unwrapC4Payload_(parsed);
  } catch (e) {
    console.log('错误  ：' + e.message);
    return { ok: false, mode, response, sandbox, parsed };
  }

  console.log('\n--- 解包后字段 ---');
  console.log(Array.isArray(payload) ? '（数组，长度 ' + payload.length + '）' : Object.keys(payload || {}).join(', '));

  // 用预取的 payload 顶替网络调用，直接跑生产归一化函数。
  sandbox.crawl4aiExtract_ = () => payload;

  if (mode === 'render') {
    try {
      const rendered = sandbox.crawl4aiRenderPage_(opts.url, opts.product);
      console.log('\n--- 渲染结果 ---');
      console.log('title               ：' + rendered.title);
      console.log('product_name_on_page：' + rendered.product_name_on_page);
      console.log('strongText          ：' + truncate(rendered.strongText, 300));
      console.log('fullText            ：' + truncate(rendered.fullText, 800));
      return { ok: true, mode, response, payload, rendered, sandbox };
    } catch (e) {
      console.log('\n未通过：' + e.message);
      return { ok: false, mode, response, payload, sandbox, error: e.message };
    }
  }

  let extracted;
  try {
    extracted = sandbox.extractSpecsViaCrawl4AI_(opts.product, opts.url);
  } catch (e) {
    console.log('\n未通过：' + e.message);
    return { ok: false, mode, response, payload, sandbox, error: e.message };
  }

  console.log('\n--- 归一化结果 ---');
  console.log('name    ：' + extracted.name);
  console.log('brand   ：' + extracted.brand);
  console.log('model   ：' + extracted.model);
  console.log('crawler ：' + extracted.crawler);
  console.log('规格数  ：' + extracted.specs.length);
  if (extracted.specs.length) {
    console.log('');
    console.log('spec_key                    | value                | unit     | raw_value');
    console.log('----------------------------+----------------------+----------+----------------------');
    extracted.specs.forEach(s => {
      console.log(
        String(s.spec_key).padEnd(28).slice(0, 28) + '| ' +
        String(s.value).padEnd(21).slice(0, 21) + '| ' +
        String(s.unit || '').padEnd(9).slice(0, 9) + '| ' +
        truncate(s.raw_value, 60)
      );
    });
  }

  const ok = extracted.specs.length > 0;
  console.log('\n结论：' + (ok ? '通过（抽到 ' + extracted.specs.length + ' 条规格）' : '未通过（没有抽到任何规格）'));
  return { ok, mode, response, payload, extracted, sandbox };
}

/* 离线自测：注入假 fetch，第一次返回 429、第二次返回成功，
 * 验证重试、unwarp 与归一化链路，不依赖网络也不消耗真实配额。 */
async function selfTest() {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ retry_after_s: 1, error: 'rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      result: {
        page_match: true,
        product_name: 'Logitech G Pro X Superlight 2',
        brand: 'Logitech',
        model: 'G Pro X Superlight 2',
        specs: [
          { spec_key: 'weight_g', spec_label: 'Weight', value: 60, unit: 'g', raw_value: '60 g' },
          { spec_key: 'max_dpi', spec_label: 'Max DPI', value: 32000, unit: 'DPI', raw_value: '32,000 DPI' }
        ]
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  console.log('离线自测：使用假 fetch（不访问网络）\n');

  const result = await run(
    {
      url: 'https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.hero.html',
      product: 'Logitech G Pro X Superlight 2',
      mode: 'specs',
      raw: false,
      maxAttempts: 3,
      timeoutMs: 10000
    },
    { CRAWL4AI_API_KEY: 'self-test-key' },
    { fetchImpl: fakeFetch }
  );

  const renderFakeFetch = async () => new Response(JSON.stringify({
    result: {
      page_title: 'Logitech G PRO X SUPERLIGHT 2',
      page_h1: 'PRO X SUPERLIGHT 2',
      product_name_on_page: 'Logitech G PRO X SUPERLIGHT 2',
      page_excerpt: 'Weight 60 g, 32000 DPI'
    }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

  const renderResult = await run(
    {
      url: 'https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.hero.html',
      product: 'Logitech G Pro X Superlight 2',
      mode: 'render',
      raw: false,
      maxAttempts: 3,
      timeoutMs: 10000
    },
    { CRAWL4AI_API_KEY: 'self-test-key' },
    { fetchImpl: renderFakeFetch }
  );

  const checks = [
    ['429 触发了一次重试', calls === 2],
    ['render 模式取到页面标题', !!renderResult.rendered && renderResult.rendered.title === 'Logitech G PRO X SUPERLIGHT 2'],
    ['render 模式拼接出 strongText', !!renderResult.rendered && renderResult.rendered.strongText.indexOf('PRO X SUPERLIGHT 2') >= 0],
    ['请求成功', result.ok === true],
    ['抽到 2 条规格', !!result.extracted && result.extracted.specs.length === 2],
    ['单位归一化正确（g）', !!result.extracted && result.extracted.specs[0].unit === 'g'],
    ['数值保留为字符串', !!result.extracted && result.extracted.specs[1].value === '32000']
  ];

  console.log('\n--- 自测断言 ---');
  let failed = 0;
  checks.forEach(([name, pass]) => {
    console.log((pass ? '  PASS  ' : '  FAIL  ') + name);
    if (!pass) failed++;
  });

  console.log('\nself-test: ' + (failed ? 'FAIL' : 'PASS'));
  return failed === 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }
  if (['specs', 'render'].indexOf(opts.mode) < 0) {
    console.error('未知 --mode：' + opts.mode + '（只支持 specs / render）');
    return 1;
  }
  if (opts.selfTest) {
    return (await selfTest()) ? 0 : 1;
  }
  const result = await run(opts);
  return result.ok ? 0 : 1;
}

main()
  .then(code => { process.exitCode = code; })
  .catch(err => {
    console.error('测试脚本异常：' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });