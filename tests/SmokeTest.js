/* ============================================================
 * tests/SmokeTest.js — 少量真实数据冒烟测试（Google Apps Script）
 *
 * 目的：用现有表里的真实产品验证本次改动
 * 重点：
 *   1. 产品实体过滤（品牌名/品类名/功能名不应识别为产品）
 *   2. 官网 URL 核验：失败时隔离（quarantined）而不是直接级联删除
 *   3. 耳机规格提取：区分听歌/通话续航、频响、灵敏度、驱动单元等
 *   4. 隔离产品不会进入规格采集队列
 * ============================================================ */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('冒烟测试')
    .addItem('1) 产品实体过滤（纯函数）', 'smoke_productEntity')
    .addItem('2) 随机挑1个产品跑 URL 核验', 'smoke_verifyOne')
    .addItem('3) 批量核验（最多5个，仅隔离不删除）', 'smoke_verifyBatch')
    .addItem('4) 耳机规格提取（用真实耳机产品）', 'smoke_extractHeadset')
    .addItem('5) 验证隔离产品不入队规格', 'smoke_quarantineBlocksTask')
    .addItem('6) 查看隔离/待复核状态', 'smoke_reportStatus')
    .addSeparator()
    .addItem('一键冒烟（推荐）', 'smoke_all')
    .addToUi();
}

function smoke_log_(title, msg) {
  var line = '[' + title + '] ' + msg;
  Logger.log(line);
  return line;
}

function smoke_getRealProducts_(limit) {
  limit = limit || 10;
  var list = readTable('Products').filter(function(p) {
    var st = String(p.status || '').toLowerCase();
    var cat = String(p.category || '').toLowerCase();
    if (st === 'merged' || st === 'brand' || cat === 'brand') return false;
    if (st === 'quarantined') return false;
    return true;
  });
  return list.slice(0, limit);
}

/* 1) 产品实体过滤 */
function smoke_productEntity() {
  var cases = [
    { v: 'GPW5', exp: true },
    { v: 'G Pro X Superlight 2', exp: true },
    { v: 'PRO X SUPERLIGHT 2', exp: true },
    { v: 'Cloud III', exp: true },
    { v: 'G915 TKL', exp: true },
    { v: 'HYPERX CLOUD ALPHA', exp: true },
    { v: 'Logitech', exp: false },
    { v: 'Razer', exp: false },
    { v: '雷蛇鼠标', exp: false },
    { v: '鼠标', exp: false },
    { v: '键盘', exp: false },
    { v: '耳机', exp: false },
    { v: '电磁微动', exp: false },
    { v: '光学微动', exp: false },
    { v: '霍尔效应微动', exp: false },
    { v: 'Hypershift', exp: false },
    { v: 'G 系列', exp: false },
    { v: 'PRO 系列', exp: false },
    { v: 'TTC Gold', exp: false },
    { v: 'Kailh BOX', exp: false },
    { v: 'Omron', exp: false }
  ];
  var pass = 0, fail = 0;
  var lines = ['=== 1) 产品实体过滤 ==='];
  cases.forEach(function(c) {
    var r = isLikelyProductEntity_(c.v);
    if (r === c.exp) { pass++; lines.push('OK  ' + c.v + ' -> ' + r); }
    else { fail++; lines.push('FAIL ' + c.v + ' -> ' + r + ' 预期:' + c.exp); }
  });
  lines.push('结果：' + pass + '/' + cases.length + ' 通过，' + fail + ' 失败');
  var txt = lines.join('\n');
  Logger.log(txt);
  SpreadsheetApp.getUi().alert(txt);
}

