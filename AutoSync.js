/* ============================================================
 * AutoSync.gs — 自动续跑修正版
 *
 * 功能：
 * 1. ProcessedFiles 按真实表头名称读写，兼容列顺序不同
 * 2. progress 兼容 JSON 数组、双重编码 JSON 和可恢复的旧格式
 * 3. 断点读取失败时记录原始值，避免静默丢失诊断信息
 * 4. 文件变化时不沿用旧断点
 * 5. 批次失败时保留此前成功完成的断点
 * 6. 单次任务按约 4 分钟主动停止，并安排自动续跑
 * 7. 任务开始前先安排续跑保险，避免只有在任务结束时才创建触发器
 * 8. 全部完成后清理多余的续跑触发器
 * 9. 不清空、不重建任何数据库工作表
 *
 * 注意：
 * - 本文件不定义 buildDedupSets_()；该函数属于 Pipeline.gs。
 * - autoSync() 会扫描 CONFIG 中配置的所有监控文件。
 * - 本文件不包含 runIssue14()，请统一通过 autoSync() 同步。
 * ============================================================ */


/* ============================================================
 * 1. 文件扫描
 * ============================================================ */

function isSupportedDriveFile_(file) {
  const name = String(file.getName() || '').toLowerCase();
  const mime = String(file.getMimeType() || '').toLowerCase();
  return (
    name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt') ||
    name.endsWith('.csv') || name.endsWith('.json') || name.endsWith('.html') ||
    mime === 'application/vnd.google-apps.document' ||
    mime === 'application/vnd.google-apps.spreadsheet' ||
    mime === 'application/vnd.google-apps.presentation' ||
    mime === 'application/pdf' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword'
  );
}

function collectWatchedFiles_() {
  const files = [];
  const seen = new Set();

  function push_(file) {
    if (!file) return;
    const id = String(file.getId());
    if (seen.has(id)) return;
    seen.add(id);
    if (!isSupportedDriveFile_(file)) {
      Logger.log('暂不支持的文件格式，已记录并跳过：' + file.getName() + ' (' + file.getMimeType() + ')');
      return;
    }
    files.push(file);
  }

  (CONFIG.DRIVE_EXTRA_FILE_IDS || []).forEach(function(id) {
    const trimmed = String(id || '').trim();
    if (!trimmed) return;
    try { push_(DriveApp.getFileById(trimmed)); }
    catch (e) { Logger.log('无法访问指定文件 ' + trimmed + '：' + String(e)); }
  });

  if (CONFIG.DRIVE_FOLDER_ID) {
    try {
      collectFolderFiles_(DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID), push_);
    } catch (e) {
      throw new Error('无法扫描监控文件夹，请检查 DRIVE_FOLDER_ID 和授权：' + String(e));
    }
  }

  Logger.log('本次扫描到 ' + files.length + ' 个支持的文件。');
  return files;
}

function collectFolderFiles_(folder, pushFile) {
  const fileIterator = folder.getFiles();
  while (fileIterator.hasNext()) pushFile(fileIterator.next());
  const folderIterator = folder.getFolders();
  while (folderIterator.hasNext()) collectFolderFiles_(folderIterator.next(), pushFile);
}

/* ============================================================
 * 2. 文件读取与指纹
 * ============================================================ */

/**
 * 读取支持格式的全文。PDF/DOCX/Word 通过 Advanced Drive Service 临时转换为 Google Docs。
 * 首次使用 PDF/DOCX 前，需要在 Apps Script「服务」中启用 Drive API（Advanced Google service）。
 * 临时转换文件会在 finally 中删除，不会保留在用户 Drive 中。
 */
