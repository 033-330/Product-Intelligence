
/**
 * BrandExtractionRules.gs
 * Product Intelligence — Brand-specific product specification extraction rules
 *
 * Sheets:
 *   Brand_Extraction_Rules
 *   Products
 *   Mouse_Specs
 *
 * Public functions:
 *   setupBrandExtractionRules()
 *   getBrandExtractionRules()
 *   getBrandExtractionRuleById(ruleId)
 *   getBrandExtractionRuleForProduct(brand, category, url)
 *   matchBrandExtractionRuleByUrl(url)
 *   validateBrandExtractionRules()
 *
 * Design principles:
 *   1. Rules are configuration, parsers are implementation.
 *   2. Do not invent missing specifications.
 *   3. Keep variant/SKU differences.
 *   4. Keep official source URLs and verification status.
 *   5. Preserve existing data when initializing the rule sheet.
 */

const BRAND_RULES_CONFIG = {
  SHEET_NAME: 'Brand_Extraction_Rules',
  PRODUCTS_SHEET_NAME: 'Products',
  SPECS_SHEET_NAME: 'Mouse_Specs',
  VERSION: '1.0.0',

  // Canonical columns. Existing extra columns are preserved.
  HEADERS: [
    'rule_id',
    'brand_id',
    'brand_name',
    'entity_type',
    'product_category',
    'official_domain',
    'product_url_pattern',
    'source_type',
    'fetch_method',
    'extraction_method',
    'data_selector',
    'field_mapping_json',
    'normalization_rules_json',
    'variant_handling',
    'deduplication_rule',
    'missing_value_policy',
    'verification_rule',
    'parser_function',
    'rule_status',
    'notes',
    'updated_at'
  ],

  ACTIVE_STATUS: 'ACTIVE'
};


/**
 * Canonical field mappings.
 *
 * The left side is the canonical field in Mouse_Specs.
 * source_aliases are possible official-site labels.
 *
 * Parser implementations should use these aliases as hints rather
 * than relying exclusively on exact string matching.
 */
