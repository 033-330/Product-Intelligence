
/**
 * SpecAITest.gs
 *
 * 独立测试：
 * 1. 通过 OpenRouter web_fetch / web_search 读取官方产品页面
 * 2. 使用英文 Prompt 提取鼠标规格
 * 3. 将规格映射到既有 Mouse_Specs 26 字段
 * 4. 校验 JSON 和证据
 * 5. 写入独立工作表 Spec_AI_Test_Results
 *
 * 不修改 Newsletter Pipeline。
 * 不修改现有 callOpenRouter()。
 * 不写入正式 Mouse_Specs 表。
 *
 * Script Properties:
 * OPENROUTER_API_KEY
 */

// ============================================================
// 1. Configuration
// ============================================================

var SPEC_TEST_CONFIG = {
  model: 'minimax/minimax-m3.1-flash:free',
  spreadsheetId: '', // 留空：使用当前绑定的 Spreadsheet
  resultSheetName: 'Spec_AI_Test_Results',
  maxTokens: 6000,
  maxToolCalls: 8
};

// 与现有 Mouse_Specs 表保持一致。
// product_id + 以下 25 列 = 26 列。
var SPEC_MOUSE_FIELDS = [
  'product_id',
  'sensor_name',
  'dpi_min',
  'dpi_max',
  'max_speed_ips',
  'max_acceleration_g',
  'max_polling_rate_hz',
  'connection_type',
  'wireless_technology',
  'wired_connection',
  'bluetooth_support',
  'button_count',
  'switch_type',
  'switch_lifecycle',
  'switch_lifecycle_unit',
  'weight_g',
  'length_mm',
  'width_mm',
  'height_mm',
  'battery_life_hours',
  'battery_life_conditions',
  'onboard_memory',
  'software_requirement',
  'source_url',
  'last_fetched_at',
  'verification_status'
];

var SPEC_TEST_PRODUCTS = [
  {
    product_id: 'TEST-LOGITECH-001',
    product_name: 'Logitech G PRO X SUPERLIGHT 2',
    brand: 'Logitech',
    official_url:
      'https://www.logitechg.com/en-us/products/gaming-mice/pro-x2-superlight-wireless-mouse.html'
  },
  {
    product_id: 'TEST-RAZER-001',
    product_name: 'Razer Viper V3 Pro',
    brand: 'Razer',
    official_url:
      'https://www.razer.com/gaming-mice/razer-viper-v3-pro'
  },
  {
    product_id: 'TEST-ENDGAME-001',
    product_name: 'Endgame Gear OP1 8k',
    brand: 'Endgame Gear',
    official_url:
      'https://www.endgamegear.com/en-us/gaming-mice/op1-8k'
  }
];

// 规格字段：不包含产品 ID 和管理字段。
var SPEC_VALUE_FIELDS = SPEC_MOUSE_FIELDS.filter(function(field) {
  return [
    'product_id',
    'source_url',
    'last_fetched_at',
    'verification_status'
  ].indexOf(field) === -1;
});


// ============================================================
// 2. Main test functions
// ============================================================

/**
 * 运行三个产品的完整测试。
 *
 * 每个产品独立调用一次 OpenRouter。
 * 结果写入独立测试表。
 */
function testAllMouseSpecifications() {
  var sheet = getSpecTestSheet_();
  var summary = [];

  SPEC_TEST_PRODUCTS.forEach(function(product, index) {
    console.log(
      '=================================================='
    );
    console.log(
      'Testing ' + (index + 1) + '/' +
      SPEC_TEST_PRODUCTS.length + ': ' + product.product_name
    );

    var result;

    try {
      result = extractMouseSpecifications_(product);
    } catch (error) {
      result = {
        product: product,
        success: false,
        error: String(error && error.message || error),
        parsed: null,
        model: SPEC_TEST_CONFIG.model,
        usage: {},
        responseId: '',
        fetchedAt: new Date()
      };

      console.error(
        'Product test failed: ' + product.product_name +
        ' | ' + result.error
      );
    }

    appendSpecTestResult_(sheet, result);

    summary.push({
      product_id: product.product_id,
      product_name: product.product_name,
      success: result.success,
      verification_status:
        result.parsed
          ? result.parsed.verification_status
          : 'failed',
      error: result.error || ''
    });
  });

  console.log('========== TEST SUMMARY ==========');
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    'Results sheet: ' + SPEC_TEST_CONFIG.resultSheetName
  );

  return summary;
}


