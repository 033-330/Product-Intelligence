
/**
 * PromptEval.gs
 *
 * 目的：
 * 1. 使用真实 Newsletter 原文测试 Prompt
 * 2. 比较宽泛提取指令（V1）与精简提取指令（V2）
 * 3. 使用现有 callOpenRouter()，不调用 Gemini
 * 4. 只写入独立的 Prompt_Eval_Results 测试表
 *
 * 依赖：
 * - OpenRouterClient.gs 中的 callOpenRouter()
 * - AIClient.gs 中的 extractJson_()
 * - CONFIG.SPREADSHEET_ID
 *
 * 不修改正式 Products / Topics / Feedback 等业务表。
 */

var PROMPT_EVAL_CONFIG = {
  SHEET_NAME: 'Prompt_Eval_Results',
  MODEL: 'minimax/minimax-m3.1-flash:free',
  MAX_TOKENS: 3000,
  TEMPERATURE: 0,
};


/**
 * 固定测试集：取自第14期 Newsletter 的真实文本。
 *
 * 注意：
 * expectedTopics 是人工审核时的参考方向，
 * 不是要求模型必须输出所有这些主题。
 */
function getPromptEvalSamples_() {
  return [
    {
      sample_id: 'S01',
      sample_type: '多主题产品评测',
      expected_product: 'GPW5 Ultra',
      expected_topics: '重量、重心、电磁微动',
      text:
        '罗技G Pro X Superlight 2（GPW5）自诞生以来更新最快的一次迭代在七个月后到来。创作者"肚子饱饱丶"指出，国行命名为"GPW5 Ultra"而非"GPW6"非常贴切，因为相较于大刀阔斧的改动，这款新品更多是在GPW5细节上进行优化，并带来全新的传感器以及主控，属于中期改款而非全新一代产品。另一位创作者"爱吃肉的黑皮"同样认为，GPW5 Ultra对比GPW5属于"体验方面的优化，属于是小改"，重心和续航确实没问题。在重量与重心方面，两位创作者均给予了正面评价。"爱吃肉的黑皮"表示"重量和重心问题，叉三对比叉2进步是非常巨大的"，并将GPW5和GPW5 Ultra形容为"体育生的钉子跑鞋"，认为其独特的电磁微动结构在适应后"确实能够实打实的提升游戏水平"。'
    },
    {
      sample_id: 'S02',
      sample_type: '技术与商品区分',
      expected_product: 'GPW5 Ultra',
      expected_topics: '电磁微动',
      text:
        '创作者 Loksins 在评测罗技 GPW5 Ultra 时提到，使用电磁微动的鼠标相比传统微动开关能够节省毫秒级的时间。他在视频中向观众展示并讲解了这一技术特性，指出电磁微动在响应速度上具有优势。'
    },
    {
      sample_id: 'S03',
      sample_type: '竞品比较与情感',
      expected_product: 'GPW5、雷蛇毒蝰V4 Pro',
      expected_topics: '手感、价格、重量、续航',
      text:
        '用户"oTter_"逐项对比，认为抛开电磁微动"挑人"的适应性争议，GPW5在涂层、重量、续航乃至价格上"样样打不过"，质疑其"鼠皇"称号的合理性。'
    },
    {
      sample_id: 'S04',
      sample_type: '购买决策与价格',
      expected_product: 'GPW5、雷蛇毒蝰V4 Pro',
      expected_topics: '价格、购买意愿',
      text:
        '在价格走势的讨论中，用户们对GPW5能否降到特定价位存在分歧。一位名为"是西巴不是西八"的用户认为不太可能，理由是当前狗2和狗3都维持在这个价位，狗5基本不太可能降到同样水平。另一位用户"她在卖萌"则给出了更具体的预测，认为500元不太可能，因为下面有2、3、4代的价格顶着，但明年618期间狗5降到700元左右还是很大概率的。'
    },
    {
      sample_id: 'S05',
      sample_type: '长篇耳机评测',
      expected_product: '罗技 G PRO X 3',
      expected_topics: '重量、佩戴舒适度、音质',
      text:
        '创作者「像素块盒子」在评测中指出，罗技G PRO X 3作为第三代旗舰耳机，延续了G PRO系列简约硬朗的家族设计轮廓，提供热力白、暗夜黑和猛男粉三种配色，耳壳采用金属质感装饰件，触感顺滑且不易留指纹。该耳机整机重量约356克，头梁采用全新穿孔皮革加透析设计，压力分布均匀，实测连续佩戴15小时头顶没有明显压迫感；耳罩为皮革记忆棉材质，包装内附赠一副绒布耳罩，以应对不同季节的温差舒适度需求。'
    }
  ];
}