const BRAND_SPEC_FIELD_DEFINITIONS = [
  {
    key: 'sensor_name',
    label: 'Sensor',
    unit: '',
    source_aliases: [
      'sensor',
      'sensor name',
      'optical sensor',
      'sensor type'
    ]
  },
  {
    key: 'dpi_min',
    label: 'Minimum DPI',
    unit: 'DPI',
    source_aliases: [
      'minimum dpi',
      'min dpi',
      'minimum sensitivity',
      'minimum resolution'
    ]
  },
  {
    key: 'dpi_max',
    label: 'Maximum DPI',
    unit: 'DPI',
    source_aliases: [
      'max dpi',
      'maximum dpi',
      'max sensitivity',
      'maximum sensitivity',
      'maximum resolution',
      'resolution',
      'dpi'
    ]
  },
  {
    key: 'max_speed_ips',
    label: 'Maximum Speed',
    unit: 'IPS',
    source_aliases: [
      'max speed',
      'maximum speed',
      'maximum tracking speed',
      'tracking speed'
    ]
  },
  {
    key: 'max_acceleration_g',
    label: 'Maximum Acceleration',
    unit: 'G',
    source_aliases: [
      'max acceleration',
      'maximum acceleration',
      'acceleration'
    ]
  },
  {
    key: 'max_polling_rate_hz',
    label: 'Maximum Polling Rate',
    unit: 'Hz',
    source_aliases: [
      'polling rate',
      'max polling rate',
      'maximum polling rate',
      'report rate',
      'polling rate / interval'
    ]
  },
  {
    key: 'connection_type',
    label: 'Connection Type',
    unit: '',
    source_aliases: [
      'connectivity',
      'connection',
      'connection type',
      'connectivity technology'
    ]
  },
  {
    key: 'wireless_technology',
    label: 'Wireless Technology',
    unit: '',
    source_aliases: [
      'wireless technology',
      'wireless connectivity',
      'lightspeed',
      'hyperspeed wireless'
    ]
  },
  {
    key: 'wired_connection',
    label: 'Wired Connection',
    unit: '',
    source_aliases: [
      'wired connection',
      'cable',
      'connection type',
      'usb connection'
    ]
  },
  {
    key: 'bluetooth_support',
    label: 'Bluetooth Support',
    unit: '',
    source_aliases: [
      'bluetooth',
      'bluetooth support',
      'bluetooth connectivity'
    ]
  },
  {
    key: 'button_count',
    label: 'Programmable Buttons',
    unit: '',
    source_aliases: [
      'buttons',
      'number of buttons',
      'programmable buttons',
      'button count'
    ]
  },
  {
    key: 'switch_type',
    label: 'Switch Type',
    unit: '',
    source_aliases: [
      'switch type',
      'switches',
      'mouse switches',
      'click technology'
    ]
  },
  {
    key: 'switch_lifecycle',
    label: 'Switch Lifecycle',
    unit: '',
    source_aliases: [
      'switch lifecycle',
      'switch life',
      'switch durability',
      'click lifecycle',
      'rated clicks'
    ]
  },
  {
    key: 'switch_lifecycle_unit',
    label: 'Switch Lifecycle Unit',
    unit: '',
    source_aliases: []
  },
  {
    key: 'weight_g',
    label: 'Weight',
    unit: 'g',
    source_aliases: [
      'weight',
      'product weight',
      'mouse weight',
      'approximate weight'
    ]
  },
  {
    key: 'length_mm',
    label: 'Length',
    unit: 'mm',
    source_aliases: [
      'length',
      'product length',
      'dimensions length'
    ]
  },
  {
    key: 'width_mm',
    label: 'Width',
    unit: 'mm',
    source_aliases: [
      'width',
      'product width',
      'dimensions width'
    ]
  },
  {
    key: 'height_mm',
    label: 'Height',
    unit: 'mm',
    source_aliases: [
      'height',
      'product height',
      'dimensions height'
    ]
  },
  {
    key: 'battery_life_hours',
    label: 'Battery Life',
    unit: 'hours',
    source_aliases: [
      'battery life',
      'battery life (hours)',
      'battery duration',
      'maximum battery life'
    ]
  },
  {
    key: 'battery_life_conditions',
    label: 'Battery Life Conditions',
    unit: '',
    source_aliases: [
      'battery life conditions',
      'battery life at polling rate',
      'battery test conditions'
    ]
  },
  {
    key: 'onboard_memory',
    label: 'On-board Memory',
    unit: '',
    source_aliases: [
      'on-board memory',
      'onboard memory',
      'on-board memory profiles',
      'onboard profiles',
      'onboard memory profiles'
    ]
  },
  {
    key: 'software_requirement',
    label: 'Software Requirement',
    unit: '',
    source_aliases: [
      'software',
      'software requirement',
      'configuration software',
      'supported software'
    ]
  }
];


/**
 * Seed rules for Logitech and Razer gaming mice.
 *
 * These are configuration seeds, not claims that the current
 * production website parser has passed all tests.
 */