function readFileText_(file) {
  const mime = String(file.getMimeType() || '').toLowerCase();
  const name = String(file.getName() || '').toLowerCase();

  if (mime === 'application/vnd.google-apps.document') {
    return DocumentApp.openById(file.getId()).getBody().getText();
  }

  if (mime === 'application/vnd.google-apps.spreadsheet') {
    const ss = SpreadsheetApp.openById(file.getId());
    return ss.getSheets().map(function(sh) {
      const values = sh.getDataRange().getDisplayValues();
      return '【工作表：' + sh.getName() + '】\n' + values.map(function(row) {
        return row.map(function(cell) { return String(cell == null ? '' : cell); }).join('\t');
      }).join('\n');
    }).join('\n\n');
  }

  if (mime === 'application/vnd.google-apps.presentation') {
    const presentation = SlidesApp.openById(file.getId());
    return presentation.getSlides().map(function(slide, i) {
      const parts = slide.getPageElements().map(function(el) {
        try {
          if (el.getPageElementType() === SlidesApp.PageElementType.SHAPE) return el.asShape().getText().asString();
          if (el.getPageElementType() === SlidesApp.PageElementType.TABLE) {
            const table = el.asTable(); const rows = [];
            for (let r = 0; r < table.getNumRows(); r++) {
              const cells = [];
              for (let c = 0; c < table.getNumColumns(); c++) cells.push(table.getCell(r, c).getText().asString());
              rows.push(cells.join('\t'));
            }
            return rows.join('\n');
          }
        } catch (ignored) {}
        return '';
      }).filter(Boolean);
      return '【幻灯片 ' + (i + 1) + '】\n' + parts.join('\n');
    }).join('\n\n');
  }

  if (/\.(md|markdown|txt|csv|json|html)$/.test(name) || mime.indexOf('text/') === 0) {
    return file.getBlob().getDataAsString('UTF-8');
  }

  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
  const isWord = mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.doc') || name.endsWith('.docx');

  if (isPdf || isWord) return readConvertedOfficeFile_(file, isPdf);

  throw new Error('暂不支持的文件格式：' + file.getName() + ' (' + mime + ')');
}

function readConvertedOfficeFile_(file, isPdf) {
  if (typeof Drive === 'undefined' || !Drive.Files || !Drive.Files.create) {
    throw new Error('读取 PDF/DOCX 需要启用 Apps Script 高级 Google 服务中的 Drive API，并在关联的 Google Cloud 项目中启用 Drive API。文件：' + file.getName());
  }
  let tempId = '';
  try {
    const blob = file.getBlob();
    const resource = {
      name: '__TEMP_TEXT_EXTRACT_' + file.getName() + '_' + Date.now(),
      mimeType: 'application/vnd.google-apps.document'
    };
    const options = { fields: 'id,name,mimeType' };
    if (isPdf) options.ocrLanguage = 'zh-CN';
    const converted = Drive.Files.create(resource, blob, options);
    tempId = converted && converted.id ? converted.id : '';
    if (!tempId) throw new Error('Drive API 未返回临时转换文件 ID。');
    return DocumentApp.openById(tempId).getBody().getText();
  } catch (e) {
    throw new Error('全文提取失败：' + file.getName() + '；' + String(e));
  } finally {
    if (tempId) {
      try { Drive.Files.delete(tempId); }
      catch (cleanupError) { Logger.log('警告：无法删除临时转换文件 ' + tempId + '：' + String(cleanupError)); }
    }
  }
}

/** 使用 Drive 元数据形成版本指纹；文件修改时间变化时会重新处理。 */
function fingerprint_(file) {
  const parts = [
    String(file.getId() || ''),
    String(file.getName() || ''),
    String(file.getMimeType() || ''),
    String(file.getLastUpdated() ? file.getLastUpdated().getTime() : ''),
    String(file.getSize ? file.getSize() : '')
  ];
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, parts.join('|'))
    .map(function(b) { const v = (b + 256) % 256; return ('0' + v.toString(16)).slice(-2); })
    .join('');
}

/* ============================================================
 * 3. ProcessedFiles 表头与状态管理
 * ============================================================ */