/**
 * V2：精简、稳定、面向 Feature 的提取 Prompt。
 */

function buildPromptEvalV2_(sample) {
  return [
 `
你是一名消费电子产品情报分析员，负责从中文 Newsletter 中提取真实商品、产品讨论主题、情感和可追溯的原文证据。

你的首要目标是准确，而不是尽可能多地输出。宁可省略无法确认的信息，也不能虚构商品、重复主题或错误关联证据。

请严格遵守以下规则。

## 一、产品与实体识别

### 1. 区分商品与技术

真正的商品是可独立识别的具体产品或型号，例如鼠标、键盘、耳机。

以下内容不能作为独立商品：
- 技术：电磁微动、传感器技术、无线传输技术。
- 零部件：传感器、主控、微动开关。
- 功能或属性：响应速度、重量、续航。
- 称号或描述：鼠皇、旗舰、电竞神器。

products 数组可以保留原有的实体分类字段 entity_type：
- product：真实商品。
- technology：原文明确提及且有分析价值的技术实体。

技术实体可以作为 technology 出现在 products 数组中，但绝不能当成商品，也不能为它创建独立商品的产品 Topic。

### 2. 产品名称、别名和历史代际

按以下优先级识别商品：

1. 原文中的完整名称和明确型号。
2. 能通过上下文或明确别名可靠映射的简称。
3. 历史代际名称或数字代称，仅在型号可以明确确认时映射。

特别注意：
- 不要因为出现“狗2”“狗3”“狗4”等表达，就自动创建多个新商品。
- 如果上下文明确说明这些称呼分别指向不同的已知商品，可以保留对应商品。
- 如果无法确定代称对应哪个型号，不要猜测，不要创建正式商品实体。
- 不要将“GPW5”和“GPW5 Ultra”自动合并成同一个产品。只有原文明示它们是同一型号或别名时，才能合并。
- 不要将产品代际、升级版本或同系列型号视为同一个商品，除非证据明确支持。
- 不要把营销称号误认为商品型号。

### 3. 主要产品和竞品

必须识别原文中明确出现且有实际讨论价值的商品，包括：
- 主要评测对象。
- 明确参与比较的竞品。
- 被讨论的历史型号或替代产品。

竞品即使只出现在比较句中，也不能因为不是主要讨论对象而被遗漏。

但是，不要为了增加商品数量而纳入无关的品牌、技术名词或无法确认的代称。

### 4. 实体字段约束

products 中每个实体必须包含：
- product_name：原文中能够确认的名称。
- entity_type：product 或 technology。

同一实体只输出一次。使用原文中的名称；只有存在明确依据时，才将别名统一到同一名称。

## 二、Topic 归并与去重

Topic 是一个具有独立分析价值的产品讨论维度，不是任意关键词或句子。

### 1. 先归并，再输出

针对同一产品，先检查所有候选 Topic，再输出最终结果。

以下表达应归并到同一个 Topic：
- “响应很快”“毫秒级响应”“响应速度提升” → “响应速度”
- “电池耐用”“电量消耗快”“续航时间长” → “续航”
- “更轻”“减重”“整机重量” → “重量”

归并时保留真实的情感差异。例如，同一产品的续航既有正面评价，也有负面评价时，可以保留不同证据，但不应仅因为情感不同就创建两个“续航” Topic。

### 2. 不要过度合并

以下是不同的分析维度，可以分别保留：
- 重量与重心。
- 价格与购买意愿。
- 外观设计与佩戴舒适度。
- 响应速度与按键手感。

判断标准是：它们是否代表不同的产品属性或用户决策因素，而不是词语是否出现在同一句话中。

### 3. Topic 名称规则

- 使用简洁、稳定、方便跨期统计的名称，通常为 2–6 个汉字。
- 优先使用“重量”“重心”“续航”“价格”“涂层”“响应速度”“佩戴舒适”等标准名称。
- 不要把完整观点、句子或结论直接作为 feature。
- 不要使用“表现很好”“用户评价”“产品优势”等过于宽泛的名称。
- 不要将“毫秒级”“提升很大”等描述词独立创建为 Topic，除非它们确实代表不同的分析维度。
- 不要为了凑数量而创建 Topic。
- 不要把同一个产品的同一维度重复输出。

### 4. 产品关联规则

每个 Topic 必须关联一个明确的实际商品。

- 如果原文讨论 GPW5 的重量，Topic 应关联 GPW5。
- 如果原文讨论 GPW5 Ultra 的续航，Topic 应关联 GPW5 Ultra。
- 如果原文同时比较多个产品，只有在证据明确涉及各产品时，才分别建立对应关联。
- 不能仅因为两款产品出现在同一句话中，就把同一个评价同时归属于两款产品。
- 技术实体不是独立商品，不能成为普通产品 Topic 的 product_name。

## 三、证据真实性与产品归属

evidence 必须是一个字符串，保留原有 JSON 字段结构。

每条 evidence 必须满足以下全部条件：

1. 是原文中连续、可直接检索的文本片段。
2. 不得翻译、改写、润色或拼接不连续的句子。
3. 片段确实支持对应的 feature。
4. 片段中的评价对象能够明确关联到当前 product_name。
5. 如果 evidence 包含多个产品，必须能够判断其中哪些信息属于当前产品。
6. 如果原文没有足够信息支持某个产品或 Topic，不要通过推理补全证据。

特别注意：
- 不能因为一句话提到“重量和重心”，就自动为每个产品生成同样的正面评价。
- 不能把比较结果直接转换为某个产品的绝对评价，除非原文明确支持。
- 不要为不同 Topic 重复输出内容完全相同的宽泛证据，除非该证据确实同时支持不同维度，且没有更精确的证据可用。
- 优先选择最短但足以支持结论的连续原文片段。
- 保留原文中的关键限定条件、比较对象和否定表达。

证据校验优先级高于摘要完整性。如果无法找到可靠证据，就不要输出该 Topic。

## 四、情感判断

sentiment 只能是以下四种之一：
- positive
- negative
- neutral
- mixed

判断规则：
- positive：原文明确表达正面体验或评价。
- negative：原文明确表达负面体验或评价。
- neutral：原文主要陈述事实、参数或客观信息，没有明确的情感倾向。
- mixed：同一 Topic 下有明确的正反观点，或同一段评价同时包含明显的正负判断。

不要因为产品具有某项技术，就自动判断为 positive。
不要把“能够提升游戏水平”作为客观事实，除非原文只是被忠实地引用为某位创作者的观点；摘要应明确归因于原文中的评价者。
不要把不同产品的情感混合在一起。
不要将对价格走势的预测误写为对产品整体质量的评价。

## 五、摘要长度与内容

summary 使用一句简洁的中文概括当前产品在该 Topic 上的核心信息。

目标长度通常为 20–50 个汉字；简单的事实可以更短，复杂的比较可以略长。

摘要必须：
- 明确描述产品在该维度上的表现或争议。
- 保留重要的比较关系、条件和观点分歧。
- 与 evidence 一致，不添加证据没有支持的信息。
- 尽量避免重复证据中的完整原句。
- 不要写与 Topic 无关的背景介绍。
- 不要把推测写成已确认的事实。

## 六、提取范围与信息完整性

- 覆盖原文中所有明确提及且有分析价值的商品。
- 保留有价值的竞品比较、体验反馈、购买决策和产品属性讨论。
- 不需要把文章中的每个参数、技术名词或外观细节都变成 Topic。
- 长篇评测可以提取多个独立 Topic，但必须经过归并。
- 同一 Topic 下存在不同用户观点时，保留有代表性的不同证据，不要为了简洁而掩盖分歧。
- 没有足够证据的字段，不得猜测或补充。
- 不要根据 expected_product、expected_topics 或任何外部参考答案反向推断结果。

## 七、输出 JSON 格式

只输出合法 JSON，不要输出 Markdown 代码块、解释或额外文字。

必须使用以下结构，字段名称和类型不可更改：

{
  "products": [
    {
      "product_name": "原文中确认的实体名称",
      "entity_type": "product"
    }
  ],
  "topics": [
    {
      "product_name": "对应的真实商品名称",
      "feature": "简短且归并后的 Topic",
      "sentiment": "neutral",
      "summary": "一句简洁、忠于证据的中文摘要。",
      "evidence": "原文中的连续文本片段"
    }
  ]
}

严格约束：
- products 必须是数组。
- topics 必须是数组。
- product_name、entity_type、feature、sentiment、summary、evidence 必须使用规定的字段名。
- products[].entity_type 只能为 product 或 technology。
- topics[].sentiment 只能为 positive、negative、neutral 或 mixed。
- topics[].product_name 必须对应 products 中 entity_type 为 product 的实体。
- technology 实体不能作为独立商品创建 Topic。
- 同一个商品的同一分析维度不得重复输出。
- evidence 必须是字符串，不能改成数组。
- 不要输出额外字段。
- 如果没有符合条件的商品或 Topic，分别返回空数组。
- 输出前检查 JSON 语法、产品关联、Topic 重复、情感与证据的一致性。`,
    'Newsletter 原文：',
    sample.text
  ].join('\n');
}


