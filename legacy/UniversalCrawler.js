/**
 * MouseSpecsPipeline.gs
 * 游戏鼠标规格抓取流水线 V1
 *
 * 流程：
 *   1. 从 Product 表读取 category = 'mouse' 的产品
 *   2. 调用 Crawl4AI Cloud /extract，一次性完成「产品页验证 + 规格提取」
 *   3. 清洗数值/布尔字段
 *   4. Upsert 到 Mouse_Specs 表（含 verification_status / source_url / last_fetched_at）
 *
 * 依赖 Script Properties:
 *   CRAWL4AI_API_KEY
 *
 * Sheet 结构（表头必须一致，首次运行会自动补表头）：
 *   Product:    id | name | category | url
 *   Mouse_Specs: product_id, sensor_name, dpi_min, dpi_max, max_speed_ips,
 *     max_acceleration_g, max_polling_rate_hz, connection_type,
 *     wireless_technology, wired_connection, bluetooth_support, button_count,
 *     switch_type, switch_lifecycle, switch_lifecycle_unit, weight_g,
 *     length_mm, width_mm, height_mm, battery_life_hours, battery_life_conditions,
 *     onboard_memory, software_requirement, source_url, last_fetched_at,
 *     verification_status
 */

const C4AI_BASE = 'https://api.crawl4ai.com';

const SHEET_PRODUCT = 'Product';
const SHEET_MOUSE = 'Mouse_Specs';

// Product 表列（0-based）
const PRODUCT_COL = { id: 0, name: 1, category: 2, url: 3 };

// 每次执行最多处理多少个产品（Apps Script 单次运行上限 6 分钟，
// 一个产品约 10~60 秒，超出的下次运行继续）
const MAX_PRODUCTS_PER_RUN = 10;

// 产品之间的间隔，避免触发免费版限流（10 req/min）
const SLEEP_BETWEEN_PRODUCTS_MS = 2000;

// 数值列，写入前会做清洗
const NUMERIC_FIELDS = {
  int: ['dpi_min', 'dpi_max', 'max_speed_ips', 'max_acceleration_g',
        'max_polling_rate_hz', 'button_count', 'switch_lifecycle',
        'battery_life_hours'],
  float: ['weight_g', 'length_mm', 'width_mm', 'height_mm']
};
const BOOL_FIELDS = ['wired_connection', 'bluetooth_support', 'onboard_memory'];


/* ===================== 主入口 ===================== */

/**
 * 主入口：处理 Product 表中所有 mouse 产品。
 * 在 Apps Script 中运行 runMouseSpecsPipeline。
 */
function runMouseSpecsPipeline() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const productSheet = ss.getSheetByName(SHEET_PRODUCT);
  const specsSheet = ensureSheetWithHeaders_(ss, SHEET_MOUSE, MOUSE_SPECS_HEADERS);

  const products = readMouseProducts_(productSheet);
  Logger.log('待处理 mouse 产品数: ' + products.length);

  const existingIds = getExistingProductIds_(specsSheet);

  let processed = 0;
  for (const p of products) {
    if (processed >= MAX_PRODUCTS_PER_RUN) {
      Logger.log('已达本次上限 ' + MAX_PRODUCTS_PER_RUN + '，剩余产品下次运行继续');
      break;
    }
    // 已验证过的跳过（需要重抓时删掉 Mouse_Specs 对应行即可）
    if (existingIds[p.id] === 'verified') {
      Logger.log('跳过（已验证）: ' + p.name);
      continue;
    }

    Logger.log('处理: ' + p.name + ' -> ' + p.url);
    const row = buildSpecsRow_(p);
    upsertSpecsRow_(specsSheet, row);
    processed++;

    Utilities.sleep(SLEEP_BETWEEN_PRODUCTS_MS);
  }

  Logger.log('本次完成: ' + processed + ' 个产品');
}


/* ===================== 数据读取 ===================== */

function readMouseProducts_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();

  return data
    .filter(r => String(r[PRODUCT_COL.category]).toLowerCase() === 'mouse')
    .map(r => ({
      id: r[PRODUCT_COL.id],
      name: String(r[PRODUCT_COL.name]).trim(),
      url: String(r[PRODUCT_COL.url]).trim()
    }))
    .filter(p => p.id && p.name && p.url);
}


