/* ============================================================
 * TrendAnalysis.js — 讨论趋势折线图（产品 / 话题）
 * ============================================================ */

function getIssueOrderMap_() {
  var issues = readTable('Issues') || [];
  var map = {};
  issues.forEach(function(it, idx) {
    var key = String(it.issue_no || '').trim();
    if (!key) return;
    map[key] = {
      issue_no: key,
      date: it.date || '',
      order: idx + 1
    };
  });
  return map;
}

function getDocIssueMap_() {
  var docs = readTable('Documents') || [];
  var map = {};
  docs.forEach(function(d) {
    var did = String(d.doc_id || '').trim();
    if (!did) return;
    map[did] = String(d.issue_no || '').trim();
  });
  return map;
}

function getProductTrendData_(productId) {
  productId = String(productId || '').trim();
  if (!productId) throw new Error('缺少 product_id');

  var feedback = readTable('Feedback') || [];
  var docToIssue = getDocIssueMap_();
  var issueMap = getIssueOrderMap_();

  var counter = {};
  feedback.forEach(function(f) {
    if (String(f.product_id || '').trim() !== productId) return;
    var issueNo = docToIssue[String(f.doc_id || '').trim()] || '';
    if (!issueNo) return;
    counter[issueNo] = (counter[issueNo] || 0) + 1;
  });

  var rows = Object.keys(counter).map(function(issueNo) {
    var im = issueMap[issueNo] || { issue_no: issueNo, date: '', order: 9999 };
    return {
      issue_no: issueNo,
      date: im.date || '',
      order: im.order,
      count: counter[issueNo]
    };
  });

  rows.sort(function(a,b){ return a.order - b.order; });

  var result = [];
  for (var i = 0; i < rows.length; i++) {
    var cur = rows[i];
    var prev = i > 0 ? rows[i-1] : null;
    var delta = prev ? (cur.count - prev.count) : 0;
    var pct = 0;
    if (prev && prev.count > 0) {
      pct = ((cur.count - prev.count) / prev.count * 100);
    } else if (prev && prev.count === 0 && cur.count > 0) {
      pct = 100;
    }
    result.push({
      issue_no: cur.issue_no,
      date: cur.date,
      count: cur.count,
      delta: delta,
      pct: Math.round(pct * 10) / 10,
      trend: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    });
  }
  return result;
}

function getTopicTrendData_(topicId) {
  topicId = String(topicId || '').trim();
  if (!topicId) throw new Error('缺少 topic_id');

  var feedback = readTable('Feedback') || [];
  var docToIssue = getDocIssueMap_();
  var issueMap = getIssueOrderMap_();

  var counter = {};
  feedback.forEach(function(f) {
    if (String(f.topic_id || '').trim() !== topicId) return;
    var issueNo = docToIssue[String(f.doc_id || '').trim()] || '';
    if (!issueNo) return;
    counter[issueNo] = (counter[issueNo] || 0) + 1;
  });

  var rows = Object.keys(counter).map(function(issueNo) {
    var im = issueMap[issueNo] || { issue_no: issueNo, date: '', order: 9999 };
    return {
      issue_no: issueNo,
      date: im.date || '',
      order: im.order,
      count: counter[issueNo]
    };
  });

  rows.sort(function(a,b){ return a.order - b.order; });

  var result = [];
  for (var i = 0; i < rows.length; i++) {
    var cur = rows[i];
    var prev = i > 0 ? rows[i-1] : null;
    var delta = prev ? (cur.count - prev.count) : 0;
    var pct = 0;
    if (prev && prev.count > 0) {
      pct = ((cur.count - prev.count) / prev.count * 100);
    } else if (prev && prev.count === 0 && cur.count > 0) {
      pct = 100;
    }
    result.push({
      issue_no: cur.issue_no,
      date: cur.date,
      count: cur.count,
      delta: delta,
      pct: Math.round(pct * 10) / 10,
      trend: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    });
  }
  return result;
}