/**
 * 单独测试 Logitech。
 */
function testMouseSpecLogitech() {
  return testSingleMouseSpecification_(
    SPEC_TEST_PRODUCTS[0]
  );
}


/**
 * 单独测试 Razer。
 */
function testMouseSpecRazer() {
  return testSingleMouseSpecification_(
    SPEC_TEST_PRODUCTS[1]
  );
}


/**
 * 单独测试 Endgame Gear。
 */
function testMouseSpecEndgame() {
  return testSingleMouseSpecification_(
    SPEC_TEST_PRODUCTS[2]
  );
}


/**
 * 只测试一个产品，便于排错。
 */
function testSingleMouseSpecification_(product) {
  var sheet = getSpecTestSheet_();
  var result;

  try {
    result = extractMouseSpecifications_(product);
  } catch (error) {
    result = {
      product: product,
      success: false,
      error: String(error && error.message || error),
      parsed: null,
      model: SPEC_TEST_CONFIG.model,
      usage: {},
      responseId: '',
      fetchedAt: new Date()
    };
  }

  appendSpecTestResult_(sheet, result);

  console.log(JSON.stringify({
    product_id: product.product_id,
    success: result.success,
    error: result.error || '',
    parsed: result.parsed || null,
    model: result.model,
    usage: result.usage
  }, null, 2));

  return result;
}


// ============================================================
// 3. English extraction prompt
// ============================================================