function getDefaultBrandExtractionRules_() {
  const commonNormalization = {
    preserve_raw_value: true,
    trim_whitespace: true,
    numeric_fields: 'Parse numeric value and unit separately when unambiguous',
    dpi: 'Normalize numeric DPI values; retain explicit minimum and maximum',
    polling_rate: 'Normalize to Hz; distinguish maximum rate from default rate',
    weight: 'Normalize to grams; retain edition and configuration context',
    dimensions: 'Normalize to millimeters only when source units are identifiable',
    battery: 'Store hours separately from test conditions and polling rate',
    booleans: 'Use Yes or No only when explicitly supported by the source',
    unknown_values: 'Leave blank; do not infer',
    variant_values: 'Preserve variant-specific values'
  };

  return [
    {
      rule_id: 'LOGITECH_MOUSE_V1',
      brand_id: 'LOGITECH',
      brand_name: 'Logitech',
      entity_type: 'product',
      product_category: 'mouse',
      official_domain: 'logitechg.com',
      product_url_pattern: 'https://www.logitechg.com/*/shop/p/*',
      source_type: 'official_product_page',
      fetch_method: 'UrlFetch',
      extraction_method: 'EMBEDDED_JSON',
      data_selector: 'inRiverTechSpecs; productDimensions',
      field_mapping_json: {
        sensor_name: [
          'Sensor',
          'Sensor Name',
          'Optical Sensor'
        ],
        dpi_min: [
          'Minimum DPI',
          'Min DPI',
          'Resolution Minimum'
        ],
        dpi_max: [
          'DPI',
          'Max DPI',
          'Maximum Resolution',
          'Resolution Maximum'
        ],
        max_speed_ips: [
          'Max Speed',
          'Maximum Speed',
          'Tracking Speed'
        ],
        max_acceleration_g: [
          'Max Acceleration',
          'Maximum Acceleration'
        ],
        max_polling_rate_hz: [
          'Polling Rate',
          'Maximum Polling Rate',
          'Report Rate'
        ],
        weight_g: [
          'Weight',
          'Product Weight',
          'Mouse Weight'
        ],
        length_mm: [
          'Length',
          'Product Length',
          'Dimensions Length'
        ],
        width_mm: [
          'Width',
          'Product Width',
          'Dimensions Width'
        ],
        height_mm: [
          'Height',
          'Product Height',
          'Dimensions Height'
        ],
        button_count: [
          'Buttons',
          'Number of Buttons',
          'Programmable Buttons'
        ],
        switch_type: [
          'Switch Type',
          'Switches',
          'Click Technology'
        ],
        switch_lifecycle: [
          'Switch Lifecycle',
          'Rated Clicks'
        ],
        battery_life_hours: [
          'Battery Life',
          'Battery Life (Hours)'
        ],
        battery_life_conditions: [
          'Battery Life Conditions'
        ],
        connection_type: [
          'Connection',
          'Connectivity',
          'Connection Type'
        ],
        wireless_technology: [
          'LIGHTSPEED',
          'Wireless Technology'
        ],
        wired_connection: [
          'Wired Connection',
          'USB Connection'
        ],
        bluetooth_support: [
          'Bluetooth',
          'Bluetooth Support'
        ],
        onboard_memory: [
          'Onboard Memory',
          'On-board Memory'
        ],
        software_requirement: [
          'Software',
          'Logitech G HUB'
        ]
      },
      normalization_rules_json: commonNormalization,
      variant_handling:
        'Keep separate records for distinct product models, colors, editions, SKUs, and hardware revisions when specifications differ. Never merge variants solely because their names are similar.',
      deduplication_rule:
        'Deduplicate by product_id + canonical specification key + source URL + variant/SKU. If duplicate source components disagree, retain the conflict for review instead of silently choosing one.',
      missing_value_policy:
        'Leave fields blank when the official source does not provide a value. Do not infer from marketing copy, other models, or third-party sources.',
      verification_rule:
        'Require an official Logitech G domain, a successfully fetched page, a recognized source structure, a mapped field, and a traceable source URL. Mark extracted values PENDING_REVIEW until field-level verification succeeds.',
      parser_function: 'parseLogitechSpecs_',
      rule_status: 'TESTING',
      notes:
        'Primary selectors: inRiverTechSpecs and productDimensions. The parser must support the actual payload structures encountered on the page; selector names alone do not guarantee extraction.',
      updated_at: ''
    },

    {
      rule_id: 'RAZER_MOUSE_V1',
      brand_id: 'RAZER',
      brand_name: 'Razer',
      entity_type: 'product',
      product_category: 'mouse',
      official_domain: 'razer.com',
      product_url_pattern: 'https://www.razer.com/*',
      source_type: 'official_product_page',
      fetch_method: 'UrlFetch',
      extraction_method: 'EMBEDDED_JSON',
      data_selector: 'mice-mice-specifications.features; featureValues; value',
      field_mapping_json: {
        sensor_name: [
          'Sensor',
          'Sensor Name',
          'Optical Sensor'
        ],
        dpi_min: [
          'Minimum DPI',
          'Min DPI',
          'Minimum Sensitivity'
        ],
        dpi_max: [
          'Max Sensitivity (DPI)',
          'Maximum DPI',
          'Max DPI',
          'Sensitivity'
        ],
        max_speed_ips: [
          'Max Speed (IPS)',
          'Maximum Speed',
          'Max Speed'
        ],
        max_acceleration_g: [
          'Max Acceleration (G)',
          'Maximum Acceleration',
          'Max Acceleration'
        ],
        max_polling_rate_hz: [
          'Polling Rate / Interval',
          'Polling Rate',
          'Maximum Polling Rate'
        ],
        button_count: [
          'Programmable Buttons',
          'Number of Buttons',
          'Buttons'
        ],
        switch_type: [
          'Switch Type',
          'Mouse Switches',
          'Optical Mouse Switches'
        ],
        switch_lifecycle: [
          'Switch Lifecycle',
          'Switch Life',
          'Rated Clicks'
        ],
        switch_lifecycle_unit: [],
        weight_g: [
          'Weight',
          'Product Weight',
          'Mouse Weight'
        ],
        length_mm: [
          'Size Length',
          'Length',
          'Dimensions Length'
        ],
        width_mm: [
          'Size Width',
          'Width',
          'Dimensions Width'
        ],
        height_mm: [
          'Size Height',
          'Height',
          'Dimensions Height'
        ],
        battery_life_hours: [
          'Battery Life',
          'Maximum Battery Life'
        ],
        battery_life_conditions: [
          'Battery Life Conditions'
        ],
        connection_type: [
          'Connectivity',
          'Connection',
          'Connectivity Technology'
        ],
        wireless_technology: [
          'Wireless Technology',
          'Razer HyperSpeed Wireless'
        ],
        wired_connection: [
          'Wired Connection',
          'USB Connection'
        ],
        bluetooth_support: [
          'Bluetooth',
          'Bluetooth Support'
        ],
        onboard_memory: [
          'On-board Memory Profiles',
          'Onboard Memory',
          'On-board Memory'
        ],
        software_requirement: [
          'Software',
          'Razer Synapse',
          'Software Requirement'
        ]
      },
      normalization_rules_json: Object.assign(
        {},
        commonNormalization,
        {
          dimensions:
            'Parse each dimension only when its label or documented order identifies the axis. Do not assume the order of a combined size string.',
          switch_lifecycle:
            'Separate click count from unit when unambiguous. Preserve the original text and never assume the unit.'
        }
      ),
      variant_handling:
        'Keep black, white, special editions, regional SKUs, and hardware revisions separate when official specifications differ. Do not choose one variant value as the universal product value.',
      deduplication_rule:
        'Prefer official specification component codes when available. Before deduplication, compare source component, canonical field, variant/SKU, and normalized value. Keep conflicting values for review.',
      missing_value_policy:
        'Leave fields blank when not explicitly available on the official page. Do not infer values from promotional descriptions or another Razer model.',
      verification_rule:
        'Require a verified razer.com product URL, successful fetch, recognized embedded specification component, a mapped feature value, and a traceable source URL. Mark extracted values PENDING_REVIEW until field-level verification succeeds.',
      parser_function: 'parseRazerSpecs_',
      rule_status: 'TESTING',
      notes:
        'Primary structure: mice-mice-specifications features and their featureValues/value content. The implementation must tolerate nested JSON and duplicate components.',
      updated_at: ''
    }
  ];
}