/* 2) 随机挑1个产品跑 URL 核验 */
function smoke_verifyOne() {
  var list = smoke_getRealProducts_(20);
  if (!list.length) { SpreadsheetApp.getUi().alert('Products 表中暂无可用产品（已过滤 merged/brand/quarantined）'); return; }
  var p = list[Math.floor(Math.random() * list.length)];
  Logger.log('=== 2) 单个产品 URL 核验 ===');
  Logger.log('目标：' + p.product_id + ' | ' + p.brand + ' | ' + p.canonical_name + ' | status:' + p.status + ' | url:' + (p.official_url||''));
  try {
    var fresh = readTable('Products').find(function(x){ return String(x.product_id) === String(p.product_id); }) || p;
    var out = verifyProductUrl_(fresh);
    Logger.log('outcome: ' + JSON.stringify(out));
    if (out.status === 'verified') {
      updateProductUrlFields_(p.product_id, { official_url: out.url, official_url_status: 'verified', official_url_checked_at: out.checked_at, official_url_notes: out.notes||'' });
      try {
        var sh = sheet_('Products'), vals = sh.getDataRange().getValues(), h = vals[0].map(function(x){return String(x);}), ix={}; for(var i=0;i<h.length;i++){ix[h[i]]=i;}
        for(var r=1;r<vals.length;r++){ if(String(vals[r][ix.product_id])===String(p.product_id)){ if(String(vals[r][ix.status]).toLowerCase()==='quarantined') sh.getRange(r+1,ix.status+1).setValue('active'); break; }}
      } catch(e){}
      SpreadsheetApp.getUi().alert('核验通过\n' + out.url);
    } else if (out.status === 'check_failed') {
      updateProductUrlFields_(p.product_id, { official_url: String(fresh.official_url||'').trim(), official_url_status: 'check_failed', official_url_checked_at: out.checked_at, official_url_notes: out.notes||'' });
      SpreadsheetApp.getUi().alert('暂时失败（check_failed）\n保留原URL，不隔离');
    } else if (out.status === 'not_found' || out.status === 'mismatch') {
      updateProductUrlFields_(p.product_id, { official_url: '', official_url_status: out.status, official_url_checked_at: out.checked_at, official_url_notes: out.notes||'' });
      try {
        var sh2 = sheet_('Products'), vals2 = sh2.getDataRange().getValues(), h2 = vals2[0].map(function(x){return String(x);}), ix2={}; for(var i2=0;i2<h2.length;i2++){ix2[h2[i2]]=i2;}
        for(var r2=1;r2<vals2.length;r2++){ if(String(vals2[r2][ix2.product_id])===String(p.product_id)){ var st2=String(vals2[r2][ix2.status]).toLowerCase(); if(st2!=='merged'&&st2!=='brand'){ sh2.getRange(r2+1,ix2.status+1).setValue('quarantined'); } break; }}
      } catch(e2){}
      try { enqueuePending_('product_quarantined_url_invalid', {product_id:p.product_id,canonical_name:p.canonical_name,brand:p.brand,url_status:out.status,reason:out.notes||''}, '冒烟测试：隔离而非删除'); } catch(e3){}
      SpreadsheetApp.getUi().alert('未找到匹配详情页 -> 已隔离（quarantined）\n未执行级联删除');
    }
  } catch(e) {
    Logger.log('ERR: ' + e);
    SpreadsheetApp.getUi().alert('异常：' + e);
  }
  clearCache();
}

/* 3) 批量核验 */
function smoke_verifyBatch() {
  Logger.log('=== 3) 批量核验（limit=5, quarantineOnly=true, deleteInvalid=false） ===');
  try {
    var res = verifyProductUrls_({ limit: 5, force: false, deleteInvalid: false, quarantineOnly: true });
    Logger.log(JSON.stringify(res, null, 2));
    SpreadsheetApp.getUi().alert('批量结果\nchecked:' + res.checked + '\nverified:' + res.verified + '\nretained_for_retry:' + res.retained_for_retry + '\nquarantined:' + res.quarantined + '\ndeleted:' + res.deleted.length + '\n（deleted 应为 0）');
  } catch(e) {
    Logger.log('ERR: ' + e);
    SpreadsheetApp.getUi().alert('异常：' + e);
  }
  clearCache();
}