function getExistingProductIds_(sheet) {
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const statuses = sheet.getRange(2, MOUSE_SPECS_HEADERS.indexOf('verification_status') + 1,
                                  lastRow - 1, 1).getValues();

  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] !== '') map[ids[i][0]] = statuses[i][0];
  }
  return map;
}


function ensureSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* ===================== 核心：验证 + 提取（一次调用） ===================== */

function buildSpecsRow_(product) {
  const row = {};
  MOUSE_SPECS_HEADERS.forEach(h => row[h] = null);
  row.product_id = product.id;
  row.source_url = product.url;
  row.last_fetched_at = new Date().toISOString();

  let extracted;
  try {
    extracted = callC4Extract_(product.url, product.name);
  } catch (e) {
    row.verification_status = 'extraction_failed';
    Logger.log('  提取失败: ' + e.message);
    return row;
  }

  // 第一步验证：LLM 判断页面是否是该产品
  if (extracted.page_match === false) {
    row.verification_status = 'name_mismatch';
    Logger.log('  页面与产品名不匹配，需人工核对 URL');
    return row;
  }

  row.verification_status = 'verified';

  // 字段清洗后写入
  for (const h of MOUSE_SPECS_HEADERS) {
    if (h in extracted && extracted[h] !== undefined) {
      row[h] = extracted[h];
    }
  }
  // DPI 范围兜底："100-32000" 拆成 min/max
  if (row.dpi_min == null && typeof extracted.dpi_range === 'string') {
    const m = extracted.dpi_range.match(/(\d[\d,]*)\s*[-–~]\s*(\d[\d,]*)/);
    if (m) { row.dpi_min = m[1]; row.dpi_max = m[2]; }
  }

  NUMERIC_FIELDS.int.forEach(f => row[f] = toInt_(row[f]));
  NUMERIC_FIELDS.float.forEach(f => row[f] = toFloat_(row[f]));
  BOOL_FIELDS.forEach(f => row[f] = toBool_(row[f]));

  return row;
}


/**
 * 调用 Crawl4AI Cloud /extract。
 * instruction 负责"验证 + 提取规则"，schema 保证输出结构可预测。
 * 官方要求超时 120s；Apps Script 上限约 50s，故对 busy/5xx 重试。
 */
