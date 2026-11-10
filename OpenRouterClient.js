
/**
 * OpenRouterClient.gs
 *
 * 独立的 OpenRouter AI 适配器。
 * 默认使用显式 :free 模型链（Nemotron 30B → Nemotron VL → openrouter/free），
 * 上游无文本/报错时自动切换下一个候选。
 *
 * Script Properties 必须包含：
 * OPENROUTER_API_KEY
 */

/**
 * 调用 OpenRouter Chat Completions API。
 *
 * @param {string} prompt 用户提示词
 * @param {Object=} opts 可选参数
 * @return {Object} 统一格式的调用结果
 */
/**
 * 解析 OpenRouter 模型候选链：
 *   Script Property OPENROUTER_MODEL > 调用方 opts.model > CONFIG.OPENROUTER_MODEL
 *   然后是 CONFIG.OPENROUTER_FALLBACK_MODELS。
 */
function openRouterModelChain_(override) {
  var chain = [];
  function push(m) {
    var v = String(m || '').trim();
    if (v && chain.indexOf(v) < 0) chain.push(v);
  }
  push(scriptProperty_('OPENROUTER_MODEL'));
  push(override);
  push(CONFIG.OPENROUTER_MODEL);
  (CONFIG.OPENROUTER_FALLBACK_MODELS || []).forEach(push);
  push('minimax/minimax-m3.1-flash:free');
  return chain.length ? chain : ['minimax/minimax-m3.1-flash:free'];
}

function callOpenRouter(prompt, opts) {
  opts = opts || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('callOpenRouter: prompt 为空');
  }

  var key = PropertiesService
    .getScriptProperties()
    .getProperty('OPENROUTER_API_KEY');

  if (!key || !key.trim()) {
    throw new Error(
      '缺少 OPENROUTER_API_KEY，请在 Apps Script 项目设置 → 脚本属性中配置'
    );
  }

  var modelQueue = openRouterModelChain_(opts.model);
  var model = modelQueue[0];
  var modelSwitches = 0;
  var url = String(
    CONFIG.OPENROUTER_BASE || 'https://openrouter.ai/api/v1/chat/completions'
  );

  var payload = {
    model: model,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. Follow the user instructions exactly.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: opts.temperature != null ? opts.temperature : 0,
    max_tokens: opts.maxTokens || 300,
    usage: {
      include: true
    }
  };

  // 需要结构化 JSON 时请求 JSON 输出；不支持的模型会在下面自动重试去掉该参数。
  if (opts.jsonSchema) {
    payload.response_format = { type: 'json_object' };
  }

  // 可选推理控制。不同模型的支持情况可能不同。
  if (opts.minimalReasoning === true) {
    payload.reasoning = {
      effort: 'minimal',
      exclude: true
    };
  }

  var response;
  var status;
  var raw;
  var data;
  var lastError = null;

  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: {
          Authorization: 'Bearer ' + key
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      status = response.getResponseCode();
      raw = response.getContentText();

      try {
        data = JSON.parse(raw);
      } catch (e) {
        throw new Error(
          'OpenRouter 返回非 JSON 响应，HTTP ' + status +
          '：' + raw.slice(0, 500)
        );
      }

      if (status >= 200 && status < 300) {
        var first = data.choices && data.choices[0];
        var firstText = first && first.message && first.message.content;
        var hasText = typeof firstText === 'string' && !!firstText.trim();
        var errorFinish = !!(first && first.finish_reason === 'error');
        if (hasText && !errorFinish) break;

        // 上游返回 error / 空文本时换下一个候选模型，而不是直接放弃整个 provider。
        lastError = new Error(
          'OpenRouter 返回成功，但没有可用文本。' +
          ' model=' + (data.model || model) +
          ', finish_reason=' + ((first && first.finish_reason) || 'unknown') +
          ', response_id=' + (data.id || 'unknown')
        );
        if (modelQueue.length > 1 && modelSwitches < 3) {
          modelSwitches++;
          modelQueue.shift();
          model = modelQueue[0];
          payload.model = model;
          Logger.log('OpenRouter 无可用文本/上游报错，改用 ' + model);
          attempt--;
          continue;
        }
        break;
      }

      var message = data.error && data.error.message
        ? data.error.message
        : raw.slice(0, 500);
      lastError = new Error('OpenRouter HTTP ' + status + '：' + message);

      // 免费模型改名/下线是常态：换个候选模型重试，不要让整条链路死在一个失效的 ID 上。
      if (status === 400 && /not a valid model|model_not_found|No endpoints found/i.test(message)
          && modelQueue.length > 1 && modelSwitches < 3) {
        modelSwitches++;
        modelQueue.shift();
        model = modelQueue[0];
        payload.model = model;
        Logger.log('OpenRouter 模型无效，改用 ' + model);
        attempt--;
        continue;
      }

      // 一些免费模型不支持 response_format，去掉后重试一次。
      if (payload.response_format && [400, 404, 422].indexOf(status) >= 0) {
        delete payload.response_format;
        attempt--;
        continue;
      }
      if (status !== 429 && status < 500) throw lastError;
    } catch (e) {
      lastError = e;
    }
    if (attempt < 2) Utilities.sleep(1200 * (attempt + 1));
  }

  if (!data || status < 200 || status >= 300) {
    throw lastError || new Error('OpenRouter 请求失败');
  }

  var choice = data.choices && data.choices[0];
  var message = choice && choice.message;
  var content = message && message.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      'OpenRouter 返回成功，但没有可用文本。' +
      ' model=' + (data.model || model) +
      ', finish_reason=' + (choice && choice.finish_reason || 'unknown') +
      ', response_id=' + (data.id || 'unknown')
    );
  }

  var usage = data.usage || {};

  // 只记录必要的诊断信息，不记录 API Key 或完整提示词。
  console.log('OpenRouter requested model: ' + model);
  console.log('OpenRouter actual model: ' + (data.model || 'unknown'));
  console.log('OpenRouter HTTP status: ' + status);
  console.log('OpenRouter usage: ' + JSON.stringify(usage));

  return {
    success: true,
    provider: 'openrouter',
    requestedModel: model,
    actualModel: data.model || null,
    text: content,
    usage: usage,
    finishReason: choice.finish_reason || null,
    responseId: data.id || null
  };
}