/** 读取真实表头，不依赖 SHEET_DEFS 中定义的列顺序。 */
function getProcessedFilesHeaderMap_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sh = ss.getSheetByName('ProcessedFiles');

  if (!sh) {
    throw new Error(
      '找不到工作表 ProcessedFiles。请先检查工作表是否存在。'
    );
  }

  const lastCol = sh.getLastColumn();

  if (lastCol < 1) {
    throw new Error('ProcessedFiles 工作表没有表头。');
  }

  const headers = sh.getRange(1, 1, 1, lastCol)
    .getDisplayValues()[0]
    .map(function(h) {
      return String(h || '').trim().toLowerCase();
    });

  const map = {};

  headers.forEach(function(header, index) {
    if (header) map[header] = index;
  });

  const required = [
    'file_id',
    'file_name',
    'fingerprint',
    'issue_no',
    'status',
    'error',
    'processed_at',
    'progress'
  ];

  const missing = required.filter(function(name) {
    return map[name] === undefined;
  });

  if (missing.length) {
    throw new Error(
      'ProcessedFiles 缺少列：' + missing.join(', ') +
      '；当前表头：' + headers.join(', ')
    );
  }

  return {
    sheet: sh,
    headers: headers,
    col: map
  };
}


/** 按 file_id 查找记录。 */
function getProcessedFileRecord_(fileId) {
  const targetId = String(fileId || '').trim();
  if (!targetId) return null;

  const table = readTable('ProcessedFiles');

  return table.find(function(row) {
    return String(row.file_id || '').trim() === targetId;
  }) || null;
}


/**
 * 读取 progress。
 * 支持 JSON 数组、双重编码 JSON、可恢复的数组前缀。
 * 不会把任意非 JSON 文本猜测为已完成任务。
 */
function parseProgressValue_(value, fileName) {
  if (value === null || value === undefined || value === '') {
    return { keys: new Set(), valid: true, raw: '' };
  }

  let raw = String(value).trim();

  if (!raw) {
    return { keys: new Set(), valid: true, raw: raw };
  }

  function toKeySet_(parsed) {
    if (!Array.isArray(parsed)) return null;

    const keys = new Set();
    parsed.forEach(function(item) {
      if (typeof item === 'string' && item.trim()) {
        keys.add(item);
      }
    });
    return keys;
  }

  try {
    const parsed = JSON.parse(raw);
    let keys = toKeySet_(parsed);

    if (keys) {
      return { keys: keys, valid: true, raw: raw };
    }

    if (typeof parsed === 'string') {
      try {
        keys = toKeySet_(JSON.parse(parsed));
        if (keys) {
          return { keys: keys, valid: true, raw: raw };
        }
      } catch (ignored) {
        // 继续尝试恢复数组前缀。
      }
    }
  } catch (e) {
    // 继续尝试恢复数组前缀。
  }

  if (raw.charAt(0) === '[') {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charAt(i);

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
      } else if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;

        if (depth === 0) {
          const prefix = raw.slice(0, i + 1);
          try {
            const parsedPrefix = JSON.parse(prefix);
            const keys = toKeySet_(parsedPrefix);

            if (keys) {
              Logger.log(
                '已恢复 progress 数组前缀：' + fileName +
                '；忽略数组后的异常字符。'
              );
              return {
                keys: keys,
                valid: true,
                raw: raw,
                recovered: true
              };
            }
          } catch (ignored) {
            // 前缀也无效，继续走失败处理。
          }
          break;
        }
      }
    }
  }

  Logger.log(
    'progress 解析失败：' + (fileName || '未知文件') +
    '；原始值前 500 字符：' + raw.slice(0, 500)
  );

  return { keys: new Set(), valid: false, raw: raw };
}


/** 如果文件指纹不同，不沿用旧进度。 */
function loadProgress_(prev, fp) {
  if (
    !prev ||
    String(prev.fingerprint || '') !== String(fp || '')
  ) {
    return new Set();
  }

  const result = parseProgressValue_(prev.progress, prev.file_name);

  if (!result.valid) {
    Logger.log(
      '无法安全恢复断点；本次从头检查文件，但不会删除数据库记录。'
    );
  }

  return result.keys;
}