function callC4Extract_(url, productName) {
  const apiKey = PropertiesService.getScriptProperties()
    .getProperty('CRAWL4AI_API_KEY');
  if (!apiKey) throw new Error('缺少 Script Property: CRAWL4AI_API_KEY');

  const body = {
    url: url,
    instruction:
      'First verify: does this page show the gaming mouse "' + productName +
      '"? Set page_match=false if it is a different model, a homepage, a listing page, or ' +
      'an accessory page. If page_match is true, extract ONLY this product\'s specs from the ' +
      'specifications/tech-specs section (ignore marketing copy, comparison tables, and ' +
      'recommended products). Never invent values; use null for anything not found on the page. ' +
      'Strip units from numbers ("32,000 DPI" -> 32000, "54 g" -> 54).',
    schema: {
      type: 'object',
      properties: {
        page_match:             { type: 'boolean' },
        dpi_range:              { type: 'string',
          description: 'DPI range as shown, e.g. "100 - 32000", if not split' },
        sensor_name:            { type: ['string', 'null'] },
        dpi_min:                { type: ['integer', 'null'] },
        dpi_max:                { type: ['integer', 'null'] },
        max_speed_ips:          { type: ['integer', 'null'] },
        max_acceleration_g:     { type: ['integer', 'null'] },
        max_polling_rate_hz:    { type: ['integer', 'null'] },
        connection_type:        { type: ['string', 'null'],
          description: 'wired | wireless | both' },
        wireless_technology:    { type: ['string', 'null'],
          description: 'e.g. LIGHTSPEED, HyperSpeed; null for wired mice' },
        wired_connection:       { type: ['boolean', 'null'] },
        bluetooth_support:      { type: ['boolean', 'null'] },
        button_count:           { type: ['integer', 'null'] },
        switch_type:            { type: ['string', 'null'] },
        switch_lifecycle:       { type: ['integer', 'null'],
          description: 'e.g. 90 for 90 million clicks' },
        switch_lifecycle_unit:  { type: ['string', 'null'],
          description: 'e.g. "million clicks"' },
        weight_g:               { type: ['number', 'null'] },
        length_mm:              { type: ['number', 'null'] },
        width_mm:               { type: ['number', 'null'] },
        height_mm:              { type: ['number', 'null'] },
        battery_life_hours:     { type: ['integer', 'null'] },
        battery_life_conditions:{ type: ['string', 'null'] },
        onboard_memory:         { type: ['boolean', 'null'] },
        software_requirement:   { type: ['string', 'null'],
          description: 'e.g. G HUB, Razer Synapse' }
      },
      required: ['page_match']
    }
  };

  const MAX_RETRY = 3;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    let response;
    try {
      response = UrlFetchApp.fetch(C4AI_BASE + '/extract', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + apiKey },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
        timeout: 45000            // Apps Script 上限约 50s，设 45s 留余量
      });
    } catch (e) {
      // 超时/网络错误：浏览器渲染页可能超过 45s，重试
      if (attempt < MAX_RETRY) { Utilities.sleep(5000 * attempt); continue; }
      throw new Error('请求超时或网络错误（已重试 ' + MAX_RETRY + ' 次）: ' + e.message);
    }

    const status = response.getResponseCode();
    const text = response.getContentText();

    if (status >= 200 && status < 300) {
      logBalance_(response);
      return findExtracted_(JSON.parse(text));
    }

    if (status === 402) {
      throw new Error('余额不足: ' + text.substring(0, 300));
    }
    // 503 busy / 5xx 不计费，可安全重试
    if (attempt < MAX_RETRY && (status === 503 || status >= 500)) {
      Utilities.sleep(5000 * attempt);
      continue;
    }
    throw new Error('Crawl4AI HTTP ' + status + ': ' + text.substring(0, 300));
  }
}


/** 兼容 /extract 可能返回的几种结构 */
function findExtracted_(payload) {
  const candidates = [
    payload && payload.result,
    payload && payload.extracted,
    payload && payload.extracted_content,
    payload && payload.data,
    payload
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string') {
      try { return JSON.parse(c); } catch (e) { continue; }
    }
    if (typeof c === 'object') {
      // 数组则取第一个（schema 为 object 时不应出现，防御而已）
      if (Array.isArray(c)) return c[0];
      if ('page_match' in c || 'sensor_name' in c) return c;
    }
  }

  throw new Error('无法在 /extract 响应中找到提取结果: ' +
                  JSON.stringify(payload).substring(0, 300));
}


/* ===================== 字段清洗 ===================== */

function toInt_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : Math.round(n);
}

function toFloat_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

function toBool_(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', '1', '支持', '有'].indexOf(s) >= 0) return true;
  if (['false', 'no', '0', '不支持', '无'].indexOf(s) >= 0) return false;
  return null;
}


/* ===================== 写入 ===================== */

function upsertSpecsRow_(sheet, row) {
  const colIndex = {};
  MOUSE_SPECS_HEADERS.forEach((h, i) => colIndex[h] = i + 1);

  const lastRow = sheet.getLastRow();
  let targetRow = -1;

  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(row.product_id)) {
        targetRow = i + 2;
        break;
      }
    }
  }

  if (targetRow > 0) {
    // 更新整行，避免旧数据残留
    const values = MOUSE_SPECS_HEADERS.map(h => row[h] === null ? '' : row[h]);
    sheet.getRange(targetRow, 1, 1, MOUSE_SPECS_HEADERS.length)
         .setValues([values]);
    Logger.log('  已更新 Mouse_Specs 第 ' + targetRow + ' 行 (' +
               row.verification_status + ')');
  } else {
    const values = MOUSE_SPECS_HEADERS.map(h => row[h] === null ? '' : row[h]);
    sheet.appendRow(values);
    Logger.log('  已新增一行 (' + row.verification_status + ')');
  }
}


function logBalance_(response) {
  try {
    const headers = response.getHeaders();
    const balance = headers['x-c4-balance'];
    if (balance) Logger.log('  剩余 credits: ' + balance);
  } catch (e) { /* 忽略 */ }
}