function createProductTrendChart(productId) {
  var prodList = readTable('Products') || [];
  var prod = prodList.find(function(p){ return String(p.product_id||'').trim() === String(productId||'').trim(); });
  if (!prod) throw new Error('未找到产品: ' + productId);

  var data = getProductTrendData_(productId);
  if (!data.length) throw new Error('该产品暂无各期讨论记录');

  var ss = ss_();
  var sheetName = '趋势_产品_' + String(productId).replace(/[^A-Za-z0-9_-]/g, '_');
  var sh = ss.getSheetByName(sheetName);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(sheetName);

  sh.getRange(1,1,1,6).setValues([['期号', '日期', '讨论数', '较上期', '涨跌幅(%)', '趋势']]);
  var out = [];
  data.forEach(function(d){
    out.push([d.issue_no, d.date, d.count, d.delta, d.pct, d.trend]);
  });
  if (out.length) sh.getRange(2,1,out.length,6).setValues(out);

  var chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(1,1,out.length+1,3))
    .setPosition(2, 8, 0, 0)
    .setOption('title', prod.canonical_name + ' 讨论趋势')
    .setOption('curveType', 'function')
    .setOption('legend', { position: 'bottom' })
    .setOption('hAxis', { title: '期号' })
    .setOption('vAxis', { title: '讨论数' })
    .build();
  sh.insertChart(chart);
  sh.autoResizeColumns(1,6);
  ss.setActiveSheet(sh);
  SpreadsheetApp.getActive().toast('已生成 ' + sheetName, '趋势分析', 4);
}

function createTopicTrendChart(topicId) {
  var topics = readTable('Topics') || [];
  var t = topics.find(function(x){ return String(x.topic_id||'').trim() === String(topicId||'').trim(); });
  if (!t) throw new Error('未找到话题: ' + topicId);

  var data = getTopicTrendData_(topicId);
  if (!data.length) throw new Error('该话题暂无各期讨论记录');

  var ss = ss_();
  var sheetName = '趋势_话题_' + String(topicId).replace(/[^A-Za-z0-9_-]/g, '_');
  var sh = ss.getSheetByName(sheetName);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(sheetName);

  sh.getRange(1,1,1,6).setValues([['期号', '日期', '讨论数', '较上期', '涨跌幅(%)', '趋势']]);
  var out = [];
  data.forEach(function(d){
    out.push([d.issue_no, d.date, d.count, d.delta, d.pct, d.trend]);
  });
  if (out.length) sh.getRange(2,1,out.length,6).setValues(out);

  var chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(1,1,out.length+1,3))
    .setPosition(2, 8, 0, 0)
    .setOption('title', '话题【' + t.name + '】讨论趋势')
    .setOption('curveType', 'function')
    .setOption('legend', { position: 'bottom' })
    .setOption('hAxis', { title: '期号' })
    .setOption('vAxis', { title: '讨论数' })
    .build();
  sh.insertChart(chart);
  sh.autoResizeColumns(1,6);
  ss.setActiveSheet(sh);
  SpreadsheetApp.getActive().toast('已生成 ' + sheetName, '趋势分析', 4);
}

/* 菜单统一由 Menu.js 的 addTrendMenu() 创建，避免重复定义互相覆盖。 */

function promptTrendProduct() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('产品讨论趋势', '请输入 product_id', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.ButtonSet.OK) return;
  var pid = resp.getResponseText().trim();
  if (!pid) return;
  try { createProductTrendChart(pid); } catch(e) { ui.alert('生成失败：' + e); }
}

function promptTrendTopic() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('话题讨论趋势', '请输入 topic_id', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.ButtonSet.OK) return;
  var tid = resp.getResponseText().trim();
  if (!tid) return;
  try { createTopicTrendChart(tid); } catch(e) { ui.alert('生成失败：' + e); }
}