/* 4) 耳机规格提取 */
function smoke_extractHeadset() {
  Logger.log('=== 4) 耳机规格提取 ===');
  if (!PropertiesService.getScriptProperties().getProperty('CRAWL4AI_API_KEY')) {
    SpreadsheetApp.getUi().alert('缺少 Script Property: CRAWL4AI_API_KEY'); return;
  }
  var prods = readTable('Products').filter(function(p){
    var st = String(p.status||'').toLowerCase();
    if (st==='merged'||st==='brand'||st==='quarantined') return false;
    var name = String(p.canonical_name||'').toLowerCase();
    var cat = String(p.category||'').toLowerCase();
    return cat.indexOf('headset')>=0 || cat.indexOf('headphone')>=0 || name.indexOf('cloud')>=0 || name.indexOf('zone')>=0 || name.indexOf('h390')>=0;
  });
  if (!prods.length) {
    SpreadsheetApp.getUi().alert('未找到合适的耳机产品。\n可去 Products 表找一条耳机类产品手动测试。');
    return;
  }
  var t = prods[0];
  Logger.log('目标：' + t.product_id + ' | ' + t.brand + ' ' + t.canonical_name);
  try {
    var url = resolveOfficialUrl_(t);
    Logger.log('URL: ' + url);
    var parsed = extractOfficialSpecs_(String(t.brand||'') + ' ' + String(t.canonical_name||''), url);
    var specs = parsed.specs || [];
    Logger.log('提取数量：' + specs.length);
    var keys = {};
    specs.forEach(function(s){ keys[s.spec_key] = 1; Logger.log('  ' + s.spec_key + ' = ' + s.value + (s.unit?' '+s.unit:'') + ' | raw:' + (s.raw_value||'').slice(0,80)); });
    var saved = saveOfficialSpecs_(t, url, parsed, 'crawl4ai_smoke');
    Logger.log('写入：' + saved.count);
    var need = ['battery_life_listening_hours','battery_life_talk_hours','frequency_response_mic','sensitivity_db','driver','bluetooth_version'];
    var hit = need.filter(function(k){ return keys[k]; });
    SpreadsheetApp.getUi().alert('耳机提取完成\n提取:' + specs.length + ' 写入:' + saved.count + '\n命中关键字段:' + hit.join(', ') + (hit.length<need.length?'\n（部分字段可能随官网结构不同）':''));
  } catch(e) {
    Logger.log('ERR: ' + e);
    SpreadsheetApp.getUi().alert('异常：' + e);
  }
  clearCache();
}

/* 5) 隔离产品不入队 */
function smoke_quarantineBlocksTask() {
  var qs = readTable('Products').filter(function(p){ return String(p.status||'').toLowerCase() === 'quarantined'; });
  if (!qs.length) { SpreadsheetApp.getUi().alert('当前无 quarantined 产品\n可先跑测试2或3产生隔离产品再测'); return; }
  var p = qs[0];
  Logger.log('=== 5) 隔离产品不入队 ===');
  Logger.log('隔离产品：' + p.product_id + ' ' + p.canonical_name);
  var id = enqueueSpecificationTask_(p.product_id, 'smoke_test', 1);
  if (id === null) { Logger.log('结果：返回 null -> 正确'); SpreadsheetApp.getUi().alert('✅ 正确：隔离产品不会进入规格采集队列'); }
  else { Logger.log('结果：返回 ' + id + ' -> 错误'); SpreadsheetApp.getUi().alert('❌ 错误：隔离产品意外入队'); }
}

/* 6) 状态报告 */
function smoke_reportStatus() {
  var prods = readTable('Products');
  var q = prods.filter(function(p){ return String(p.status||'').toLowerCase()==='quarantined'; }).length;
  var v = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='verified'; }).length;
  var cf = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='check_failed'; }).length;
  var nf = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='not_found'; }).length;
  var mm = prods.filter(function(p){ return String(p.official_url_status||'').toLowerCase()==='mismatch'; }).length;
  var pend = [];
  try { pend = readTable('PendingQueue').filter(function(r){ return String(r.item_type||'').indexOf('quarantined')>=0; }); } catch(e){}
  var txt = ['=== 6) 状态报告 ===','quarantined(Products.status): ' + q,'verified: ' + v,'check_failed: ' + cf,'not_found: ' + nf,'mismatch: ' + mm,'PendingQueue(quarantined相关): ' + pend.length].join('\n');
  Logger.log(txt); SpreadsheetApp.getUi().alert(txt);
}

function smoke_all() {
  smoke_productEntity();
  Utilities.sleep(800);
  smoke_verifyBatch();
  Utilities.sleep(1500);
  smoke_reportStatus();
  Utilities.sleep(800);
  smoke_quarantineBlocksTask();
  SpreadsheetApp.getUi().alert('冒烟测试完成\n详情见 扩展程序 > Apps Script > 执行日志');
}