/**
 * 运行单个样本、单个 Prompt 版本。
 *
 * 直接使用 callOpenRouter，以便保留实际模型名称、
 * usage、finish reason 和 response ID。
 */
function runOnePromptEval_(sample, version, prompt) {
  var startedAt = new Date();
  var result = {
    sample_id: sample.sample_id,
    sample_type: sample.sample_type,
    prompt_version: version,
    requested_model: PROMPT_EVAL_CONFIG.MODEL,
    actual_model: '',
    status: 'ERROR',
    products: [],
    topics: [],
    product_count: 0,
    topic_count: 0,
    evidence_valid_count: 0,
    evidence_invalid_count: 0,
    evidence_validation: '',
    expected_product: sample.expected_product,
    expected_topics: sample.expected_topics,
    source_text: sample.text,
    raw_output: '',
    error: '',
    usage: '',
    finish_reason: '',
    response_id: '',
    duration_ms: 0,
    tested_at: startedAt
  };

  try {
    var response = callOpenRouter(prompt, {
      model: PROMPT_EVAL_CONFIG.MODEL,
      maxTokens: PROMPT_EVAL_CONFIG.MAX_TOKENS,
      temperature: PROMPT_EVAL_CONFIG.TEMPERATURE,
      minimalReasoning: true
    });

    result.actual_model = response.actualModel || '';
    result.raw_output = response.text || '';
    result.usage = JSON.stringify(response.usage || {});
    result.finish_reason = response.finishReason || '';
    result.response_id = response.responseId || '';

    var parsed = extractJson_(response.text);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('输出不是 JSON 对象');
    }

    if (!Array.isArray(parsed.products)) {
      throw new Error('products 必须是数组');
    }

    if (!Array.isArray(parsed.topics)) {
      throw new Error('topics 必须是数组');
    }

    result.products = parsed.products;
    result.topics = parsed.topics;
    result.product_count = parsed.products.length;
    result.topic_count = parsed.topics.length;

    var validEvidence = 0;
    var invalidEvidence = 0;
    var evidenceIssues = [];

    parsed.topics.forEach(function(topic, index) {
      var evidence = topic && topic.evidence;
      var feature = topic && topic.feature;
      var sentiment = topic && topic.sentiment;

      if (typeof feature !== 'string' || !feature.trim()) {
        evidenceIssues.push('Topic #' + (index + 1) + ': feature 为空');
      }

      if ([
        'positive', 'negative', 'neutral', 'mixed', 'uncertain'
      ].indexOf(sentiment) === -1) {
        evidenceIssues.push(
          'Topic #' + (index + 1) + ': sentiment 不合法'
        );
      }

      if (
        typeof evidence === 'string' &&
        evidence.trim() &&
        sample.text.indexOf(evidence.trim()) !== -1
      ) {
        validEvidence++;
      } else {
        invalidEvidence++;
        evidenceIssues.push(
          'Topic #' + (index + 1) + ': evidence 不是原文连续片段'
        );
      }
    });

    result.evidence_valid_count = validEvidence;
    result.evidence_invalid_count = invalidEvidence;
    result.evidence_validation = evidenceIssues.join(' | ');

    result.status = evidenceIssues.length ? 'REVIEW' : 'PASS';
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
  }

  result.duration_ms = new Date().getTime() - startedAt.getTime();
  return result;
}


