
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
  var deadline = Number(opts.__deadline) || 0;

  for (var attempt = 0; attempt < 3; attempt++) {
    if (deadline && Date.now() >= deadline) break;
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
    if (deadline && Date.now() >= deadline) break;
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
