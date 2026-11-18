function smoke_createUrlIdentityTestProducts() {
  if (typeof setupSheets === 'function') setupSheets();
  var issueNo = 'URLID-TEST';
  var issueDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  ensureIssue_(issueNo, issueDate, 'urltest://identity');

  var fixtures = [
    { name: 'GPW5 Ultra', brand: 'Logitech', category: 'mouse' },
    { name: 'G Pro X Superlight 2 Ultra', brand: 'Logitech', category: 'mouse' },
    { name: 'G PRO X3 SUPER STRIKE', brand: 'Logitech', category: 'mouse' }
  ];
  var products = readTable('Products');
  var aliases = readTable('ProductAliases');
  var out = [];
  fixtures.forEach(function(f) {
    var key = normalizeAlias(f.name);
    var existing = products.filter(function(p) {
      return normalizeAlias(p.canonical_name || '') === key;
    })[0] || aliases.filter(function(a) {
      return normalizeAlias(a.normalized || a.alias || '') === key;
    })[0];
    if (existing) {
      out.push({ name: f.name, product_id: String(existing.product_id || ''), created: false });
      return;
    }
    var id = createProduct_(f.name, f.brand, f.category, issueNo, {
      nameSource: 'url_identity_test',
      nameAsWritten: f.name
    });
    out.push({ name: f.name, product_id: String(id || ''), created: true });
  });

  var rows = out.map(function(x) {
    return [new Date().toISOString(), x.product_id, 'create_test_product',
      x.created ? 'created' : 'exists', x.name];
  });
  writeUrlIdentityTestRows_(rows);
  Logger.log('URL identity test products: ' + JSON.stringify(out));
  return out;
}

function ensureUrlIdentityTestSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName('UrlIdentityTest');
  if (!sh) {
    sh = ss.insertSheet('UrlIdentityTest');
    sh.appendRow(['时间', 'product_id', '阶段', '状态', '详情']);
  }
  return sh;
}

function writeUrlIdentityTestRows_(rows) {
  if (!rows || !rows.length) return;
  var sh = ensureUrlIdentityTestSheet_();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
}