function buildMouseSpecPrompt_(product) {
  var schema = {
    product_id: product.product_id,
    product_name: null,
    brand: product.brand,
    official_url: product.official_url,
    page_access_status: 'success',

    sensor_name: null,
    dpi_min: null,
    dpi_max: null,
    max_speed_ips: null,
    max_acceleration_g: null,
    max_polling_rate_hz: null,
    connection_type: null,
    wireless_technology: null,
    wired_connection: null,
    bluetooth_support: null,
    button_count: null,
    switch_type: null,
    switch_lifecycle: null,
    switch_lifecycle_unit: null,
    weight_g: null,
    length_mm: null,
    width_mm: null,
    height_mm: null,
    battery_life_hours: null,
    battery_life_conditions: null,
    onboard_memory: null,
    software_requirement: null,

    source_url: null,
    last_fetched_at: null,
    verification_status: 'unverified',
    field_evidence: {},
    limitations: []
  };

  return [
    'You are a product specification extraction agent.',
    '',
    'TASK',
    'Read the official product webpage and extract the mouse specifications.',
    'Use the available web tools to access the actual webpage.',
    'Do not answer from memory alone.',
    '',
    'PRODUCT',
    JSON.stringify(product, null, 2),
    '',
    'WEB ACCESS',
    '1. First, use the web fetch tool on the supplied official URL.',
    '2. If the page cannot be read or does not contain enough information,',
    '   use web search to find relevant official documentation for the',
    '   exact same product model.',
    '3. Never claim to have accessed a page unless the tool actually',
    '   returned its content.',
    '4. Prefer official brand websites and official support documentation.',
    '5. Do not use specifications from other product generations or variants.',
    '',
    'SEMANTIC SPECIFICATION MATCHING',
    'Official websites may use labels that differ from the target field names.',
    'Identify equivalent specifications by technical meaning, context, and units,',
    'not by exact string matching.',
    '',
    'Examples:',
    '- Tracking speed / maximum tracking speed -> max_speed_ips',
    '- Acceleration / maximum acceleration -> max_acceleration_g',
    '- Polling rate / report rate / 8 kHz -> max_polling_rate_hz',
    '- CPI / sensor resolution -> dpi_min and dpi_max when the context',
    '  clearly identifies the supported sensor sensitivity range',
    '- Weight without cable / mouse weight -> weight_g when the value',
    '  refers to the mouse body',
    '- Product dimensions / length x width x height -> dimension fields',
    '- Rated click durability / switch lifespan -> switch_lifecycle',
    '- Onboard profile storage -> onboard_memory',
    '- 2.4 GHz wireless / proprietary wireless / Bluetooth / wired USB',
    '  -> the corresponding connectivity fields',
    '',
    'These examples are not exhaustive. Recognize other semantically',
    'equivalent labels, abbreviations, technical descriptions, and units.',
    'Do not infer a value merely because the field sounds related.',
    '',
    'NORMALIZATION',
    '- Weight: grams (g).',
    '- Dimensions: millimeters (mm).',
    '- Tracking speed: inches per second (IPS).',
    '- Acceleration: g.',
    '- Polling rate: hertz (Hz).',
    '- Battery life: hours.',
    '- Convert units only when the conversion is unambiguous.',
    '- Preserve relevant operating conditions.',
    '- Distinguish maximum supported values from default values.',
    '- Do not assume proprietary wireless technology means Bluetooth.',
    '- Do not infer switch lifespan from switch type.',
    '- Do not estimate specifications from images.',
    '',
    'MISSING OR UNCERTAIN DATA',
    '- Use JSON null when a value cannot be established reliably.',
    '- Never invent specifications, source URLs, quotes, or timestamps.',
    '- Use only sources that actually support the corresponding values.',
    '- A product page may be accessible while some specifications remain missing.',
    '',
    'OUTPUT FIELDS',
    JSON.stringify(SPEC_MOUSE_FIELDS, null, 2),
    '',
    'OUTPUT FORMAT',
    'Return exactly one valid JSON object, not an array.',
    'Include every field in the schema below.',
    'Use JSON numbers for numeric specifications.',
    'Use true, false, or null for Boolean fields.',
    'Use null for missing values.',
    '',
    'For field_evidence, provide one entry for every specification field:',
    JSON.stringify(SPEC_VALUE_FIELDS, null, 2),
    '',
    'Each field_evidence entry must have this structure:',
    JSON.stringify({
      original_label: 'Original label from the source, or null',
      original_value: 'Original value and unit, or null',
      normalized_value: 'Normalized value, or null',
      source_url: 'Actual supporting source URL, or null',
      evidence_quote: 'Short genuine excerpt, or null',
      status: 'verified, missing, or unverified'
    }, null, 2),
    '',
    'Evidence rules:',
    '- verified: supported by actual retrieved official source content.',
    '- missing: checked available sources but no value was found.',
    '- unverified: candidate value exists but cannot be reliably confirmed.',
    '- Do not fabricate quotations.',
    '- A non-null specification must have corresponding evidence.',
    '',
    'Set page_access_status to exactly one of:',
    'success, failed, insufficient_content.',
    '',
    'Set verification_status to exactly one of:',
    'verified, partial, unverified, failed.',
    'This is your preliminary assessment; the test code will validate it.',
    '',
    'Use the following JSON structure and preserve all field names:',
    JSON.stringify(schema, null, 2),
    '',
    'FINAL RULE',
    'Return JSON only. Do not include Markdown fences or explanations.'
  ].join('\n');
}


// ============================================================
// 4. OpenRouter request with web tools
// ============================================================