/** 按真实表头写入文件状态，不清空工作表。 */
function markFileProcessed_(
  file,
  fp,
  issueNo,
  status,
  error,
  doneKeys
) {
  const info = getProcessedFilesHeaderMap_();
  const sh = info.sheet;
  const col = info.col;
  const lastRow = sh.getLastRow();
  const fileId = String(file.getId());

  let targetRow = 0;

  if (lastRow >= 2) {
    const ids = sh.getRange(
      2,
      col.file_id + 1,
      lastRow - 1,
      1
    ).getDisplayValues().flat();

    const index = ids.findIndex(function(id) {
      return String(id).trim() === fileId;
    });

    if (index >= 0) targetRow = index + 2;
  }

  if (!targetRow) targetRow = Math.max(2, lastRow + 1);

  const keys = doneKeys instanceof Set
    ? Array.from(doneKeys)
    : Array.isArray(doneKeys)
      ? doneKeys
      : [];

  const row = new Array(info.headers.length).fill('');
  row[col.file_id] = fileId;
  row[col.file_name] = file.getName();
  row[col.fingerprint] = fp || '';
  row[col.issue_no] = issueNo || '';
  row[col.status] = status || '';
  row[col.error] = error ? String(error).slice(0, 1000) : '';
  row[col.processed_at] = new Date().toISOString();
  row[col.progress] = JSON.stringify(keys);

  sh.getRange(targetRow, 1, 1, row.length).setValues([row]);
}


/* ============================================================
 * 4. 单文件同步
 * ============================================================ */

function syncFileById(fileId) {
  const file = DriveApp.getFileById(fileId);
  const fp = fingerprint_(file);
  const prev = getProcessedFileRecord_(fileId);
  const doneKeys = loadProgress_(prev, fp);

  let stats;

  try {
    stats = processDriveFile_(file, {
      doneKeys: doneKeys,
      maxDocs: Math.max(1, Number(CONFIG.DOCS_PER_RUN) || 1)
    });
  } catch (e) {
    markFileProcessed_(
      file,
      fp,
      prev && prev.issue_no ? prev.issue_no : '',
      'error',
      String(e).slice(0, 1000),
      doneKeys
    );
    throw e;
  }

  if (!stats || !Number.isFinite(Number(stats.remaining))) {
    throw new Error(
      'processDriveFile_ 返回结果缺少有效的 remaining 字段。'
    );
  }

  const remaining = Number(stats.remaining);
  const hasErrors = Array.isArray(stats.errors) && stats.errors.length > 0;

  const status = remaining <= 0 && !hasErrors
    ? 'done'
    : hasErrors
      ? 'error'
      : 'processing';

  const errorText = hasErrors
    ? stats.errors.map(function(e) {
        return (e.title || '未命名内容') + ': ' + (e.error || '');
      }).join('\n')
    : '';

  markFileProcessed_(
    file,
    fp,
    stats.issue_no || (prev && prev.issue_no) || '',
    status,
    errorText,
    doneKeys
  );

  return stats;
}


/* ============================================================
 * 5. 自动同步入口
 * ============================================================ */

function autoSync() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    Logger.log('已有同步任务运行，本次跳过。');
    // 如果当前任务被锁阻挡，仍确保之后还有机会重试。
    scheduleAutoSyncContinuation_();
    return [{ status: 'skipped', reason: '已有同步任务运行中' }];
  }

  try {
    // 在开始扫描前先创建续跑保险，避免硬性超时前来不及创建触发器。
    scheduleAutoSyncContinuation_();
    return autoSyncLocked_();
  } finally {
    lock.releaseLock();
  }
}