/**
 * Initialize or update Brand_Extraction_Rules.
 *
 * Safe behavior:
 * - Does not clear the sheet.
 * - Does not delete existing rules.
 * - Preserves existing custom columns.
 * - Updates the two seeded rules by rule_id.
 * - Keeps an existing rule_status if it is not blank.
 *
 * Run this function manually once from the Apps Script editor.
 */
function setupBrandExtractionRules() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(
    BRAND_RULES_CONFIG.SHEET_NAME
  );

  if (!sheet) {
    sheet = ss.insertSheet(
      BRAND_RULES_CONFIG.SHEET_NAME
    );
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  let headers = [];

  if (lastRow > 0 && lastCol > 0) {
    headers = sheet
      .getRange(1, 1, 1, lastCol)
      .getDisplayValues()[0]
      .map(h => String(h || '').trim());
  }

  if (!headers.some(Boolean)) {
    headers = BRAND_RULES_CONFIG.HEADERS.slice();
    sheet.getRange(1, 1, 1, headers.length)
      .setValues([headers]);
  } else {
    // Add missing canonical columns without deleting custom columns.
    BRAND_RULES_CONFIG.HEADERS.forEach(header => {
      if (!headers.includes(header)) {
        headers.push(header);
        sheet.getRange(1, headers.length).setValue(header);
      }
    });
  }

  const headerIndex = {};
  headers.forEach((header, index) => {
    if (header) headerIndex[header] = index;
  });

  const data = sheet.getLastRow() > 1
    ? sheet.getRange(
        2,
        1,
        sheet.getLastRow() - 1,
        headers.length
      ).getValues()
    : [];

  const ruleIdIndex = headerIndex.rule_id;
  if (ruleIdIndex === undefined) {
    throw new Error(
      'Brand_Extraction_Rules 缺少 rule_id 列'
    );
  }

  const existingRows = {};
  data.forEach((row, index) => {
    const id = String(row[ruleIdIndex] || '').trim();
    if (id) existingRows[id] = index;
  });

  const seeds = getDefaultBrandExtractionRules_();
  let inserted = 0;
  let updated = 0;

  seeds.forEach(seed => {
    const row = new Array(headers.length).fill('');

    // Build seed row using header names, not fixed column positions.
    headers.forEach((header, index) => {
      if (Object.prototype.hasOwnProperty.call(seed, header)) {
        const value = seed[header];
        row[index] = value !== null && value !== undefined
          ? (typeof value === 'object'
              ? JSON.stringify(value)
              : value)
          : '';
      }
    });

    const existingIndex = existingRows[seed.rule_id];

    if (existingIndex === undefined) {
      data.push(row);
      inserted++;
      existingRows[seed.rule_id] = data.length - 1;
      return;
    }

    const existingRow = data[existingIndex];

    // Update seed-owned configuration fields while preserving
    // the existing status if the user has already changed it.
    headers.forEach((header, index) => {
      if (!Object.prototype.hasOwnProperty.call(seed, header)) {
        return;
      }

      if (header === 'rule_status') {
        const oldStatus = String(
          existingRow[index] || ''
        ).trim();

        if (oldStatus) {
          row[index] = oldStatus;
        }
      }

      if (header === 'updated_at') {
        row[index] = new Date();
      }

      existingRow[index] = row[index];
    });

    updated++;
  });

  // Write rows back without clearing existing custom data.
  if (data.length) {
    sheet.getRange(
      2, 1, data.length, headers.length
    ).setValues(data);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold');

  return {
    success: true,
    sheet: BRAND_RULES_CONFIG.SHEET_NAME,
    version: BRAND_RULES_CONFIG.VERSION,
    inserted: inserted,
    updated: updated,
    total_rules: data.length,
    headers: headers
  };
}


/**
 * Read all extraction rules.
 *
 * JSON fields are returned as JavaScript objects when valid.
 * Invalid JSON is preserved as raw text and flagged for validation.
 */
function getBrandExtractionRules() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(
    BRAND_RULES_CONFIG.SHEET_NAME
  );

  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getDisplayValues();
  const headers = values[0].map(h => String(h || '').trim());

  return values.slice(1)
    .filter(row => row.some(value => String(value || '').trim()))
    .map(row => {
      const rule = {};

      headers.forEach((header, index) => {
        if (!header) return;
        rule[header] = row[index];
      });

      [
        'field_mapping_json',
        'normalization_rules_json'
      ].forEach(key => {
        rule[key] = parseRuleJson_(rule[key], key);
      });

      return rule;
    });
}