/**
 * 创建或获取独立测试表。
 * 不清空历史记录，每次运行都追加结果。
 */
function getPromptEvalSheet_() {
  if (
    typeof CONFIG === 'undefined' ||
    !CONFIG.SPREADSHEET_ID
  ) {
    throw new Error(
      '找不到 CONFIG.SPREADSHEET_ID，请检查现有配置文件'
    );
  }

  var spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = spreadsheet.getSheetByName(
    PROMPT_EVAL_CONFIG.SHEET_NAME
  );

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      PROMPT_EVAL_CONFIG.SHEET_NAME
    );
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'run_id',
      'sample_id',
      'sample_type',
      'prompt_version',
      'requested_model',
      'actual_model',
      'status',
      'product_count',
      'topic_count',
      'evidence_valid_count',
      'evidence_invalid_count',
      'expected_product',
      'expected_topics',
      'products_json',
      'topics_json',
      'evidence_validation',
      'source_text',
      'raw_output',
      'error',
      'usage_json',
      'finish_reason',
      'response_id',
      'duration_ms',
      'tested_at'
    ]);
  }

  return sheet;
}


/**
 * 入口 A：先运行一个样本，确认调用、解析、写表全流程正常。
 * 预计 2 次模型调用。
 */
function testPromptEvalOneSample() {
  var samples = getPromptEvalSamples_();
  var sample = samples[0];
  var runId = 'EVAL-' + new Date().getTime();

  var v2 = runOnePromptEval_(
    sample,
    'V2_CONCISE',
    buildPromptEvalV2_(sample)
  );

  var rows = [
    buildPromptEvalRow_(runId, v1),
    buildPromptEvalRow_(runId, v2)
  ];

  var sheet = getPromptEvalSheet_();
  sheet.getRange(
    sheet.getLastRow() + 1,
    1,
    rows.length,
    rows[0].length
  ).setValues(rows);

  logPromptEvalSummary_([v1, v2]);

  console.log(
    '单样本测试完成。结果写入：' +
    PROMPT_EVAL_CONFIG.SHEET_NAME
  );
}