function autoSyncLocked_() {
  const files = collectWatchedFiles_();
  const results = [];

  const MAX_ROUNDS_PER_FILE = 5;
  const MAX_RUN_MS = 4 * 60 * 1000;
  const startedAt = Date.now();

  let needsContinuation = false;
  let needsPageRebuild = false;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (Date.now() - startedAt >= MAX_RUN_MS) {
      needsContinuation = true;
      results.push({
        status: 'deferred',
        reason: '接近执行时间上限',
        remainingFiles: files.length - i
      });
      break;
    }

    const fileId = file.getId();
    const fileName = file.getName();
    const fp = fingerprint_(file);

    try {
      let prev = getProcessedFileRecord_(fileId);

      if (
        prev &&
        String(prev.status) === 'done' &&
        String(prev.fingerprint || '') === fp
      ) {
        Logger.log('跳过已完成且未变化的文件：' + fileName);
        results.push({ file: fileName, status: 'skipped', remaining: 0 });
        continue;
      }

      let rounds = 0;
      let finalStats = null;
      let stopReason = '';
      let madeProgress = false;
      let previousRemaining = null;

      for (let round = 1; round <= MAX_ROUNDS_PER_FILE; round++) {
        if (Date.now() - startedAt >= MAX_RUN_MS) {
          stopReason = '接近执行时间上限';
          needsContinuation = true;
          break;
        }

        const beforeRecord = getProcessedFileRecord_(fileId);
        const beforeCount = loadProgress_(beforeRecord, fp).size;

        Logger.log(
          '处理文件：' + fileName +
          '；批次 ' + round + '/' + MAX_ROUNDS_PER_FILE
        );

        finalStats = syncFileById(fileId);
        rounds = round;

        const remaining = Number(finalStats.remaining);
        if (!Number.isFinite(remaining)) {
          throw new Error('同步结果缺少有效 remaining 字段。');
        }

        const afterRecord = getProcessedFileRecord_(fileId);
        const afterCount = loadProgress_(afterRecord, fp).size;

        if (afterCount > beforeCount) {
          madeProgress = true;
          needsPageRebuild = true;
        }

        Logger.log(JSON.stringify({
          file: fileName,
          round: round,
          remaining: remaining,
          completedBefore: beforeCount,
          completedAfter: afterCount,
          docsDone: Number(finalStats.docs_done || 0),
          errors: (finalStats.errors || []).length
        }));

        if (remaining <= 0) {
          stopReason = '全部内容单元已完成';
          break;
        }

        if (
          previousRemaining !== null &&
          remaining >= previousRemaining &&
          afterCount <= beforeCount
        ) {
          stopReason = '连续批次没有进展，暂停本文件';
          break;
        }

        previousRemaining = remaining;

        if (
          Array.isArray(finalStats.errors) &&
          finalStats.errors.length > 0
        ) {
          stopReason = '本批存在失败单元，等待后续重试';
          break;
        }
      }

      prev = getProcessedFileRecord_(fileId);
      const remaining = finalStats ? Number(finalStats.remaining) : null;

      let status;
      if (
        remaining !== null &&
        remaining <= 0 &&
        prev &&
        prev.status === 'done'
      ) {
        status = 'done';
      } else if (prev && prev.status === 'error') {
        status = 'error';
      } else {
        status = 'processing';
      }

      results.push({
        file: fileName,
        status: status,
        rounds: rounds,
        remaining: remaining,
        progressed: madeProgress,
        reason: stopReason,
        errors: finalStats && finalStats.errors ? finalStats.errors : []
      });

      if (status !== 'done') needsContinuation = true;

    } catch (e) {
      Logger.log('文件处理失败：' + fileName + '\n' + String(e));

      try {
        const latest = getProcessedFileRecord_(fileId);
        const currentFp = fingerprint_(file);
        const doneKeys = loadProgress_(latest, currentFp);

        markFileProcessed_(
          file,
          currentFp,
          latest && latest.issue_no ? latest.issue_no : '',
          'error',
          String(e).slice(0, 1000),
          doneKeys
        );
      } catch (saveError) {
        Logger.log('保存错误状态失败：' + String(saveError));
      }

      needsContinuation = true;
      results.push({
        file: fileName,
        status: 'error',
        error: String(e).slice(0, 300)
      });
    }
  }

  if (needsPageRebuild) {
    try {
      const mergeLog = applyOpenTopicMerges_();
      Logger.log('Topic 合并裁决完成：' + JSON.stringify(mergeLog));
    } catch (e) {
      Logger.log('Topic 合并裁决失败：' + String(e));
    }

    try {
      const pageResult = rebuildProductPages_();
      Logger.log('产品页面重建完成：' + JSON.stringify(pageResult));
    } catch (e) {
      Logger.log('产品页面重建失败：' + String(e));
    }

    try {
      clearCache();
    } catch (e) {
      Logger.log('缓存清理失败：' + String(e));
    }
  }

  try {
    const queued = enqueueMissingSpecificationTasks_();
    Logger.log('规格任务入队完成：' + JSON.stringify(queued));
    if (hasConfiguredAIKey_()) {
      const specResult = processSpecificationTasks_(2);
      Logger.log('规格任务执行完成：' + JSON.stringify(specResult));
    }
  } catch (e) {
    Logger.log('规格任务入队/执行失败：' + String(e));
  }

  Logger.log('========== AutoSync 汇总 ==========');
  Logger.log(JSON.stringify(results, null, 2));

  if (needsContinuation) {
    scheduleAutoSyncContinuation_();
  } else {
    removeAutoSyncContinuationTriggers_();
  }

  return results;
}