/**
 * Get one rule by its unique rule_id.
 */
function getBrandExtractionRuleById(ruleId) {
  const id = String(ruleId || '').trim();
  if (!id) return null;

  const rules = getBrandExtractionRules();

  return rules.find(rule =>
    String(rule.rule_id || '').trim() === id
  ) || null;
}


/**
 * Find a rule using brand, category, and optional product URL.
 *
 * Matching preference:
 * 1. Brand + category + official domain
 * 2. Brand + category
 *
 * Only ACTIVE rules are returned by default.
 * Set options.includeInactive=true to include testing rules.
 */
function getBrandExtractionRuleForProduct(
  brand,
  category,
  url,
  options
) {
  options = options || {};

  const brandNorm = normalizeRuleText_(brand);
  const categoryNorm = normalizeRuleText_(category);
  const urlHost = getRuleUrlHost_(url);

  const rules = getBrandExtractionRules().filter(rule => {
    const status = String(rule.rule_status || '')
      .trim()
      .toUpperCase();

    if (!options.includeInactive && status !== 'ACTIVE') {
      return false;
    }

    const ruleBrand = normalizeRuleText_(rule.brand_name);
    const ruleCategory = normalizeRuleText_(
      rule.product_category || rule.entity_type
    );

    const brandMatches =
      brandNorm &&
      (ruleBrand === brandNorm ||
       normalizeRuleText_(rule.brand_id) === brandNorm);

    const categoryMatches =
      !categoryNorm ||
      ruleCategory === categoryNorm;

    if (!brandMatches || !categoryMatches) return false;

    if (!urlHost) return true;

    return isOfficialDomainMatch_(
      urlHost,
      rule.official_domain
    );
  });

  if (!rules.length) return null;

  // Prefer the narrowest matching official domain.
  rules.sort((a, b) =>
    String(b.official_domain || '').length -
    String(a.official_domain || '').length
  );

  return rules[0];
}