function smoke_urlIdentityTestBatch(ids, options) {
  options = options || {};
  var list = (ids && ids.length !== undefined) ? ids : [ids];
  list = list.map(function(x) { return String(x || '').trim(); }).filter(Boolean);
  if (!list.length) {
    var products = readTable('Products');
    list = products.filter(function(p) {
      var st = String(p.official_url_status || '').toLowerCase();
      return ['pending', 'check_failed', 'not_found', 'mismatch', 'ambiguous'].indexOf(st) >= 0;
    }).map(function(p) { return String(p.product_id); }).slice(0, 3);
  }
  var started = Date.now();
  var perTimeout = Math.max(30000, Math.min(Number(options.timeoutMs) || 75000, 150000));
  var results = [];
  list.forEach(function(id) {
    if (Date.now() - started > 220000) {
      results.push({ product_id: id, skipped: true, reason: 'batch time budget' });
      return;
    }
    try {
      var r = smoke_urlIdentityTest(id, {
        write: options.write === true,
        timeoutMs: perTimeout
      });
      results.push({ product_id: id, ok: r && r.ok !== false, candidates: r ? r.candidates : 0,
        elapsed_ms: r ? r.elapsed_ms : 0, identity: r ? r.identity : null });
    } catch (e) {
      results.push({ product_id: id, ok: false,
        reason: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });
  var rows = results.map(function(r) {
    return [new Date().toISOString(), r.product_id, 'batch',
      r.skipped ? 'skipped' : (r.ok ? 'ok' : 'fail'),
      JSON.stringify({ candidates: r.candidates, elapsed_ms: r.elapsed_ms,
        source: r.identity ? r.identity.source : '', reason: r.reason || '' })];
  });
  writeUrlIdentityTestRows_(rows);
  Logger.log('URL identity batch: ' + JSON.stringify(results));
  return { ok: results.every(function(r) { return r.skipped || r.ok; }),
    elapsed_ms: Date.now() - started, results: results };
}

function smoke_urlIdentitySelfTest() {
  var product = {
    product_id: 'TEST-0000',
    canonical_name: 'GPW5 Ultra',
    brand: 'Logitech',
    category: 'mouse'
  };
  var identity = {
    official_names: ['G PRO X SUPERLIGHT 2'],
    aliases: ['GPW5'],
    model_codes: ['SUPERLIGHT 2'],
    brand_domains: ['logitechg.com'],
    search_queries: ['Logitech G PRO X SUPERLIGHT 2'],
    confidence: 'high',
    notes: [],
    source: 'test'
  };
  var queries = identityQueries_(identity, product);
  var names = identityOfficialNames_(identity, product);
  var domains = identityDomains_(identity, product);
  var page = {
    title: 'G PRO X SUPERLIGHT 2 DEX',
    strongText: 'G PRO X SUPERLIGHT 2 DEX | Logitech G',
    fullText: 'G PRO X SUPERLIGHT 2 DEX wireless gaming mouse',
    identifiers: ['G PRO X SUPERLIGHT 2', 'SUPERLIGHT2'],
    jsonldText: 'G PRO X SUPERLIGHT 2'
  };
  var checks = [
    ['queries contain official name', queries.indexOf('Logitech G PRO X SUPERLIGHT 2') >= 0],
    ['official names resolved', names.indexOf('G PRO X SUPERLIGHT 2') >= 0],
    ['domains resolved', domains.indexOf('logitechg.com') >= 0],
    ['page matches via official name', productPageMatchesMulti_(product, page, names) === true]
  ];
  var rows = checks.map(function(c) {
    return [new Date().toISOString(), 'TEST-0000', 'selftest:' + c[0], c[1] ? 'ok' : 'fail', ''];
  });
  writeUrlIdentityTestRows_(rows);
  var ok = checks.every(function(c) { return c[1]; });
  Logger.log('URL identity self test: ' + (ok ? 'PASS' : 'FAIL') + ' | '
    + checks.map(function(c) { return c[0] + '=' + c[1]; }).join(', '));
  return { ok: ok, checks: checks, queries: queries, domains: domains };
}

function smoke_urlIdentityTest(productId, options) {
  options = options || {};
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  var pid = String(productId || '').trim();
  if (!pid && ui) {
    var answer = ui.prompt(
      'URL 身份解析测试',
      '输入 product_id（留空自动选择第一个待核验产品）：',
      ui.ButtonSet.OK_CANCEL
    );
    if (answer.getSelectedButton() !== ui.ButtonSet.OK) return { cancelled: true };
    pid = answer.getResponseText().trim();
  }

  var products = readTable('Products');
  var product = null;
  if (pid) {
    product = products.filter(function(p) { return String(p.product_id) === pid; })[0] || null;
  } else {
    product = products.filter(function(p) {
      var st = String(p.official_url_status || '').toLowerCase();
      return ['pending', 'check_failed', 'not_found', 'mismatch', 'ambiguous'].indexOf(st) >= 0;
    })[0] || products[0] || null;
  }
  if (!product) {
    Logger.log('URL identity test: Products 表为空或 product_id 不存在');
    return { ok: false, error: '找不到产品' };
  }

  var started = Date.now();
  var deadline = started + Math.max(30000, Math.min(Number(options.timeoutMs) || 120000, 150000));
  var rows = [];
  function add(stage, status, detail) {
    var line = [new Date().toISOString(), String(product.product_id), stage,
      String(status || ''), String(detail || '').slice(0, 800)];
    rows.push(line);
    Logger.log('[urlIdentityTest] ' + stage + ' | ' + status + ' | ' + line[4]);
  }

  add('start', 'info', String(product.canonical_name || '') + ' | brand=' + String(product.brand || ''));

  var identity = resolveProductIdentity_(product, deadline);
  add('identity', identity.source || '', JSON.stringify({
    official_names: identity.official_names,
    aliases: identity.aliases,
    model_codes: identity.model_codes,
    brand_domains: identity.brand_domains,
    search_queries: identity.search_queries,
    confidence: identity.confidence,
    notes: identity.notes
  }));

  var officialNames = identityOfficialNames_(identity, product);
  var queries = identityQueries_(identity, product);
  var domains = identityDomains_(identity, product);
  add('queries', 'info', queries.join(' || '));
  add('domains', 'info', domains.join(', '));
  add('official_names', 'info', officialNames.join(' | '));

  var candidates = [], seen = {};
  queries.forEach(function(q, i) {
    if (Date.now() >= deadline - 30000) {
      add('search:q' + (i + 1), 'skipped', '预算不足');
      return;
    }
    var t = Date.now();
    try {
      var found = searchOfficialProductCandidates_(q, deadline, { queries: [q], domains: domains });
      found.forEach(function(u) {
        if (!seen[u]) { seen[u] = 1; candidates.push(u); }
      });
      add('search:q' + (i + 1), 'ok',
        found.length + ' 条 / ' + (Date.now() - t) + 'ms | ' + found.slice(0, 4).join(' | '));
    } catch (e) {
      add('search:q' + (i + 1), 'fail', String(e && e.message ? e.message : e).slice(0, 300));
    }
  });

  candidates = candidates.slice(0, 8);
  add('candidates', 'info', candidates.length + ' 条');

  if (candidates.length) {
    var fetchStart = Date.now();
    var pages = fetchOfficialProductPages_(candidates, deadline);
    add('fetch', 'ok', (Date.now() - fetchStart) + 'ms / ' + Object.keys(pages).length + ' 页');
    candidates.forEach(function(url, i) {
      var page = pages[url] || { code: 0, html: '' };
      var info = extractPageIdentity_(page.html);
      var matched = productPageMatchesMulti_(product, info, officialNames);
      add('page:' + (i + 1), matched ? 'matched' : 'no',
        'HTTP ' + Number(page.code || 0) + ' | ' + String(info.title || '').slice(0, 120)
        + ' | ld=' + JSON.stringify((info.identifiers || []).slice(0, 5))
        + ' | ' + url.slice(0, 160));
    });
  }

  if (options.write === true) {
    var verifyStart = Date.now();
    try {
      verifyProductUrls_({
        ids: String(product.product_id),
        force: true,
        limit: 1,
        deadline_ms: Math.min(deadline, Date.now() + 60000)
      });
      var after = readTable('Products').filter(function(p) {
        return String(p.product_id) === String(product.product_id);
      })[0] || {};
      add('verify', 'done', (Date.now() - verifyStart) + 'ms | status='
        + String(after.official_url_status || '') + ' | url=' + String(after.official_url || '')
        + ' | official_name=' + String(after.official_name || ''));
    } catch (e) {
      add('verify', 'fail', String(e && e.message ? e.message : e).slice(0, 300));
    }
  } else {
    add('verify', 'skipped', 'dry-run，默认不写 Products；用 smoke_urlIdentityTest("PROD-xxxx", {write:true}) 才实际核验写回');
  }

  add('finish', 'info', '总耗时 ' + (Date.now() - started) + 'ms');
  writeUrlIdentityTestRows_(rows);
  Logger.log('报告已写入 UrlIdentityTest，行数=' + rows.length);

  return {
    ok: true,
    product_id: String(product.product_id),
    identity: identity,
    queries: queries,
    domains: domains,
    candidates: candidates.length,
    elapsed_ms: Date.now() - started,
    rows: rows.length
  };
}