function extractMouseSpecifications_(product) {
  var apiKey = PropertiesService
    .getScriptProperties()
    .getProperty('OPENROUTER_API_KEY');

  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'Missing OPENROUTER_API_KEY in Apps Script Script Properties.'
    );
  }

  var prompt = buildMouseSpecPrompt_(product);

  var payload = {
    model: SPEC_TEST_CONFIG.model,

    messages: [
      {
        role: 'system',
        content:
          'You are a careful technical research agent. ' +
          'Use web tools when required. Never fabricate evidence. ' +
          'Return valid JSON only.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],

    tools: [
      {
        type: 'openrouter:web_fetch'
      },
      {
        type: 'openrouter:web_search',
        parameters: {
          max_results: 5,
          max_uses: 3
        }
      }
    ],

    max_tool_calls: SPEC_TEST_CONFIG.maxToolCalls,
    temperature: 0,
    max_tokens: SPEC_TEST_CONFIG.maxTokens
  };

  var response = UrlFetchApp.fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + apiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  var httpStatus = response.getResponseCode();
  var raw = response.getContentText();
  var data;

  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      'OpenRouter returned non-JSON HTTP response. ' +
      'HTTP ' + httpStatus + ': ' + raw.slice(0, 1000)
    );
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    var apiMessage =
      data.error && data.error.message
        ? data.error.message
        : raw.slice(0, 1000);

    throw new Error(
      'OpenRouter HTTP ' + httpStatus + ': ' + apiMessage
    );
  }

  var choice = data.choices && data.choices[0];
  var message = choice && choice.message;
  var content = message && message.content;

  if (Array.isArray(content)) {
    content = content.map(function(part) {
      return part && part.text ? part.text : '';
    }).join('\n');
  }

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      'OpenRouter returned no usable text. ' +
      'Model=' + (data.model || SPEC_TEST_CONFIG.model) +
      ', finish_reason=' +
      (choice && choice.finish_reason || 'unknown') +
      ', response=' + raw.slice(0, 1000)
    );
  }

  var usage = data.usage || {};

  console.log('Requested model: ' + SPEC_TEST_CONFIG.model);
  console.log('Actual model: ' + (data.model || 'unknown'));
  console.log('HTTP status: ' + httpStatus);
  console.log('Finish reason: ' +
    (choice && choice.finish_reason || 'unknown'));
  console.log('Usage: ' + JSON.stringify(usage));

  var parsed = parseSpecJson_(content);

  validateSpecOutput_(parsed, product);

  // Always use the test runner's actual timestamp.
  parsed.last_fetched_at = new Date().toISOString();

  // Do not trust the model's self-reported verification status.
  parsed.verification_status = calculateSpecVerificationStatus_(
    parsed,
    usage
  );

  return {
    product: product,
    success: true,
    error: '',
    parsed: parsed,
    rawText: content,
    model: data.model || SPEC_TEST_CONFIG.model,
    usage: usage,
    responseId: data.id || '',
    finishReason: choice && choice.finish_reason || '',
    fetchedAt: new Date()
  };
}


// ============================================================
// 5. JSON parsing and validation
// ============================================================

function parseSpecJson_(text) {
  var cleaned = String(text || '').trim();

  // Remove optional Markdown fences.
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Fallback: locate the first complete JSON object.
    var start = cleaned.indexOf('{');

    if (start === -1) {
      throw new Error(
        'No JSON object found in model response. ' +
        cleaned.slice(0, 1000)
      );
    }

    var depth = 0;
    var inString = false;
    var escaped = false;

    for (var i = start; i < cleaned.length; i++) {
      var ch = cleaned.charAt(i);

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;

        if (depth === 0) {
          var candidate = cleaned.substring(start, i + 1);

          try {
            return JSON.parse(candidate);
          } catch (secondError) {
            throw new Error(
              'Invalid JSON in model response: ' +
              secondError.message
            );
          }
        }
      }
    }

    throw new Error(
      'Incomplete JSON object in model response.'
    );
  }
}