/**
 * Find the best rule using the URL alone.
 *
 * Only ACTIVE rules are returned unless includeInactive=true.
 */
function matchBrandExtractionRuleByUrl(url, options) {
  options = options || {};

  const host = getRuleUrlHost_(url);
  if (!host) return null;

  const rules = getBrandExtractionRules()
    .filter(rule => {
      const status = String(rule.rule_status || '')
        .trim()
        .toUpperCase();

      if (!options.includeInactive && status !== 'ACTIVE') {
        return false;
      }

      return isOfficialDomainMatch_(
        host,
        rule.official_domain
      );
    })
    .sort((a, b) =>
      String(b.official_domain || '').length -
      String(a.official_domain || '').length
    );

  return rules.length ? rules[0] : null;
}


/**
 * Validate rule configuration and JSON fields.
 *
 * This validates configuration only; it does not fetch any website.
 */
function validateBrandExtractionRules() {
  const rules = getBrandExtractionRules();
  const issues = [];

  const requiredFields = [
    'rule_id',
    'brand_name',
    'product_category',
    'official_domain',
    'product_url_pattern',
    'fetch_method',
    'extraction_method',
    'field_mapping_json',
    'missing_value_policy',
    'rule_status'
  ];

  const seenIds = {};

  rules.forEach((rule, index) => {
    const rowNumber = index + 2;
    const id = String(rule.rule_id || '').trim();

    if (!id) {
      issues.push({
        row: rowNumber,
        field: 'rule_id',
        issue: 'Missing rule_id'
      });
    } else if (seenIds[id]) {
      issues.push({
        row: rowNumber,
        field: 'rule_id',
        issue: 'Duplicate rule_id: ' + id
      });
    } else {
      seenIds[id] = true;
    }

    requiredFields.forEach(field => {
      if (
        rule[field] === null ||
        rule[field] === undefined ||
        String(rule[field]).trim() === ''
      ) {
        issues.push({
          row: rowNumber,
          field: field,
          issue: 'Required field is blank'
        });
      }
    });

    [
      'field_mapping_json',
      'normalization_rules_json'
    ].forEach(field => {
      if (rule[field] && rule[field].__invalidJson) {
        issues.push({
          row: rowNumber,
          field: field,
          issue: rule[field].__invalidJson
        });
      }
    });

    const status = String(rule.rule_status || '')
      .trim()
      .toUpperCase();

    if (
      status &&
      !['ACTIVE', 'TESTING', 'DISABLED'].includes(status)
    ) {
      issues.push({
        row: rowNumber,
        field: 'rule_status',
        issue: 'Use ACTIVE, TESTING, or DISABLED'
      });
    }

    if (
      rule.official_domain &&
      /^(https?:\/\/|www\.)/i.test(
        String(rule.official_domain).trim()
      )
    ) {
      issues.push({
        row: rowNumber,
        field: 'official_domain',
        issue: 'Store hostname only, e.g. logitechg.com'
      });
    }
  });

  return {
    success: issues.length === 0,
    total_rules: rules.length,
    issue_count: issues.length,
    issues: issues
  };
}