/**
 * 统一 AI 入口的显式 provider 版本。
 * 不传 provider 时请使用 callAI() 以启用自动回退。
 */
function callAIWithProvider(provider, prompt, schema, opts) {
  opts = opts || {};
  provider = String(provider || '').toLowerCase();

  if (provider === 'gemini') {
    return callGeminiProvider_(prompt, schema, opts);
  }

  if (provider === 'openrouter') {
    return callOpenRouterProvider_(prompt, schema, opts);
  }

  throw new Error(
    '不支持的 AI provider：' + provider
  );
}

/**
 * Day 3 测试：
 * 验证新适配器能否返回统一格式的结果。
 * 不读取报告、不修改 Google Sheets。
 */
function testOpenRouterAdapter() {
  var result = callOpenRouter(
    'Reply with exactly OPENROUTER_DAY3_OK',
    {
      model: CONFIG.OPENROUTER_MODEL,
      maxTokens: 300,
      temperature: 0,
      minimalReasoning: true
    }
  );

  console.log('Adapter test result: ' + JSON.stringify({
    success: result.success,
    provider: result.provider,
    requestedModel: result.requestedModel,
    actualModel: result.actualModel,
    text: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
    responseId: result.responseId
  }));

  if (result.text.trim() !== 'OPENROUTER_DAY3_OK') {
    throw new Error(
      '适配器测试失败：返回内容与预期不一致'
    );
  }

  console.log('DAY3 ADAPTER TEST: PASS');
}

/**
 * 验证统一入口的 OpenRouter 分支。
 */
function testUnifiedAIEntry() {
  var output = callAIWithProvider(
    'openrouter',
    'Reply with exactly UNIFIED_AI_OK',
    null,
    {
      model: CONFIG.OPENROUTER_MODEL,
      maxTokens: 100,
      temperature: 0,
      minimalReasoning: true
    }
  );

  console.log('统一入口返回: ' + output);

  if (output.trim() !== 'UNIFIED_AI_OK') {
    throw new Error('统一 AI 入口测试失败');
  }

  console.log('DAY3 UNIFIED ENTRY TEST: PASS');
}