function validateSpecOutput_(obj, product) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Model output must be a JSON object.');
  }

  var missing = SPEC_MOUSE_FIELDS.filter(function(field) {
    return !Object.prototype.hasOwnProperty.call(obj, field);
  });

  // These metadata fields are also required for the test.
  [
    'product_name',
    'brand',
    'official_url',
    'page_access_status',
    'field_evidence',
    'limitations'
  ].forEach(function(field) {
    if (!Object.prototype.hasOwnProperty.call(obj, field)) {
      missing.push(field);
    }
  });

  if (missing.length) {
    throw new Error(
      'Missing required output fields: ' +
      missing.join(', ')
    );
  }

  if (obj.product_id !== product.product_id) {
    throw new Error(
      'product_id mismatch. Expected ' + product.product_id +
      ', got ' + obj.product_id
    );
  }

  if (
    ['success', 'failed', 'insufficient_content']
      .indexOf(obj.page_access_status) === -1
  ) {
    throw new Error(
      'Invalid page_access_status: ' + obj.page_access_status
    );
  }

  if (
    !obj.field_evidence ||
    typeof obj.field_evidence !== 'object' ||
    Array.isArray(obj.field_evidence)
  ) {
    throw new Error('field_evidence must be a JSON object.');
  }

  var invalidNumbers = [
    'dpi_min',
    'dpi_max',
    'max_speed_ips',
    'max_acceleration_g',
    'max_polling_rate_hz',
    'button_count',
    'switch_lifecycle',
    'weight_g',
    'length_mm',
    'width_mm',
    'height_mm',
    'battery_life_hours'
  ].filter(function(field) {
    return obj[field] !== null &&
      (typeof obj[field] !== 'number' ||
       !isFinite(obj[field]));
  });

  if (invalidNumbers.length) {
    throw new Error(
      'Invalid numeric fields: ' + invalidNumbers.join(', ')
    );
  }

  [
    'wired_connection',
    'bluetooth_support'
  ].forEach(function(field) {
    if (
      obj[field] !== null &&
      typeof obj[field] !== 'boolean'
    ) {
      throw new Error(
        field + ' must be true, false, or null.'
      );
    }
  });

  if (!Array.isArray(obj.limitations)) {
    throw new Error('limitations must be an array.');
  }
}


// ============================================================
// 6. Programmatic verification status
// ============================================================

function calculateSpecVerificationStatus_(obj, usage) {
  var serverToolUse = usage && usage.server_tool_use
    ? usage.server_tool_use
    : {};

  var fetchCount = Number(
    serverToolUse.web_fetch_requests || 0
  );

  var searchCount = Number(
    serverToolUse.web_search_requests || 0
  );

  var usedWebTool = fetchCount > 0 || searchCount > 0;

  if (!usedWebTool) {
    console.warn(
      'No web-tool usage reported. Marking result unverified.'
    );
    return 'unverified';
  }

  if (obj.page_access_status === 'failed') {
    return 'failed';
  }

  if (obj.page_access_status === 'insufficient_content') {
    return 'unverified';
  }

  var evidence = obj.field_evidence || {};
  var verifiedCount = 0;
  var unverifiedCount = 0;
  var missingCount = 0;
  var absentCount = 0;

  SPEC_VALUE_FIELDS.forEach(function(field) {
    var item = evidence[field];

    if (!item || typeof item !== 'object') {
      absentCount++;
      return;
    }

    if (item.status === 'verified') {
      var hasValue = obj[field] !== null &&
        obj[field] !== undefined;

      var hasSource = typeof item.source_url === 'string' &&
        /^https?:\/\//i.test(item.source_url);

      var hasQuote = typeof item.evidence_quote === 'string' &&
        item.evidence_quote.trim().length > 0;

      if (hasValue && hasSource && hasQuote) {
        verifiedCount++;
      } else {
        unverifiedCount++;
      }
    } else if (item.status === 'missing') {
      missingCount++;
    } else {
      unverifiedCount++;
    }
  });

  console.log(JSON.stringify({
    webFetchRequests: fetchCount,
    webSearchRequests: searchCount,
    verifiedFields: verifiedCount,
    missingFields: missingCount,
    unverifiedFields: unverifiedCount,
    absentEvidenceFields: absentCount
  }));

  if (verifiedCount === 0) {
    return 'unverified';
  }

  if (
    unverifiedCount > 0 ||
    absentCount > 0 ||
    obj.limitations.length > 0
  ) {
    return 'partial';
  }

  return 'verified';
}