/* ============================================================
 * 6. 自动续跑触发器
 * ============================================================ */

function scheduleAutoSyncContinuation_() {
  const handler = 'autoSyncContinuation';

  const exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });

  if (exists) {
    Logger.log('已有自动续跑触发器。');
    return;
  }

  ScriptApp.newTrigger(handler)
    .timeBased()
    .after(60 * 1000)
    .create();

  Logger.log('已安排约一分钟后的自动续跑。');
}


function removeAutoSyncContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'autoSyncContinuation') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  Logger.log('已清理多余的自动续跑触发器。');
}


function autoSyncContinuation() {
  // 删除已经触发的续跑任务。
  removeAutoSyncContinuationTriggers_();

  // 先建立备用续跑。若锁被占用或执行再次超时，仍有机会恢复。
  scheduleAutoSyncContinuation_();

  return autoSync();
}


/* ============================================================
 * 7. 定时扫描触发器
 * ============================================================ */

function installAutoTrigger() {
  removeAutoTrigger();
  const hours = Number(CONFIG.AUTO_SYNC_HOURS) || 6;
  const allowed = [1, 2, 4, 6, 8, 12];
  const interval = allowed.indexOf(hours) >= 0 ? hours : 6;
  ScriptApp.newTrigger('autoSync').timeBased().everyHours(interval).create();
  return '已安装每 ' + interval + ' 小时扫描一次的自动同步触发器。注意：Apps Script 是定时轮询，不是毫秒级实时监听。';
}

function removeAutoTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    const handler = trigger.getHandlerFunction();

    if (
      handler === 'autoSync' ||
      handler === 'autoSyncContinuation'
    ) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  return '已移除 AutoSync 定时及续跑触发器。';
}


/* ============================================================
 * 8. 调试工具
 * ============================================================ */

/**
 * 只读检查 ProcessedFiles。
 * 不写入数据，不修改断点。
 */
function inspectProcessedFiles() {
  const info = getProcessedFilesHeaderMap_();
  const rows = readTable('ProcessedFiles');

  const result = rows.map(function(row) {
    const parsed = parseProgressValue_(row.progress, row.file_name);

    return {
      file_id: row.file_id,
      file_name: row.file_name,
      fingerprint: row.fingerprint,
      issue_no: row.issue_no,
      status: row.status,
      error: row.error,
      processed_at: row.processed_at,
      progress_raw: String(row.progress || '').slice(0, 500),
      progress_valid: parsed.valid,
      progress_count: parsed.keys.size
    };
  });

  Logger.log(JSON.stringify({
    headers: info.headers,
    records: result
  }, null, 2));

  return result;
}


function debugStatus() {
  if (typeof buildSyncStatus_ !== 'function') {
    throw new Error('项目中找不到 buildSyncStatus_()。');
  }

  const status = buildSyncStatus_();
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}