/**
 * Parse a JSON cell.
 * Returns an object when valid.
 * Invalid JSON is flagged instead of silently discarded.
 */
function parseRuleJson_(value, fieldName) {
  if (value === null || value === undefined) return {};

  if (typeof value === 'object') return value;

  const text = String(value).trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (err) {
    return {
      __invalidJson:
        'Invalid JSON in ' + fieldName + ': ' +
        String(err.message || err)
    };
  }
}


/**
 * Normalize a brand/category string for comparisons.
 */
function normalizeRuleText_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}


/**
 * Extract hostname from a URL.
 * Supports URLs with or without an explicit protocol.
 */
function getRuleUrlHost_(url) {
  let value = String(url || '').trim();
  if (!value) return '';

  if (!/^https?:\/\//i.test(value)) {
    value = 'https://' + value;
  }

  const match = value.match(
    /^https?:\/\/([^/?#]+)/i
  );

  if (!match) return '';

  return match[1]
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}


/**
 * Strict domain comparison.
 *
 * logitechg.com matches www.logitechg.com and
 * subdomain.logitechg.com, but not logitechg.com.example.org.
 */
function isOfficialDomainMatch_(host, configuredDomain) {
  const domain = String(configuredDomain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

  if (!host || !domain) return false;

  const normalizedHost = String(host)
    .toLowerCase()
    .replace(/^www\./, '');

  return normalizedHost === domain ||
    normalizedHost.endsWith('.' + domain);
}


/**
 * Check whether a product URL matches a rule's path pattern.
 *
 * Supported wildcards:
 *   * = any sequence of characters
 *
 * Domain validation is performed separately and strictly.
 */
function productUrlMatchesRule_(url, rule) {
  const host = getRuleUrlHost_(url);

  if (!host || !isOfficialDomainMatch_(
    host,
    rule.official_domain
  )) {
    return false;
  }

  const pattern = String(
    rule.product_url_pattern || ''
  ).trim();

  if (!pattern) return true;

  const urlValue = String(url || '').trim();

  const escapedPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  try {
    return new RegExp(
      '^' + escapedPattern + '$',
      'i'
    ).test(urlValue);
  } catch (err) {
    return false;
  }
}


/**
 * Return canonical specification field definitions.
 * Useful for parsers and validation code.
 */
function getCanonicalMouseSpecFields_() {
  return BRAND_SPEC_FIELD_DEFINITIONS.map(field => ({
    key: field.key,
    label: field.label,
    unit: field.unit,
    source_aliases: field.source_aliases.slice()
  }));
}

function testBrandRuleMatching() {
  const tests = [
    {
      brand: 'Logitech',
      category: 'mouse',
      url: 'https://www.logitechg.com/en-us/shop/p/pro-x-superlight-2-dex.910-007328.html'
    },
    {
      brand: 'Razer',
      category: 'mouse',
      url: 'https://www.razer.com/gaming-mice/razer-viper-v4-pro'
    }
  ];

  const results = tests.map(test => {
    const rule = getBrandExtractionRuleForProduct(
      test.brand,
      test.category,
      test.url,
      { includeInactive: true }
    );

    return {
      brand: test.brand,
      matched: !!rule,
      rule_id: rule ? rule.rule_id : '',
      parser_function: rule ? rule.parser_function : '',
      rule_status: rule ? rule.rule_status : ''
    };
  });

  Logger.log(JSON.stringify(results, null, 2));
  return results;
}