// ============================================================
// 7. Independent Google Sheets result table
// ============================================================

function getSpecTestSheet_() {
  var spreadsheet;

  if (SPEC_TEST_CONFIG.spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(
      SPEC_TEST_CONFIG.spreadsheetId
    );
  } else {
    spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  }

  if (!spreadsheet) {
    throw new Error(
      'No active spreadsheet. Set spreadsheetId in ' +
      'SPEC_TEST_CONFIG to your test spreadsheet ID.'
    );
  }

  var sheet = spreadsheet.getSheetByName(
    SPEC_TEST_CONFIG.resultSheetName
  );

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      SPEC_TEST_CONFIG.resultSheetName
    );
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'tested_at',
      'product_id',
      'brand',
      'product_name',
      'success',
      'page_access_status',
      'verification_status',
      'actual_model',
      'web_fetch_requests',
      'web_search_requests',
      'json_valid',
      'source_url',
      'raw_json',
      'error',
      'response_id'
    ]);

    sheet.setFrozenRows(1);
  }

  return sheet;
}


function appendSpecTestResult_(sheet, result) {
  var product = result.product || {};
  var parsed = result.parsed || {};
  var usage = result.usage || {};
  var serverToolUse = usage.server_tool_use || {};

  var rawJson = parsed
    ? JSON.stringify(parsed)
    : '';

  // Keep within Google Sheets' cell text limit.
  if (rawJson.length > 45000) {
    rawJson = rawJson.slice(0, 45000) +
      '... [TRUNCATED: see execution logs]';
  }

  sheet.appendRow([
    new Date(),
    product.product_id || '',
    product.brand || '',
    product.product_name || '',
    result.success === true,
    parsed.page_access_status || '',
    parsed.verification_status || 'failed',
    result.model || '',
    Number(serverToolUse.web_fetch_requests || 0),
    Number(serverToolUse.web_search_requests || 0),
    result.success === true && !!parsed,
    parsed.source_url || product.official_url || '',
    rawJson,
    result.error || '',
    result.responseId || ''
  ]);
}


// ============================================================
// 8. Connectivity test: no website extraction
// ============================================================

/**
 * Tests the API key, model routing, and basic JSON response.
 * Does not use web tools or modify business data.
 */
function testSpecOpenRouterConnection() {
  var apiKey = PropertiesService
    .getScriptProperties()
    .getProperty('OPENROUTER_API_KEY');

  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      'Missing OPENROUTER_API_KEY in Script Properties.'
    );
  }

  var payload = {
    model: SPEC_TEST_CONFIG.model,
    messages: [
      {
        role: 'user',
        content:
          'Return exactly this JSON object and nothing else: ' +
          '{"status":"OK","test":"SPEC_API_CONNECTION"}'
      }
    ],
    temperature: 0,
    max_tokens: 100
  };

  var response = UrlFetchApp.fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + apiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  var status = response.getResponseCode();
  var body = response.getContentText();

  console.log('HTTP status: ' + status);
  console.log('Response: ' + body);

  if (status < 200 || status >= 300) {
    throw new Error(
      'OpenRouter connection failed. HTTP ' + status +
      ': ' + body.slice(0, 1000)
    );
  }

  console.log('API CONNECTION TEST: PASS');
}