/**
 * OpenRouter JSON 结构化提取模块
 * 不写入 Google Sheets，不修改现有业务流程。
 */

/**
 * 通过 OpenRouter 提取 JSON，并校验必需字段。
 *
 * @param {string} prompt 提取任务说明
 * @param {string[]} requiredKeys 必须存在的字段名
 * @param {Object=} opts 模型调用参数
 * @return {Object} 解析后的 JSON 对象
 */
function callOpenRouterJson(prompt, requiredKeys, opts) {
  opts = opts || {};
  requiredKeys = requiredKeys || [];

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('callOpenRouterJson: prompt 为空');
  }

  if (!Array.isArray(requiredKeys)) {
    throw new Error('requiredKeys 必须是数组');
  }

  var jsonPrompt = [
    '请完成以下任务，并严格遵守输出格式。',
    '只输出一个合法的 JSON 对象。',
    '不要输出 Markdown 代码块、解释文字或 JSON 以外的内容。',
    '所有要求的字段都必须存在；无法确定的值请使用 null。',
    '',
    '任务：',
    prompt,
    '',
    '必须包含的字段：',
    JSON.stringify(requiredKeys)
  ].join('\n');

  // 不修改传入的 opts 对象。
  var requestOpts = {};
  Object.keys(opts).forEach(function(key) {
    requestOpts[key] = opts[key];
  });

  requestOpts.maxTokens = opts.maxTokens || 500;

  var result = callOpenRouter(jsonPrompt, requestOpts);
  var parsed;

  try {
    // 使用 Gemini.gs 中的 JSON 解析函数。
    parsed = extractJson_(result.text);
  } catch (e) {
    throw new Error(
      'OpenRouter JSON 解析失败：' + e.message +
      '\n模型：' + (result.actualModel || 'unknown') +
      '\n响应摘要：' + result.text.slice(0, 500)
    );
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('AI 输出必须是 JSON 对象，而不是数组或其他类型');
  }

  var missingKeys = requiredKeys.filter(function(key) {
    return !Object.prototype.hasOwnProperty.call(parsed, key);
  });

  if (missingKeys.length > 0) {
    throw new Error(
      'JSON 缺少必需字段：' + missingKeys.join(', ') +
      '\n实际输出：' + JSON.stringify(parsed)
    );
  }

  console.log('JSON 提取成功');
  console.log('实际模型：' + (result.actualModel || 'unknown'));
  console.log('必需字段校验：PASS');
  console.log('解析结果：' + JSON.stringify(parsed));

  return parsed;
}


/**
 * 独立测试：产品反馈结构化提取。
 * 不读写任何业务表。
 */
function testOpenRouterJsonExtraction() {
  var prompt = [
    '从以下反馈中提取产品名称、主题和情绪。',
    '产品名称必须保留原文中的名称。',
    '主题用简短中文表达。',
    '情绪只能为 positive、negative 或 neutral。',
    '',
    '反馈：GPW5 Ultra 的续航不错，但是蓝牙连接偶尔会断开。',
    '',
    '预期：产品名称为 GPW5 Ultra，主题为续航或蓝牙连接，',
    '情绪根据这条混合反馈选择最主要的负面问题。',
    '另外增加一个字段 evidence，引用支持判断的原文。'
  ].join('\n');

  var result = callOpenRouterJson(
    prompt,
    ['product_name', 'topic', 'sentiment', 'evidence'],
    {
      model: CONFIG.OPENROUTER_MODEL,
      maxTokens: 500,
      temperature: 0,
      minimalReasoning: true
    }
  );

  // 检查字段类型，防止只返回空字段就误判成功。
  if (typeof result.product_name !== 'string' ||
      !result.product_name.trim()) {
    throw new Error('product_name 必须是非空字符串');
  }

  if (typeof result.topic !== 'string' ||
      !result.topic.trim()) {
    throw new Error('topic 必须是非空字符串');
  }

  if (['positive', 'negative', 'neutral'].indexOf(
        result.sentiment
      ) === -1) {
    throw new Error('sentiment 值不合法：' + result.sentiment);
  }

  if (typeof result.evidence !== 'string' ||
      !result.evidence.trim()) {
    throw new Error('evidence 必须是非空字符串');
  }

  console.log('DAY4 JSON EXTRACTION TEST: PASS');
}