/**
 * 入口 B：运行完整首轮测试。
 * 5 个真实样本 × 2 个版本 = 10 次模型调用。
 */
function runPromptEvalAB() {
  var samples = getPromptEvalSamples_();
  var runId = 'EVAL-' + new Date().getTime();
  var results = [];

  samples.forEach(function(sample) {
    console.log(
      '开始测试 ' + sample.sample_id +
      ' / ' + sample.sample_type
    );

    var v2 = runOnePromptEval_(
      sample,
      'V2_CONCISE',
      buildPromptEvalV2_(sample)
    );
    results.push(v2);
  });

  var rows = results.map(function(result) {
    return buildPromptEvalRow_(runId, result);
  });

  var sheet = getPromptEvalSheet_();
  if (rows.length) {
    sheet.getRange(
      sheet.getLastRow() + 1,
      1,
      rows.length,
      rows[0].length
    ).setValues(rows);
  }

  logPromptEvalSummary_(results);

  console.log(
    'A/B 测试完成。run_id=' + runId +
    '；结果写入 ' + PROMPT_EVAL_CONFIG.SHEET_NAME
  );
}


/**
 * 将一条结果转换成测试表行。
 */
function buildPromptEvalRow_(runId, r) {
  return [
    runId,
    r.sample_id,
    r.sample_type,
    r.prompt_version,
    r.requested_model,
    r.actual_model,
    r.status,
    r.product_count,
    r.topic_count,
    r.evidence_valid_count,
    r.evidence_invalid_count,
    r.expected_product,
    r.expected_topics,
    JSON.stringify(r.products),
    JSON.stringify(r.topics),
    r.evidence_validation,
    r.source_text,
    r.raw_output,
    r.error,
    r.usage,
    r.finish_reason,
    r.response_id,
    r.duration_ms,
    r.tested_at
  ];
}


/**
 * 在执行日志中打印精简汇总。
 */
function logPromptEvalSummary_(results) {
  var summary = {};

  results.forEach(function(r) {
    var key = r.prompt_version;

    if (!summary[key]) {
      summary[key] = {
        calls: 0,
        pass: 0,
        review: 0,
        errors: 0,
        products: 0,
        topics: 0,
        validEvidence: 0,
        invalidEvidence: 0,
        models: {}
      };
    }

    var s = summary[key];
    s.calls++;

    if (r.status === 'PASS') s.pass++;
    else if (r.status === 'REVIEW') s.review++;
    else s.errors++;

    s.products += r.product_count;
    s.topics += r.topic_count;
    s.validEvidence += r.evidence_valid_count;
    s.invalidEvidence += r.evidence_invalid_count;

    var model = r.actual_model || 'unknown';
    s.models[model] = (s.models[model] || 0) + 1;
  });

  console.log('PROMPT EVAL SUMMARY: ' + JSON.stringify(summary));
}