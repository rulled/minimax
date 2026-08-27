// Состояние расширения
let extensionEnabled = false;

// Диагностический журнал (diag_log.js должен быть загружен первым — см. importScripts)
importScripts('diag_log.js');

// Глобальные ошибки service worker'а — в диагностический журнал.
self.addEventListener('error', (event) => {
  try {
    DiagLog.error('sw', 'Uncaught error', { message: event.message, filename: event.filename, lineno: event.lineno });
  } catch (_) {}
});
self.addEventListener('unhandledrejection', (event) => {
  try {
    DiagLog.error('sw', 'Unhandled rejection', { reason: event.reason?.message || String(event.reason) });
  } catch (_) {}
});

// "Бронь" для следующего скачивания (для новых DIV-кнопок без href)
let nextDownloadConfig = null;
const PRIME_TTL_MS = 120000;
let pendingNamedDownloads = [];
const REGULAR_SUBMISSION_LEDGER_KEY = 'regularSubmissionLedger';
let regularSubmissionLedgerQueue = Promise.resolve();
let longTextSubmissionQueue = Promise.resolve();

function queueRegularSubmissionLedger(operation) {
  const result = regularSubmissionLedgerQueue.then(operation);
  regularSubmissionLedgerQueue = result.catch(() => {});
  return result;
}

function queueLongTextSubmission(operation) {
  const result = longTextSubmissionQueue.then(operation);
  longTextSubmissionQueue = result.catch(() => {});
  return result;
}

async function getUnresolvedRegularSubmissions() {
  const data = await chrome.storage.local.get(REGULAR_SUBMISSION_LEDGER_KEY);
  const ledger = Array.isArray(data[REGULAR_SUBMISSION_LEDGER_KEY]) ? data[REGULAR_SUBMISSION_LEDGER_KEY] : [];
  return ledger.filter((entry) => entry && entry.completedAt == null);
}

async function saveRegularSubmission(entry) {
  const unresolved = await getUnresolvedRegularSubmissions();
  const next = unresolved.filter((item) => item.submissionId !== entry.submissionId);
  next.push(entry);
  await chrome.storage.local.set({ [REGULAR_SUBMISSION_LEDGER_KEY]: next });
}

async function completeRegularSubmission(submissionId) {
  const unresolved = await getUnresolvedRegularSubmissions();
  await chrome.storage.local.set({
    [REGULAR_SUBMISSION_LEDGER_KEY]: unresolved.filter((entry) => entry.submissionId !== submissionId)
  });
}

async function updateRegularSubmission(submissionId, changes, ownerTabId = null) {
  const unresolved = await getUnresolvedRegularSubmissions();
  const entry = unresolved.find((item) => item.submissionId === submissionId);
  if (!entry) throw new Error('regular_submission_not_found');
  if (ownerTabId != null && entry.ownerTabId !== ownerTabId) {
    throw new Error('regular_submission_owner_mismatch');
  }
  await saveRegularSubmission({ ...entry, ...changes });
}

async function resolveExistingRegularDownload(entry) {
  let item = null;
  if (entry.downloadId) {
    const items = await chrome.downloads.search({ id: entry.downloadId });
    item = Array.isArray(items) ? items[0] : null;
  } else if (entry.downloadIntent?.filename) {
    const intentTime = Number(entry.downloadIntent.createdAt || 0);
    const expectedSuffix = String(entry.downloadIntent.filename).replace(/\\/g, '/').toLowerCase();
    const extensionIndex = expectedSuffix.lastIndexOf('.');
    const expectedStem = extensionIndex >= 0 ? expectedSuffix.slice(0, extensionIndex) : expectedSuffix;
    const expectedExtension = extensionIndex >= 0 ? expectedSuffix.slice(extensionIndex) : '';
    const candidates = await chrome.downloads.search({
      startedAfter: new Date(Math.max(0, intentTime - 5000)).toISOString()
    });
    item = candidates.find((candidate) => {
      const filename = String(candidate.filename || '').replace(/\\/g, '/').toLowerCase();
      const suffixMatches = filename.endsWith(expectedSuffix)
        || (expectedExtension && new RegExp(
          `${expectedStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)${expectedExtension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
        ).test(filename));
      return suffixMatches && Number(new Date(candidate.startTime || 0)) >= intentTime - 5000;
    }) || null;
    if (item?.id) {
      await updateRegularSubmission(entry.submissionId, {
        downloadId: item.id,
        downloadStartedAt: Number(new Date(item.startTime || 0)) || intentTime
      });
    }
  }
  if (!entry.downloadId && !entry.downloadIntent) return false;
  if (!item || item.error || item.state === 'interrupted') return false;
  if (item.state !== 'complete') {
    throw new Error('regular_submission_download_in_progress');
  }
  await completeRegularSubmission(entry.submissionId);
  return true;
}

async function downloadReconciledRegularSubmission(entry, record) {
  if (!record?.audioUrl || Number(record.status) !== 0) return false;
  if (await resolveExistingRegularDownload(entry)) return true;
  const target = await buildDownloadTarget({
    voiceName: entry.speakerName || entry.voiceName || 'dictor',
    scriptName: entry.scriptName || null,
    forceIndex: entry.downloadIndex || null,
    speakerName: entry.speakerName || null,
    downloadLayout: entry.downloadLayout || null,
    sourceFileName: entry.sourceFileName || null,
    sourceFileBaseName: entry.sourceFileBaseName || null
  });
  const downloadIntent = { filename: target.newFilename, createdAt: Date.now() };
  await updateRegularSubmission(entry.submissionId, { downloadIntent });
  const downloadId = await chrome.downloads.download({
    url: record.audioUrl,
    filename: target.newFilename,
    conflictAction: 'uniquify',
    saveAs: false
  });
  await updateRegularSubmission(entry.submissionId, { downloadId, downloadStartedAt: Date.now() });
  const confirmation = await waitForDownloadConfirmation(downloadId);
  if (!confirmation.ok) throw new Error(confirmation.reason || 'reconciled_download_failed');
  await saveToDownloadHistory(target.folderName, target.newFilename, target.fileNumber);
  await completeRegularSubmission(entry.submissionId);
  return true;
}

async function reconcileRegularSubmissionLedger(tabId) {
  const unresolved = await getUnresolvedRegularSubmissions();
  if (unresolved.length === 0) return [];
  const response = await sendTabMessageWithTimeout(tabId, {
    action: 'queryLongTextHistory',
    timeout: 30000,
    tasks: unresolved.map((entry) => ({
      localId: entry.submissionId,
      text: entry.text,
      voiceId: entry.voiceId,
      voiceName: entry.voiceName,
      submittedAt: entry.submittedAt,
      excludedAudioIds: Array.isArray(entry.baselineAudioIds) ? entry.baselineAudioIds : []
    }))
  }, 30000);
  if (!response?.success) {
    throw new Error(response?.reason || 'regular_submission_history_reconciliation_failed');
  }
  const matchedIds = new Set();
  for (const match of response.matches || []) {
    const entry = unresolved.find((item) => item.submissionId === match.localId);
    if (entry && match.record) {
      matchedIds.add(entry.submissionId);
      await downloadReconciledRegularSubmission(entry, match.record);
    }
  }
  for (const entry of unresolved) {
    const expiredReservation = entry.phase === 'reserved'
      && !matchedIds.has(entry.submissionId)
      && Date.now() - Number(entry.submittedAt || 0) > 2 * 60 * 1000;
    if (expiredReservation) await completeRegularSubmission(entry.submissionId);
  }
  return getUnresolvedRegularSubmissions();
}

function reserveNamedDownload(url, filename) {
  const reservation = { url, filename, createdAt: Date.now() };
  pendingNamedDownloads.push(reservation);
  return reservation;
}

function releaseNamedDownload(reservation) {
  pendingNamedDownloads = pendingNamedDownloads.filter((item) => item !== reservation);
}

// Загружаем состояние при старте
const extensionEnabledReady = chrome.storage.local.get('extensionEnabled').then((data) => {
  extensionEnabled = data.extensionEnabled !== false;
});

// Слушаем изменения состояния
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionEnabled) {
    extensionEnabled = changes.extensionEnabled.newValue;
  }
});

// Слушаем начало любого скачивания (для новых DIV-кнопок)
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!extensionEnabled) {
    suggest();
    return;
  }
  pendingNamedDownloads = pendingNamedDownloads.filter((reservation) => {
    return Date.now() - reservation.createdAt <= PRIME_TTL_MS;
  });
  const namedReservation = pendingNamedDownloads.find((reservation) => reservation.url === item.url);
  if (namedReservation) {
    releaseNamedDownload(namedReservation);
    suggest({ filename: namedReservation.filename, conflictAction: 'uniquify' });
    return;
  }
  if (nextDownloadConfig) {
    console.log('[Background] onDeterminingFilename item:', { url: item.url, tabId: item.tabId, filename: item.filename });
    const isExpired = Date.now() - nextDownloadConfig.createdAt > PRIME_TTL_MS;
    if (isExpired) {
      console.log('[Background] Prime expired, skipping rename');
      nextDownloadConfig = null;
      suggest();
      return;
    }
    const primedTabId = nextDownloadConfig.tabId;
    const itemTabId = typeof item.tabId === 'number' ? item.tabId : null;
    const hasKnownPrimedTab = typeof primedTabId === 'number' && primedTabId >= 0;
    const hasKnownItemTab = typeof itemTabId === 'number' && itemTabId >= 0;
    if (hasKnownPrimedTab && hasKnownItemTab && itemTabId !== primedTabId) {
      console.log('[Background] Prime tab mismatch, keeping reservation for target tab', { primedTabId, itemTabId });
      suggest();
      return;
    }

    const isBlobUrl = typeof item.url === 'string' && item.url.startsWith('blob:');
    const isBlobMp3 = isBlobUrl && typeof item.filename === 'string' && item.filename.toLowerCase().endsWith('.mp3');
    const isDataAudio = typeof item.url === 'string' && item.url.startsWith('data:audio/');
    if (!item.url || (!isValidAudioUrl(item.url) && !isBlobMp3 && !isDataAudio)) {
      console.log('[Background] Prime active but download is not a valid audio url, skipping rename');
      suggest();
      return;
    }
        const { folderName, fileNamePrefix, fileNumber, downloadLayout } = nextDownloadConfig;
        const isPackageLayout = downloadLayout === 'package';
        const paddedNumber = String(fileNumber).padStart(isPackageLayout ? 3 : 4, '0');
        const newFilename = isPackageLayout
          ? `${folderName}/${paddedNumber}__${fileNamePrefix}.mp3`
          : `${folderName}/${paddedNumber}_${fileNamePrefix}.mp3`;
    
    console.log(`[Background] Реноме по "брони": ${newFilename}`);
    
    suggest({
      filename: newFilename,
      conflictAction: 'uniquify'
    });
    
    saveToDownloadHistory(folderName, newFilename, fileNumber);
    nextDownloadConfig = null; // Сбрасываем бронь
    return;
  }
  suggest();
});

// Валидация URL для MP3 файлов
function isValidAudioUrl(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'https:') return false;
    if (!urlObj.pathname.endsWith('.mp3')) return false;

    const validDomains = ['cdn.hailuoai.video', 'hailuoai.com', 'minimax.io'];
    const hostname = urlObj.hostname.toLowerCase();
    if (!validDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return false;

    return true;
  } catch (error) {
    return false;
  }
}

// Санитизация имени файла
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, '_')  // Заменяем пробелы на подчеркивания
    .slice(0, 100);
}

async function buildDownloadTarget({ voiceName, scriptName, forceIndex, speakerName, downloadLayout, sourceFileName, sourceFileBaseName }) {
  const sanitizedVoice = sanitizeFilename(voiceName || 'dictor');
  const sanitizedScript = scriptName ? sanitizeFilename(scriptName) : null;
  const sanitizedSpeaker = speakerName ? sanitizeFilename(speakerName) : sanitizedVoice;
  const rawSourceBase = sourceFileBaseName || (sourceFileName ? String(sourceFileName).replace(/\.[^.]+$/, '') : '');
  const sanitizedSourceBase = rawSourceBase ? sanitizeFilename(rawSourceBase) : null;
  const normalizedLayout = String(downloadLayout || '').trim().toLowerCase();

  let folderName;
  let fileNamePrefix;
  let padLength = 4;

  if (normalizedLayout === 'package') {
    folderName = sanitizedScript || sanitizedSpeaker || sanitizedVoice;
    fileNamePrefix = [sanitizedSourceBase, sanitizedSpeaker || sanitizedVoice].filter(Boolean).join('__')
      || sanitizedSpeaker || sanitizedVoice || sanitizedScript || 'dictor';
    padLength = 3;
  } else {
    folderName = sanitizedScript ? `${sanitizedScript} - ${sanitizedSpeaker}` : sanitizedSpeaker;
    fileNamePrefix = sanitizedScript ? `${sanitizedScript} - ${sanitizedSpeaker}` : sanitizedSpeaker;
  }

  let fileNumber = forceIndex;
  if (!fileNumber) {
    fileNumber = await getNextFileNumber(folderName);
  }

  await ensureFileCounterAtLeast(folderName, fileNumber);

  return {
    folderName,
    fileNamePrefix,
    fileNumber,
    downloadLayout: normalizedLayout || 'default',
    newFilename: normalizedLayout === 'package'
      ? `${folderName}/${String(fileNumber).padStart(padLength, '0')}__${fileNamePrefix}.mp3`
      : `${folderName}/${String(fileNumber).padStart(padLength, '0')}_${fileNamePrefix}.mp3`
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDownloadConfirmation(downloadId, timeoutMs = 60000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = Array.isArray(items) ? items[0] : null;

    if (item) {
      if (item.error || item.state === 'interrupted') {
        return {
          ok: false,
          reason: item.error || 'download_interrupted'
        };
      }

      if (item.state === 'complete') {
        return {
          ok: true,
          state: item.state,
          filename: item.filename || null
        };
      }
    }

    await sleep(250);
  }

  return {
    ok: false,
    reason: 'download_confirmation_timeout'
  };
}

let fileCountersLock = Promise.resolve();

function withFileCountersLock(task) {
  const run = fileCountersLock.then(task, task);
  fileCountersLock = run.catch(() => {});
  return run;
}

// Получаем следующий номер для файла
async function getNextFileNumber(voiceName) {
  return withFileCountersLock(async () => {
    const data = await chrome.storage.local.get('fileCounters');
    const counters = data.fileCounters || {};
    const currentCount = counters[voiceName] || 0;
    const nextCount = currentCount + 1;

    counters[voiceName] = nextCount;
    await chrome.storage.local.set({ fileCounters: counters });

    return nextCount;
  });
}

// Гарантируем, что счётчик не меньше заданного значения
async function ensureFileCounterAtLeast(voiceName, value) {
  return withFileCountersLock(async () => {
    const data = await chrome.storage.local.get('fileCounters');
    const counters = data.fileCounters || {};
    const currentCount = counters[voiceName] || 0;
    if (value > currentCount) {
      counters[voiceName] = value;
      await chrome.storage.local.set({ fileCounters: counters });
    }
  });
}

let downloadHistoryLock = Promise.resolve();

// Сохраняем в историю
async function saveToDownloadHistory(voiceName, filename, fileNumber) {
  const save = downloadHistoryLock.then(async () => {
    const data = await chrome.storage.local.get('downloadHistory');
    let history = data.downloadHistory || [];

    history.push({
      voiceName,
      filename,
      fileNumber,
      timestamp: Date.now()
    });

    if (history.length > 100) history = history.slice(-100);
    await chrome.storage.local.set({ downloadHistory: history });
  });
  downloadHistoryLock = save.catch(() => {});
  return save;
}

// ============================================
// STATE MANAGEMENT
// ============================================

function getDefaultAutomationState() {
  return {
    parsedEntries: null,
    selectedSpeaker: null,
    fileName: null,
    voiceMappings: {},
    excludedIds: [],
    multiExcludedIds: [],
    mode: 'single',
    loadedAt: null,
    progress: {
      currentIndex: 0,
      isRunning: false,
      isPaused: false,
      completedIds: []
    },
    // Сохранение пропущенных текстов (>5k символов)
    skippedEntries: [],
    skippedEntriesMulti: []
  };
}

let automationState = null;
let automationStateReady = null;

function getSkippedEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const scriptName = (entry.scriptName || '').trim();
  const speaker = (entry.speaker || '').trim();
  const speakerIndex = Number.isFinite(Number(entry.speakerIndex)) ? String(Number(entry.speakerIndex)) : '';
  const id = (entry.id || '').trim();
  return [scriptName, speaker, speakerIndex, id].join('::');
}

async function initAutomationState() {
  const data = await chrome.storage.local.get('automationState');
  automationState = data.automationState || getDefaultAutomationState();
}

function ensureAutomationState() {
  if (!automationState) {
    automationState = getDefaultAutomationState();
  }
}

async function ensureAutomationStateLoaded() {
  if (automationState !== null) return;
  if (!automationStateReady) {
    automationStateReady = initAutomationState().catch((error) => {
      console.error('[Background] Error loading automation state:', error);
      automationState = getDefaultAutomationState();
    });
  }
  await automationStateReady;
}

async function saveAutomationState(newState) {
  ensureAutomationState();
  automationState = { ...automationState, ...newState };
  await chrome.storage.local.set({ automationState });
  chrome.runtime.sendMessage({
    action: 'automationStateUpdated',
    state: automationState
  }).catch(() => {});
}

async function clearAutomationState() {
  ensureAutomationState();
  automationState = getDefaultAutomationState();
  await chrome.storage.local.set({ automationState });
}

automationStateReady = initAutomationState().catch((error) => {
  console.error('[Background] Error initializing automation state:', error);
  automationState = getDefaultAutomationState();
});

// Обработчик сообщений
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      await ensureAutomationStateLoaded();

      if (request.action === "getAutomationState") {
        sendResponse({ success: true, state: automationState });
        return;
      }

      if (request.action === "getTabVoiceName") {
        const tabId = sender.tab?.id ? String(sender.tab.id) : 'fallback-tab';
        const data = await chrome.storage.local.get('tabVoices');
        const tabVoices = data.tabVoices || {};
        const voiceName = tabVoices[tabId] || 'dictor';
        sendResponse({ success: true, voiceName });
        return;
      }

      if (request.action === "saveAutomationData") {
        await saveAutomationState({
          ...request,
          loadedAt: Date.now()
        });
        sendResponse({ success: true });
        return;
      }

      if (request.action === "updateAutomationProgress") {
        if (request.runId) {
          sendResponse({ success: true });
          return;
        }
        await saveAutomationState({
          progress: { ...(automationState.progress || {}), ...request.progress }
        });
        sendResponse({ success: true });
        return;
      }

      if (request.action === "clearAutomationState") {
        if (request.runId) {
          sendResponse({ success: true });
          return;
        }
        await clearAutomationState();
        sendResponse({ success: true });
        return;
      }

      if (request.action === "markSkippedAsCompleted") {
        const key = request.mode === 'multi' ? 'skippedEntriesMulti' : 'skippedEntries';
        const entries = automationState[key] || [];
        const targetKey = (request.entryKey || '').trim();
        
        const updatedEntries = entries.map(e => {
          const entryKey = getSkippedEntryKey(e);
          const byKey = targetKey && entryKey === targetKey;
          const byLegacyId = !targetKey && e.id === request.entryId;
          if ((byKey || byLegacyId) && !e.completed) {
            console.log(`[Background] Manually marking skipped entry as completed: ${e.fullFileName}`);
            return { ...e, completed: true, completedAt: Date.now() };
          }
          return e;
        });
        
        await saveAutomationState({ [key]: updatedEntries });
        
        // Проверяем, все ли записи выполнены
        const allCompleted = updatedEntries.every(e => e.completed);
        
        sendResponse({ success: true, allCompleted });
        
        // Отправляем уведомление в popup
        chrome.runtime.sendMessage({
          action: 'skippedEntryCompleted',
          mode: request.mode,
          entries: updatedEntries,
          allCompleted: allCompleted
        }).catch(() => {});
        
        return;
      }

      if (request.action === "downloadFile") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }

        const url = request.url;
        if (!isValidAudioUrl(url)) {
          sendResponse({ success: false, reason: 'invalid-url' });
          return;
        }

        const tabId = sender.tab?.id ? String(sender.tab.id) : 'fallback-tab';
        const data = await chrome.storage.local.get('tabVoices');
        const tabVoices = data.tabVoices || {};

        // Определяем имя папки/файла
        let voiceName;

        // Если автоматизация передала имя спикера (Мульти-режим)
        if (request.forceSpeaker) {
            voiceName = request.forceSpeaker;
        } else {
            // Иначе берем из настроек вкладки
            voiceName = tabVoices[tabId] || 'dictor';
        }

        const target = await buildDownloadTarget({
          voiceName,
          scriptName: request.scriptName || null,
          forceIndex: request.forceIndex || null,
          speakerName: request.forceSpeaker || null,
          downloadLayout: request.downloadLayout || null,
          sourceFileName: request.sourceFileName || null,
          sourceFileBaseName: request.sourceFileBaseName || null
        });

        console.log(`Скачиваем как ${target.newFilename}`);

        const submissionId = String(request.submissionId || '');

        const namedReservation = reserveNamedDownload(url, target.newFilename);
        if (submissionId) {
          await queueRegularSubmissionLedger(() => updateRegularSubmission(submissionId, {
            downloadIntent: { filename: target.newFilename, createdAt: Date.now() }
          }, sender.tab?.id));
        }
        chrome.downloads.download({
          url: url,
          filename: target.newFilename,
          conflictAction: 'uniquify',
          saveAs: false
        }, async (downloadId) => {
          if (chrome.runtime.lastError) {
            releaseNamedDownload(namedReservation);
            console.error('Ошибка скачивания:', chrome.runtime.lastError);
            sendResponse({ success: false, reason: chrome.runtime.lastError.message });
          } else {
            if (submissionId) {
              try {
                await queueRegularSubmissionLedger(() => updateRegularSubmission(submissionId, {
                  downloadId,
                  downloadStartedAt: Date.now()
                }, sender.tab?.id));
              } catch (error) {
                sendResponse({ success: false, reason: error.message, downloadId });
                return;
              }
            }
            const confirmResult = await waitForDownloadConfirmation(downloadId);
            if (!confirmResult.ok) {
              sendResponse({ success: false, reason: confirmResult.reason, downloadId });
              return;
            }

            await saveToDownloadHistory(target.folderName, target.newFilename, target.fileNumber);
            if (submissionId) {
              await queueRegularSubmissionLedger(() => completeRegularSubmission(submissionId));
            }
            sendResponse({
              success: true,
              downloadId,
              fileNumber: target.fileNumber,
              state: confirmResult.state,
              filename: confirmResult.filename
            });
          }
        });

      } else if (request.action === "downloadAudioData") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }

        if (typeof request.dataUrl !== 'string' || !request.dataUrl.startsWith('data:audio/')) {
          sendResponse({ success: false, reason: 'invalid-data-url' });
          return;
        }

        const target = await buildDownloadTarget({
          voiceName: request.voiceName,
          scriptName: request.scriptName || null,
          forceIndex: request.forceIndex || null,
          speakerName: request.speakerName || null,
          downloadLayout: request.downloadLayout || null,
          sourceFileName: request.sourceFileName || null,
          sourceFileBaseName: request.sourceFileBaseName || null
        });

        console.log(`Скачиваем audio data как ${target.newFilename}`);

        const submissionId = String(request.submissionId || '');

        const namedReservation = reserveNamedDownload(request.dataUrl, target.newFilename);
        if (submissionId) {
          await queueRegularSubmissionLedger(() => updateRegularSubmission(submissionId, {
            downloadIntent: { filename: target.newFilename, createdAt: Date.now() }
          }, sender.tab?.id));
        }
        chrome.downloads.download({
          url: request.dataUrl,
          filename: target.newFilename,
          conflictAction: 'uniquify',
          saveAs: false
        }, async (downloadId) => {
          if (chrome.runtime.lastError) {
            releaseNamedDownload(namedReservation);
            console.error('Ошибка скачивания data url:', chrome.runtime.lastError);
            sendResponse({ success: false, reason: chrome.runtime.lastError.message });
          } else {
            if (submissionId) {
              try {
                await queueRegularSubmissionLedger(() => updateRegularSubmission(submissionId, {
                  downloadId,
                  downloadStartedAt: Date.now()
                }, sender.tab?.id));
              } catch (error) {
                sendResponse({ success: false, reason: error.message, downloadId });
                return;
              }
            }
            const confirmResult = await waitForDownloadConfirmation(downloadId);
            if (!confirmResult.ok) {
              sendResponse({ success: false, reason: confirmResult.reason, downloadId });
              return;
            }

            await saveToDownloadHistory(target.folderName, target.newFilename, target.fileNumber);
            if (submissionId) {
              await queueRegularSubmissionLedger(() => completeRegularSubmission(submissionId));
            }
            sendResponse({
              success: true,
              downloadId,
              fileNumber: target.fileNumber,
              state: confirmResult.state,
              filename: confirmResult.filename
            });
          }
        });

      } else if (request.action === "updateExtensionState") {
        extensionEnabled = request.enabled;
        sendResponse({ success: true });

      } else if (request.action === "getHistory") {
        const data = await chrome.storage.local.get('downloadHistory');
        sendResponse({ success: true, history: data.downloadHistory || [] });

      } else if (request.action === "clearHistory") {
        await chrome.storage.local.set({ downloadHistory: [] });
        sendResponse({ success: true });

      } else if (request.action === "saveSkippedEntries") {
        // Сохранение пропущенных записей
        const key = request.mode === 'multi' ? 'skippedEntriesMulti' : 'skippedEntries';
        const currentEntries = Array.isArray(automationState[key]) ? automationState[key] : [];
        const incomingEntries = Array.isArray(request.entries) ? request.entries : [];

        if (incomingEntries.length === 0) {
          await saveAutomationState({ [key]: [] });
          sendResponse({ success: true });
          return;
        }

        const merged = new Map();
        currentEntries.forEach((entry) => merged.set(getSkippedEntryKey(entry), entry));
        incomingEntries.forEach((entry) => {
          const keyValue = getSkippedEntryKey(entry);
          const prev = merged.get(keyValue);
          merged.set(keyValue, prev ? { ...prev, ...entry } : entry);
        });

        await saveAutomationState({ [key]: Array.from(merged.values()) });
        sendResponse({ success: true });
      } else if (request.action === "getSkippedEntries") {
        // Получение пропущенных записей
        const key = request.mode === 'multi' ? 'skippedEntriesMulti' : 'skippedEntries';
        const entries = (automationState[key] || []).map((entry) => ({
          ...entry,
          entryKey: getSkippedEntryKey(entry)
        }));
        sendResponse({ success: true, entries });
      } else if (request.action === "primeNextDownload") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }
        // "Бронируем" имя файла для следующего скачивания (для DIV-кнопок без href)
        const { voiceName, scriptName, forceIndex, speakerName } = request;
        const target = await buildDownloadTarget({
          voiceName,
          scriptName,
          forceIndex,
          speakerName,
          downloadLayout: request.downloadLayout || null
        });
        
        nextDownloadConfig = {
            folderName: target.folderName,
            fileNamePrefix: target.fileNamePrefix,
            fileNumber: target.fileNumber,
            downloadLayout: target.downloadLayout,
            tabId: sender.tab?.id ?? null,
            createdAt: Date.now()
        };
        
        console.log(`[Background] Primed next download: ${target.folderName}/${target.fileNumber}`);
        sendResponse({ success: true, fileNumber: target.fileNumber });
      } else if (request.action === "executeInMainWorld") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }
        const tabId = sender.tab?.id;
        if (!tabId) {
          sendResponse({ success: false, reason: 'no tab id' });
          return;
        }

        // Все функции для MAIN world определены здесь.
        // Функции не могут передаваться через sendMessage — Chrome не сериализует их.
        // Поэтому передаём имя метода (request.method), а функцию берём из этого словаря.
        const slateFunctions = {
          getText: function() {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return '';
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return '';
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor || !editor.children) return '';
            return editor.children.map(function(n) {
              return (n.children || []).map(function(c) { return c.text || ''; }).join('');
            }).join('').trim();
          },

          selectAll: function() {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return false;
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return false;
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor || !editor.children || editor.children.length === 0) return false;
            var lastP = editor.children[editor.children.length - 1];
            var lastT = lastP.children[lastP.children.length - 1];
            editor.selection = {
              anchor: { path: [0, 0], offset: 0 },
              focus: { path: [editor.children.length - 1, lastP.children.length - 1], offset: (lastT.text || '').length }
            };
            return true;
          },

          insertText: function(text) {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return { ok: false, reason: 'no element' };
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return { ok: false, reason: 'no fiberKey' };
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor) return { ok: false, reason: 'no editor in fiber' };

            var currentText = editor.children.map(function(n) {
              return (n.children || []).map(function(c) { return c.text || ''; }).join('');
            }).join('').trim();

            if (currentText.length > 0) {
              var lastP = editor.children[editor.children.length - 1];
              var lastT = lastP.children[lastP.children.length - 1];
              editor.selection = {
                anchor: { path: [0, 0], offset: 0 },
                focus: { path: [editor.children.length - 1, lastP.children.length - 1], offset: (lastT.text || '').length }
              };
            }

            el.focus();

            var ev = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: text
            });
            el.dispatchEvent(ev);
            return { ok: true };
          },

          clearTextContent: function() {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return { ok: false, reason: 'no element' };
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return { ok: false, reason: 'no fiberKey' };
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor || !editor.children || editor.children.length === 0) {
              return { ok: false, reason: 'no editor' };
            }

            var lastP = editor.children[editor.children.length - 1];
            var lastT = lastP.children[lastP.children.length - 1];
            editor.selection = {
              anchor: { path: [0, 0], offset: 0 },
              focus: { path: [editor.children.length - 1, lastP.children.length - 1], offset: (lastT.text || '').length }
            };
            el.focus();
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'deleteContentBackward',
              data: null
            }));
            return { ok: true };
          },

          listMyVoices: async function() {
            var webpackRequire = null;
            window.webpackChunk_N_E = window.webpackChunk_N_E || [];
            window.webpackChunk_N_E.push([['minimax-voice-list-' + Date.now()], {}, function(require) {
              webpackRequire = require;
            }]);
            if (!webpackRequire?.m) return { ok: false, reason: 'minimax_api_runtime_missing' };

            var moduleId = Object.keys(webpackRequire.m).find(function(id) {
              return String(webpackRequire.m[id]).indexOf('/v1/api/audio/voice/list') >= 0;
            });
            if (!moduleId) return { ok: false, reason: 'minimax_voice_api_missing' };
            var api = webpackRequire(moduleId);
            var listVoices = Object.values(api).find(function(value) {
              return typeof value === 'function'
                && String(value).indexOf('/v1/api/audio/voice/list') >= 0;
            });
            if (!listVoices) return { ok: false, reason: 'minimax_voice_api_export_missing' };

            var voices = [];
            var page = 1;
            var hasMore = true;
            try {
              while (hasMore && page <= 100) {
                var payload = await listVoices({
                  is_system: false,
                  is_collect: false,
                  page: page,
                  page_size: 30,
                  filter: [],
                  user_language: document.documentElement.lang || 'en'
                });
                if (!payload || !Array.isArray(payload.voice_list) || typeof payload.has_more !== 'boolean') {
                  return { ok: false, reason: 'voice_list_response_invalid' };
                }
                if (payload.has_more && payload.voice_list.length === 0) {
                  return { ok: false, reason: 'voice_list_pagination_incomplete' };
                }
                for (var index = 0; index < payload.voice_list.length; index += 1) {
                  var voice = payload.voice_list[index];
                  var createTime = Number(voice?.create_time);
                  var generateChannel = Number(voice?.generate_channel);
                  var voiceStatus = Number(voice?.voice_status);
                  if (!voice || typeof voice !== 'object'
                    || !String(voice.voice_id || '').trim()
                    || !String(voice.voice_name || '').trim()
                    || !Number.isFinite(createTime)
                    || !Number.isFinite(generateChannel)
                    || !Number.isFinite(voiceStatus)) {
                    return { ok: false, reason: 'voice_list_record_invalid' };
                  }
                  voices.push({
                    voiceId: String(voice.voice_id).trim(),
                    voiceName: String(voice.voice_name).trim(),
                    createTime: createTime,
                    generateChannel: generateChannel,
                    voiceStatus: voiceStatus
                  });
                }
                hasMore = payload.has_more;
                page += 1;
              }
            } catch (error) {
              return { ok: false, reason: error?.message || 'voice_list_request_failed' };
            }
            if (hasMore) return { ok: false, reason: 'voice_list_pagination_incomplete' };
            return { ok: true, voices: voices };
          },

          getGenerationCredit: async function(requestedCharacters) {
            var webpackRequire = null;
            window.webpackChunk_N_E = window.webpackChunk_N_E || [];
            window.webpackChunk_N_E.push([['minimax-credit-' + Date.now()], {}, function(require) {
              webpackRequire = require;
            }]);
            if (!webpackRequire?.m) return { ok: false, reason: 'minimax_api_runtime_missing' };

            var creditModuleId = Object.keys(webpackRequire.m).find(function(id) {
              return String(webpackRequire.m[id]).indexOf('/v1/api/audio/billing/credit') >= 0;
            });
            if (!creditModuleId) return { ok: false, reason: 'minimax_credit_api_missing' };
            var creditModule = webpackRequire(creditModuleId);
            var getCredit = Object.values(creditModule).find(function(value) {
              return typeof value === 'function'
                && String(value).indexOf('/v1/api/audio/billing/credit') >= 0;
            });
            if (!getCredit) return { ok: false, reason: 'minimax_credit_api_export_missing' };

            try {
              var credit = await getCredit({ scene: 1, coin_type: 0, biz_line: 1 });
              var storeModule = webpackRequire.m['66021'] ? webpackRequire('66021') : null;
              var state = storeModule?.store?.getState?.();
              var selectedModelId = state?.global?.constantsMap?.selectedModel;
              var selectedModel = state?.global?.modelOptions?.find(function(model) {
                return model?.value === selectedModelId;
              });
              var totalCredit = Number(credit?.total_credit);
              var creditRatio = Number(selectedModel?.creditRatio);
              var characterCount = Math.max(0, Number(requestedCharacters) || 0);
              if (!selectedModelId || !selectedModel
                || !Number.isFinite(totalCredit)
                || !Number.isFinite(creditRatio)
                || creditRatio <= 0) {
                return { ok: false, reason: 'minimax_credit_response_invalid' };
              }
              var requiredCredit = Math.ceil(characterCount * creditRatio);
              return {
                ok: true,
                totalCredit: totalCredit,
                creditRatio: creditRatio,
                requiredCredit: requiredCredit,
                affordableCharacters: Math.floor(totalCredit / creditRatio),
                requestedCharacters: characterCount,
                sufficient: requiredCredit <= totalCredit,
                selectedModel: String(selectedModelId || '')
              };
            } catch (error) {
              return { ok: false, reason: error?.message || 'minimax_credit_request_failed' };
            }
          },

          getDirectTtsCapability: function() {
            var webpackRequire = window.__mmWebpackRequire;
            if (!webpackRequire) {
              window.webpackChunk_N_E = window.webpackChunk_N_E || [];
              window.webpackChunk_N_E.push([['minimax-direct-probe'], {}, function(require) {
                webpackRequire = require;
              }]);
              window.__mmWebpackRequire = webpackRequire || null;
            }
            if (!webpackRequire?.m) return { ok: false, reason: 'minimax_api_runtime_missing' };
            var managerModuleId = webpackRequire.m['78544'] ? '78544' : Object.keys(webpackRequire.m).find(function(id) {
              return String(webpackRequire.m[id]).indexOf('/v1/api/audio/ws') >= 0;
            });
            if (!managerModuleId) return { ok: false, reason: 'minimax_tts_manager_missing' };
            var managerModule = webpackRequire(managerModuleId);
            var manager = Object.values(managerModule).find(function(value) {
              return value && typeof value.initWebSocket === 'function'
                && typeof value.close === 'function';
            });
            var storeModule = webpackRequire.m['66021'] ? webpackRequire('66021') : null;
            var state = storeModule?.store?.getState?.();
            var settings = state?.tts?.settings;
            var effects = state?.voice?.effects;
            var model = String(state?.global?.constantsMap?.selectedModel || '');
            var voiceId = String(settings?.voice_id || '');
            var language = String(state?.detect?.isDetecting
              ? state?.detect?.detectedLanguage || ''
              : settings?.language_boost || '');
            var format = String(settings?.format || 'mp3').toLowerCase();
            if (!manager || !state || !settings || !effects) {
              return { ok: false, reason: 'minimax_tts_runtime_incomplete' };
            }
            if (!model || !voiceId) {
              return { ok: false, reason: 'minimax_direct_settings_incomplete' };
            }
            if (format !== 'mp3') return { ok: false, reason: 'minimax_direct_format_unsupported' };
            return {
              ok: true,
              managerModuleId: String(managerModuleId),
              model,
              voiceId,
              language,
              format
            };
          },

          getDirectTtsReadyState: function(expectedText, expectedVoiceId, expectedLanguage) {
            var webpackRequire = window.__mmWebpackRequire;
            if (!webpackRequire) {
              window.webpackChunk_N_E = window.webpackChunk_N_E || [];
              window.webpackChunk_N_E.push([['minimax-direct-ready'], {}, function(require) {
                webpackRequire = require;
              }]);
              window.__mmWebpackRequire = webpackRequire || null;
            }
            var storeModule = webpackRequire?.m?.['66021'] ? webpackRequire('66021') : null;
            var state = storeModule?.store?.getState?.();
            var text = String(state?.tts?.currentText || '');
            var settings = state?.tts?.settings;
            var language = state?.detect?.isDetecting
              ? state?.detect?.detectedLanguage
              : settings?.language_boost;
            var normalizedExpectedLanguage = String(expectedLanguage || '').trim().toLowerCase();
            // Когда авто-детект активен (isDetecting=true), принимаем любое состояние языка:
            // сайт сам определит язык при отправке кадра. Это предотвращает таймаут,
            // когда detectedLanguage остаётся пустым/"Auto" для коротких текстов.
            var isAutoDetecting = state?.detect?.isDetecting === true;
            var languageMatches = !normalizedExpectedLanguage
              || isAutoDetecting
              || (normalizedExpectedLanguage === 'auto'
                ? isAutoDetecting
                : String(language || '').trim().toLowerCase() === normalizedExpectedLanguage);
            var languageReady = isAutoDetecting
              || (normalizedExpectedLanguage === 'auto'
                ? isAutoDetecting
                : Boolean(String(language || '')));
            var effects = state?.voice?.effects;
            var signature = JSON.stringify({
              model: String(state?.global?.constantsMap?.selectedModel || ''),
              voiceSetting: {
                speed: settings?.speed,
                vol: settings?.vol,
                pitch: settings?.pitch,
                voiceId: String(settings?.voice_id || '')
              },
              audioSetting: {
                sampleRate: settings?.sample_rate,
                bitrate: settings?.bitrate,
                format: settings?.format,
                channel: settings?.channel
              },
              effects: effects,
              erWeights: Array.isArray(settings?.timber_weights) ? settings.timber_weights : [],
              language: String(language || '')
            });
            return {
              ok: Boolean(state && settings && text && text === String(expectedText || '')
                && String(state.global?.constantsMap?.selectedModel || '')
                && String(settings.voice_id || '')
                && (!expectedVoiceId || String(settings.voice_id || '') === String(expectedVoiceId))
                && languageReady
                && languageMatches),
              textMatches: text === String(expectedText || ''),
              model: String(state?.global?.constantsMap?.selectedModel || ''),
              voiceId: String(settings?.voice_id || ''),
              language: String(language || ''),
              languageMatches: languageMatches,
              isDetecting: state?.detect?.isDetecting === true,
              signature: signature
            };
          },

          submitDirectLongText: async function(expectedText, expectedSignature, expectedVoiceId, requestedTimeout) {
            var webpackRequire = window.__mmWebpackRequire;
            if (!webpackRequire) {
              window.webpackChunk_N_E = window.webpackChunk_N_E || [];
              window.webpackChunk_N_E.push([['minimax-direct-long'], {}, function(require) {
                webpackRequire = require;
              }]);
              window.__mmWebpackRequire = webpackRequire || null;
            }
            if (!webpackRequire?.m) return { ok: false, disposition: 'not_sent', reason: 'minimax_api_runtime_missing' };
            var managerModuleId = webpackRequire.m['78544'] ? '78544' : Object.keys(webpackRequire.m).find(function(id) {
              return String(webpackRequire.m[id]).indexOf('/v1/api/audio/ws') >= 0;
            });
            var managerModule = managerModuleId ? webpackRequire(managerModuleId) : null;
            var manager = managerModule && Object.values(managerModule).find(function(value) {
              return value && typeof value.initWebSocket === 'function'
                && typeof value.close === 'function';
            });
            var storeModule = webpackRequire.m['66021'] ? webpackRequire('66021') : null;
            var state = storeModule?.store?.getState?.();
            var settings = state?.tts?.settings;
            var effects = state?.voice?.effects;
            var text = String(state?.tts?.currentText || '');
            if (!manager || !settings || !effects || !text || text !== String(expectedText || '')) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_state_mismatch' };
            }
            var model = String(state.global?.constantsMap?.selectedModel || '');
            var voiceId = String(settings.voice_id || '');
            if (!model || !voiceId) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_settings_incomplete' };
            }
            if (expectedVoiceId && voiceId !== String(expectedVoiceId)) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_voice_mismatch' };
            }
            var language = state.detect?.isDetecting ? state.detect?.detectedLanguage : settings.language_boost;
            var currentSignature = JSON.stringify({
              model: model,
              voiceSetting: { speed: settings.speed, vol: settings.vol, pitch: settings.pitch, voiceId: voiceId },
              audioSetting: {
                sampleRate: settings.sample_rate,
                bitrate: settings.bitrate,
                format: settings.format,
                channel: settings.channel
              },
              effects: effects,
              erWeights: Array.isArray(settings.timber_weights) ? settings.timber_weights : [],
              language: String(language || '')
            });
            if (!expectedSignature || currentSignature !== expectedSignature) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_settings_changed' };
            }
            var msgId = crypto.randomUUID();
            var wsKey = 'tts';
            var frame = {
              method: 'T2aAsync',
              payload: {
                model: model,
                text: text,
                voice_setting: {
                  speed: Number(settings.speed),
                  vol: Number(settings.vol),
                  pitch: Number(settings.pitch),
                  voice_id: voiceId
                },
                audio_setting: {
                  sample_rate: settings.sample_rate,
                  bitrate: settings.bitrate,
                  format: settings.format,
                  channel: settings.channel
                },
                effects: {
                  deepen_lighten: Number(effects.deepen_lighten || 0),
                  stronger_softer: Number(effects.stronger_softer || 0),
                  nasal_crisp: Number(effects.nasal_crisp || 0),
                  spacious_echo: Boolean(effects.spacious_echo),
                  lofi_telephone: Boolean(effects.lofi_telephone),
                  robotic: Boolean(effects.robotic),
                  auditorium_echo: Boolean(effects.auditorium_echo)
                },
                er_weights: Array.isArray(settings.timber_weights) ? settings.timber_weights : [],
                language_boost: language,
                stream: true
              },
              msg_id: msgId
            };
            return await new Promise(function(resolve) {
              var settled = false;
              var opened = false;
              var finish = function(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { manager.close(wsKey); } catch (error) {}
                resolve(result);
              };
              var timer = setTimeout(function() {
                finish(opened
                  ? { ok: false, disposition: 'accepted_unknown', reason: 'minimax_direct_response_timeout', msgId: msgId }
                  : { ok: false, disposition: 'not_sent', reason: 'minimax_direct_connect_timeout' });
              }, Math.max(1000, Number(requestedTimeout) || 15000));
              try {
                manager.close(wsKey);
                manager.initWebSocket({
                  url: '/v1/api/audio/ws',
                  body: frame,
                  wsKey: wsKey,
                  onOpen: function() { opened = true; },
                  onMessage: function(message) {
                    if (message?.method === 'Heartbeat') return;
                    var responseMeta = {
                      method: String(message?.method || ''),
                      keys: message && typeof message === 'object' ? Object.keys(message).sort() : [],
                      statusCode: message?.statusInfo?.code ?? message?.base_resp?.status_code ?? null,
                      dataKeys: message?.data && typeof message.data === 'object' ? Object.keys(message.data).sort() : [],
                      dataStatus: message?.data?.status ?? null,
                      inputSensitive: message?.input_sensitive === true
                    };
                    if (message?.input_sensitive) {
                      finish({ ok: false, disposition: 'rejected', reason: 'minimax_input_sensitive', msgId: msgId, responseMeta: responseMeta });
                      return;
                    }
                    var rawCode = message?.statusInfo?.code ?? message?.base_resp?.status_code;
                    var code = rawCode == null ? null : Number(rawCode);
                    if (code !== null && code !== 0) {
                      var rejectionReason = String(message?.statusInfo?.message || message?.base_resp?.status_msg || 'minimax_direct_rejected');
                      finish({
                        ok: false,
                        disposition: 'rejected',
                        reason: rejectionReason,
                        category: /credit|balance|quota|insufficient/i.test(rejectionReason)
                          ? 'insufficient_credit'
                          : 'server_rejected',
                        code: code,
                        msgId: msgId,
                        responseMeta: responseMeta
                      });
                      return;
                    }
                    if (message?.method === 'T2aAsync' && (code === null || code === 0)) {
                      finish({ ok: true, disposition: 'accepted', msgId: msgId, responseMeta: responseMeta });
                    }
                  },
                  onError: function(error) {
                    finish(opened
                      ? { ok: false, disposition: 'accepted_unknown', reason: String(error?.message || 'minimax_direct_socket_error'), msgId: msgId }
                      : { ok: false, disposition: 'not_sent', reason: String(error?.message || 'minimax_direct_socket_error') });
                  },
                  onClose: function() {
                    finish(opened
                      ? { ok: false, disposition: 'accepted_unknown', reason: 'minimax_direct_socket_closed', msgId: msgId }
                      : { ok: false, disposition: 'not_sent', reason: 'minimax_direct_socket_closed' });
                  }
                });
              } catch (error) {
                finish({ ok: false, disposition: 'not_sent', reason: error?.message || 'minimax_direct_init_failed' });
              }
            });
          },

          generateDirectAudio: async function(expectedText, expectedSignature, expectedVoiceId, requestedTimeout) {
            var webpackRequire = window.__mmWebpackRequire;
            if (!webpackRequire) {
              window.webpackChunk_N_E = window.webpackChunk_N_E || [];
              window.webpackChunk_N_E.push([['minimax-direct-regular'], {}, function(require) {
                webpackRequire = require;
              }]);
              window.__mmWebpackRequire = webpackRequire || null;
            }
            if (!webpackRequire?.m) return { ok: false, disposition: 'not_sent', reason: 'minimax_api_runtime_missing' };
            var managerModuleId = webpackRequire.m['78544'] ? '78544' : Object.keys(webpackRequire.m).find(function(id) {
              return String(webpackRequire.m[id]).indexOf('/v1/api/audio/ws') >= 0;
            });
            var managerModule = managerModuleId ? webpackRequire(managerModuleId) : null;
            var manager = managerModule && Object.values(managerModule).find(function(value) {
              return value && typeof value.initWebSocket === 'function'
                && typeof value.close === 'function';
            });
            var storeModule = webpackRequire.m['66021'] ? webpackRequire('66021') : null;
            var state = storeModule?.store?.getState?.();
            var settings = state?.tts?.settings;
            var effects = state?.voice?.effects;
            var text = String(state?.tts?.currentText || '');
            if (!manager || !settings || !effects || !text || text !== String(expectedText || '')) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_state_mismatch' };
            }
            var model = String(state.global?.constantsMap?.selectedModel || '');
            var voiceId = String(settings.voice_id || '');
            if (!model || !voiceId) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_settings_incomplete' };
            }
            if (expectedVoiceId && voiceId !== String(expectedVoiceId)) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_voice_mismatch' };
            }
            var requestedFormat = String(settings.format || 'mp3').toLowerCase();
            if (requestedFormat !== 'mp3') {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_format_unsupported' };
            }
            var language = state.detect?.isDetecting ? state.detect?.detectedLanguage : settings.language_boost;
            // SYNC:signature — mirrors computeStateSignature in direct_transport.js.
            // This block is duplicated in getDirectTtsReadyState, submitDirectLongText,
            // and generateDirectAudio. All three MUST stay byte-identical or the
            // transport functions return minimax_direct_settings_changed. Keep
            // effects bare (no `|| null`) — see computeStateSignature tests.
            var currentSignature = JSON.stringify({
              model: model,
              voiceSetting: { speed: settings.speed, vol: settings.vol, pitch: settings.pitch, voiceId: voiceId },
              audioSetting: {
                sampleRate: settings.sample_rate,
                bitrate: settings.bitrate,
                format: settings.format,
                channel: settings.channel
              },
              effects: effects,
              erWeights: Array.isArray(settings.timber_weights) ? settings.timber_weights : [],
              language: String(language || '')
            });
            if (!expectedSignature || currentSignature !== expectedSignature) {
              return { ok: false, disposition: 'not_sent', reason: 'minimax_direct_settings_changed' };
            }
            var msgId = crypto.randomUUID();
            var wsKey = 'tts';
            // SYNC:buildFrame — mirrors buildT2aAsyncFrame in direct_transport.js.
            var frame = {
              payload: {
                model: model,
                text: text,
                voice_setting: {
                  speed: Number(settings.speed),
                  vol: Number(settings.vol),
                  pitch: Number(settings.pitch),
                  voice_id: voiceId
                },
                audio_setting: {
                  sample_rate: settings.sample_rate,
                  bitrate: settings.bitrate,
                  format: settings.format,
                  channel: settings.channel
                },
                effects: {
                  deepen_lighten: Number(effects.deepen_lighten || 0),
                  stronger_softer: Number(effects.stronger_softer || 0),
                  nasal_crisp: Number(effects.nasal_crisp || 0),
                  spacious_echo: Boolean(effects.spacious_echo),
                  lofi_telephone: Boolean(effects.lofi_telephone),
                  robotic: Boolean(effects.robotic),
                  auditorium_echo: Boolean(effects.auditorium_echo)
                },
                er_weights: Array.isArray(settings.timber_weights) ? settings.timber_weights : [],
                language_boost: language,
                stream: true
              },
              msg_id: msgId
            };
            return await new Promise(function(resolve) {
              var settled = false;
              var opened = false;
              var audioHexChunks = [];
              var finish = function(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { manager.close(wsKey); } catch (error) {}
                resolve(result);
              };
              var timer = setTimeout(function() {
                finish(opened
                  ? { ok: false, disposition: 'accepted_unknown', reason: 'minimax_direct_generation_timeout', msgId: msgId }
                  : { ok: false, disposition: 'not_sent', reason: 'minimax_direct_connect_timeout' });
              }, Math.max(1000, Number(requestedTimeout) || 180000));
              try {
                manager.close(wsKey);
                manager.initWebSocket({
                  url: '/v1/api/audio/ws',
                  body: frame,
                  wsKey: wsKey,
                  onOpen: function() { opened = true; },
                  onMessage: function(message) {
                    if (message?.method === 'Heartbeat') return;
                    var responseMeta = {
                      method: String(message?.method || ''),
                      keys: message && typeof message === 'object' ? Object.keys(message).sort() : [],
                      statusCode: message?.statusInfo?.code ?? message?.base_resp?.status_code ?? null,
                      dataKeys: message?.data && typeof message.data === 'object' ? Object.keys(message.data).sort() : [],
                      dataStatus: message?.data?.status ?? null,
                      inputSensitive: message?.input_sensitive === true
                    };
                    if (message?.input_sensitive) {
                      finish({ ok: false, disposition: 'rejected', reason: 'minimax_input_sensitive', msgId: msgId, responseMeta: responseMeta });
                      return;
                    }
                    var rawCode = message?.statusInfo?.code ?? message?.base_resp?.status_code;
                    var code = rawCode == null ? null : Number(rawCode);
                    if (code !== null && code !== 0) {
                      finish({
                        ok: false,
                        disposition: 'rejected',
                        reason: String(message?.statusInfo?.message || message?.base_resp?.status_msg || 'minimax_direct_rejected'),
                        code: code,
                        msgId: msgId,
                        responseMeta: responseMeta
                      });
                      return;
                    }
                    var status = Number(message?.data?.status);
                    if (!message?.data || (status !== 1 && status !== 2)) return;
                    if (typeof message.data.audio === 'string' && message.data.audio) {
                      audioHexChunks.push(message.data.audio);
                    }
                    if (status !== 2) return;
                    var audioHex = audioHexChunks.join('');
                    // SYNC:hexDecode — mirrors decodeHexAudio in direct_transport.js.
                    // Update both and re-run tests/direct_transport.test.js if this changes.
                    if (!audioHex || audioHex.length % 2 !== 0) {
                      finish({ ok: false, disposition: 'accepted_unknown', reason: 'minimax_direct_audio_invalid', msgId: msgId, responseMeta: responseMeta });
                      return;
                    }
                    var hexTable = new Uint8Array(128);
                    for (var t = 0; t < 128; t += 1) hexTable[t] = 255;
                    '0123456789abcdefABCDEF'.split('').forEach(function(ch, idx) {
                      hexTable[ch.charCodeAt(0)] = idx < 16 ? idx : idx - 6;
                    });
                    var byteLen = audioHex.length / 2;
                    var bytes = new Uint8Array(byteLen);
                    var hexValid = true;
                    for (var index = 0; index < byteLen; index += 1) {
                      var hi = hexTable[audioHex.charCodeAt(index * 2)];
                      var lo = hexTable[audioHex.charCodeAt(index * 2 + 1)];
                      if (hi > 15 || lo > 15) { hexValid = false; break; }
                      bytes[index] = (hi << 4) | lo;
                    }
                    if (!hexValid) {
                      finish({ ok: false, disposition: 'accepted_unknown', reason: 'minimax_direct_audio_invalid', msgId: msgId, responseMeta: responseMeta });
                      return;
                    }
                    var audioOffset = 0;
                    if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
                      var id3Size = ((bytes[6] & 0x7f) << 21)
                        | ((bytes[7] & 0x7f) << 14)
                        | ((bytes[8] & 0x7f) << 7)
                        | (bytes[9] & 0x7f);
                      audioOffset = 10 + id3Size;
                    }
                    var hasMpegFrame = audioOffset + 1 < bytes.length
                      && bytes[audioOffset] === 0xff
                      && (bytes[audioOffset + 1] & 0xe0) === 0xe0;
                    if (bytes.length < 1024 || !hasMpegFrame) {
                      finish({ ok: false, disposition: 'accepted_unknown', reason: 'minimax_direct_mp3_invalid', msgId: msgId, responseMeta: responseMeta });
                      return;
                    }
                    var chunks = [];
                    for (var offset = 0; offset < bytes.length; offset += 0x8000) {
                      chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000)));
                    }
                    finish({
                      ok: true,
                      disposition: 'completed',
                      msgId: msgId,
                      size: bytes.length,
                      responseMeta: responseMeta,
                      dataUrl: 'data:audio/mpeg;base64,' + btoa(chunks.join(''))
                    });
                  },
                  onError: function(error) {
                    finish(opened
                      ? { ok: false, disposition: 'accepted_unknown', reason: String(error?.message || 'minimax_direct_socket_error'), msgId: msgId }
                      : { ok: false, disposition: 'not_sent', reason: String(error?.message || 'minimax_direct_socket_error') });
                  },
                  onClose: function() {
                    finish(opened
                      ? { ok: false, disposition: 'accepted_unknown', reason: 'minimax_direct_socket_closed', msgId: msgId }
                      : { ok: false, disposition: 'not_sent', reason: 'minimax_direct_socket_closed' });
                  }
                });
              } catch (error) {
                finish({ ok: false, disposition: 'not_sent', reason: error?.message || 'minimax_direct_init_failed' });
              }
            });
          },

          getVoiceCleanupPreview: async function(protectedVoiceNames, requestedCount, protectedVoiceIds) {
            var webpackRequire = null;
            window.webpackChunk_N_E = window.webpackChunk_N_E || [];
            window.webpackChunk_N_E.push([['minimax-voice-cleanup-' + Date.now()], {}, function(require) {
              webpackRequire = require;
            }]);
            if (!webpackRequire?.m) return { ok: false, reason: 'minimax_api_runtime_missing' };

            var moduleId = Object.keys(webpackRequire.m).find(function(id) {
              var source = String(webpackRequire.m[id]);
              return source.indexOf('/v1/api/audio/voice/list') >= 0
                && source.indexOf('/v1/api/audio/voice/equity') >= 0;
            });
            if (!moduleId) return { ok: false, reason: 'minimax_voice_api_missing' };
            var api = webpackRequire(moduleId);
            var findApi = function(path) {
              return Object.values(api).find(function(value) {
                return typeof value === 'function' && String(value).indexOf(path) >= 0;
              });
            };
            var listVoices = findApi('/v1/api/audio/voice/list');
            var getEquity = findApi('/v1/api/audio/voice/equity');
            if (!listVoices || !getEquity) return { ok: false, reason: 'minimax_voice_api_export_missing' };

            var normalize = function(value) {
              return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            };
            var protectedNames = new Set((Array.isArray(protectedVoiceNames) ? protectedVoiceNames : [])
              .map(normalize).filter(Boolean));
            var protectedIds = new Set((Array.isArray(protectedVoiceIds) ? protectedVoiceIds : [])
              .map(function(value) { return String(value || '').trim(); }).filter(Boolean));
            var voices = [];
            var page = 1;
            var hasMore = true;
            while (hasMore && page <= 100) {
              var payload = await listVoices({
                is_system: false,
                is_collect: false,
                page: page,
                page_size: 30,
                filter: [],
                user_language: document.documentElement.lang || 'en'
              });
              var items = Array.isArray(payload?.voice_list) ? payload.voice_list : [];
              voices.push.apply(voices, items);
              hasMore = Boolean(payload?.has_more);
              if (items.length === 0) break;
              page += 1;
            }
            if (hasMore) return { ok: false, reason: 'voice_list_too_large' };

            var count = Math.min(20, Math.max(1, Number(requestedCount) || 20));
            var eligible = voices.filter(function(voice) {
              return String(voice.voice_id || '').trim()
                && Number(voice.create_time) > 0
                && Number(voice.generate_channel) === 1
                && Number(voice.voice_status) === 2
                && !protectedIds.has(String(voice.voice_id || '').trim())
                && !protectedNames.has(normalize(voice.voice_name));
            }).sort(function(left, right) {
              return Number(left.create_time || 0) - Number(right.create_time || 0);
            });
            var candidates = eligible.slice(0, count).map(function(voice) {
              return {
                voiceId: String(voice.voice_id || ''),
                voiceName: String(voice.voice_name || ''),
                createTime: Number(voice.create_time || 0),
                generateChannel: Number(voice.generate_channel),
                voiceStatus: Number(voice.voice_status)
              };
            });
            var equity = await getEquity({});
            if (!Number.isFinite(Number(equity?.used)) || !Number.isFinite(Number(equity?.total))) {
              return { ok: false, reason: 'voice_equity_invalid' };
            }
            return {
              ok: true,
              candidates: candidates,
              protectedCount: voices.length - eligible.length,
              equity: {
                used: Number(equity?.used || 0),
                total: Number(equity?.total || 0)
              }
            };
          },

          deleteVoiceCleanupCandidates: async function(candidates, protectedVoiceNames, protectedVoiceIds) {
            var expected = Array.isArray(candidates) ? candidates.slice(0, 20) : [];
            if (expected.length === 0) return { ok: false, reason: 'voice_cleanup_candidates_missing' };
            var webpackRequire = null;
            window.webpackChunk_N_E = window.webpackChunk_N_E || [];
            window.webpackChunk_N_E.push([['minimax-voice-delete-' + Date.now()], {}, function(require) {
              webpackRequire = require;
            }]);
            var moduleId = Object.keys(webpackRequire?.m || {}).find(function(id) {
              var source = String(webpackRequire.m[id]);
              return source.indexOf('/v1/api/audio/voice/list') >= 0
                && source.indexOf('/v1/api/audio/voice/delete') >= 0;
            });
            if (!moduleId) return { ok: false, reason: 'minimax_voice_delete_api_missing' };
            var api = webpackRequire(moduleId);
            var listVoices = Object.values(api).find(function(value) {
              return typeof value === 'function'
                && String(value).indexOf('/v1/api/audio/voice/list') >= 0;
            });
            var deleteVoice = Object.values(api).find(function(value) {
              return typeof value === 'function'
                && String(value).indexOf('/v1/api/audio/voice/delete') >= 0;
            });
            var getEquity = Object.values(api).find(function(value) {
              return typeof value === 'function'
                && String(value).indexOf('/v1/api/audio/voice/equity') >= 0;
            });
            if (!listVoices || !deleteVoice || !getEquity) {
              return { ok: false, reason: 'minimax_voice_delete_export_missing' };
            }

            var normalize = function(value) {
              return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            };
            var protectedNames = new Set((Array.isArray(protectedVoiceNames) ? protectedVoiceNames : [])
              .map(normalize).filter(Boolean));
            var protectedIds = new Set((Array.isArray(protectedVoiceIds) ? protectedVoiceIds : [])
              .map(function(value) { return String(value || '').trim(); }).filter(Boolean));
            var voices = [];
            var page = 1;
            var hasMore = true;
            while (hasMore && page <= 100) {
              var payload = await listVoices({
                is_system: false,
                is_collect: false,
                page: page,
                page_size: 30,
                filter: [],
                user_language: document.documentElement.lang || 'en'
              });
              var items = Array.isArray(payload?.voice_list) ? payload.voice_list : [];
              voices.push.apply(voices, items);
              hasMore = Boolean(payload?.has_more);
              if (items.length === 0) break;
              page += 1;
            }
            if (hasMore) return { ok: false, reason: 'voice_list_too_large' };
            var currentCandidates = voices.filter(function(voice) {
              return String(voice.voice_id || '').trim()
                && Number(voice.create_time) > 0
                && Number(voice.generate_channel) === 1
                && Number(voice.voice_status) === 2
                && !protectedIds.has(String(voice.voice_id || '').trim())
                && !protectedNames.has(normalize(voice.voice_name));
            }).sort(function(left, right) {
              return Number(left.create_time || 0) - Number(right.create_time || 0);
            }).slice(0, expected.length);
            var unchanged = expected.every(function(candidate, index) {
              var current = currentCandidates[index];
              return current
                && String(current.voice_id) === String(candidate.voiceId)
                && Number(current.create_time) === Number(candidate.createTime);
            });
            if (!unchanged) return { ok: false, reason: 'voice_cleanup_preview_changed' };

            var deleted = [];
            var failed = null;
            for (var index = 0; index < expected.length; index += 1) {
              var candidate = expected[index];
              try {
                var deleteResult = await deleteVoice({ voice_id: candidate.voiceId });
                if (deleteResult === null || deleteResult === undefined) {
                  throw new Error('voice_delete_response_missing');
                }
                if (deleteResult?.statusInfo && Number(deleteResult.statusInfo.code) !== 0) {
                  throw new Error(deleteResult.statusInfo.message || 'voice_delete_rejected');
                }
                deleted.push(candidate);
              } catch (error) {
                failed = { candidate: candidate, reason: error?.message || 'voice_delete_failed' };
                break;
              }
            }
            var equity = null;
            try {
              equity = await getEquity({});
              if (!Number.isFinite(Number(equity?.used)) || !Number.isFinite(Number(equity?.total))) {
                throw new Error('voice_equity_invalid');
              }
            } catch (error) {
              return {
                ok: false,
                reason: 'voice_equity_refresh_failed',
                deleted: deleted,
                failed: failed
              };
            }
            return {
              ok: !failed,
              reason: failed?.reason || '',
              deleted: deleted,
              failed: failed?.candidate || null,
              equity: {
                used: Number(equity?.used || 0),
                total: Number(equity?.total || 0)
              }
            };
          },

          ensureLongTextHistoryCapture: function() {
            if (window.__minimaxLongTextHistoryCapture?.installed) {
              return { ok: true, alreadyInstalled: true };
            }

            var originalOpen = XMLHttpRequest.prototype.open;
            var capture = {
              installed: true,
              snapshot: null,
              capturedAt: 0
            };

            XMLHttpRequest.prototype.open = function(method, url) {
              this.__minimaxHistoryUrl = String(url || '');
              if (!this.__minimaxHistoryHooked) {
                this.__minimaxHistoryHooked = true;
                this.addEventListener('load', function() {
                  if (String(this.__minimaxHistoryUrl || '').indexOf('/v1/api/audio/history_list') < 0) return;
                  try {
                    var payload = JSON.parse(this.responseText || '{}');
                    capture.snapshot = payload;
                    capture.capturedAt = Date.now();
                  } catch (error) {
                    console.warn('[MiniMax Long Text] History response parse failed:', error);
                  }
                });
              }
              return originalOpen.apply(this, arguments);
            };

            capture.reset = function() {
              this.snapshot = null;
              this.capturedAt = 0;
              return { ok: true };
            };
            window.__minimaxLongTextHistoryCapture = capture;
            return { ok: true, alreadyInstalled: false };
          },

          resetLongTextHistoryCapture: function() {
            var capture = window.__minimaxLongTextHistoryCapture;
            if (!capture?.installed || typeof capture.reset !== 'function') {
              return { ok: false, reason: 'history_capture_not_installed' };
            }
            return capture.reset();
          },

          consumeLongTextHistory: async function(tasks, timeout) {
            var requestedTasks = Array.isArray(tasks) ? tasks : [];
            var webpackRequire = null;
            var chunkName = 'minimax-history-' + Date.now();
            window.webpackChunk_N_E = window.webpackChunk_N_E || [];
            window.webpackChunk_N_E.push([[chunkName], {}, function(require) {
              webpackRequire = require;
            }]);
            if (!webpackRequire?.m) return { ok: false, reason: 'minimax_api_runtime_missing' };

            var apiModuleId = Object.keys(webpackRequire.m).find(function(moduleId) {
              return String(webpackRequire.m[moduleId]).indexOf('/v1/api/audio/history_list') >= 0;
            });
            if (!apiModuleId) return { ok: false, reason: 'minimax_history_api_missing' };

            var apiModule = webpackRequire(apiModuleId);
            var fetchHistoryPage = Object.values(apiModule).find(function(value) {
              return typeof value === 'function'
                && String(value).indexOf('/v1/api/audio/history_list') >= 0;
            });
            if (!fetchHistoryPage) return { ok: false, reason: 'minimax_history_api_export_missing' };

            var list = [];
            var page = 1;
            var pageSize = 50;
            var maxPages = 100;
            var hasMore = true;
            var pagesFetched = 0;
            var stoppedAfterMatch = false;
            var deadline = Date.now() + (Number(timeout) || 10000);
            var targetAudioIds = new Set(requestedTasks.map(function(task) {
              return String(task.audioId || '');
            }).filter(Boolean));
            var hasTextTargets = requestedTasks.some(function(task) {
              return !task.audioId && !!task.text;
            });
            var earliestSubmission = requestedTasks.reduce(function(earliest, task) {
              if (task.audioId || !task.submittedAt) return earliest;
              var submittedAt = Number(task.submittedAt);
              return !earliest || submittedAt < earliest ? submittedAt : earliest;
            }, 0);

            try {
              while (hasMore && page <= maxPages) {
                var remainingMs = deadline - Date.now();
                if (remainingMs <= 0) return { ok: false, reason: 'history_api_timeout' };
                var payload = await Promise.race([
                  fetchHistoryPage({ page: page, page_size: pageSize }),
                  new Promise(function(resolve) {
                    setTimeout(function() {
                      resolve({ __historyTimeout: true });
                    }, remainingMs);
                  })
                ]);
                if (payload?.__historyTimeout) return { ok: false, reason: 'history_api_timeout' };
                var pageItems = payload?.audio_list;
                if (!Array.isArray(pageItems)) return { ok: false, reason: 'history_list_missing' };
                list.push.apply(list, pageItems);
                pagesFetched += 1;

                pageItems.forEach(function(item) {
                  targetAudioIds.delete(String(item.audio_id || ''));
                });
                var oldestUpdateTime = pageItems.reduce(function(oldest, item) {
                  var updateTime = Number(item.update_time || 0);
                  return !oldest || updateTime < oldest ? updateTime : oldest;
                }, 0);
                var reachedSubmissionWindow = earliestSubmission
                  && oldestUpdateTime
                  && oldestUpdateTime < earliestSubmission - 10000;
                var knownIdsFound = targetAudioIds.size === 0;

                hasMore = Boolean(payload?.has_more);
                if (pageItems.length === 0) break;
                if (knownIdsFound
                  && (!hasTextTargets || reachedSubmissionWindow)) {
                  stoppedAfterMatch = true;
                  break;
                }
                page += 1;
              }
            } catch (error) {
              return { ok: false, reason: error?.message || 'history_api_request_failed' };
            }
            if (hasMore && !stoppedAfterMatch) {
              return { ok: false, reason: 'history_pagination_incomplete' };
            }

            var claimedIds = new Set();
            requestedTasks.forEach(function(task) {
              (Array.isArray(task.excludedAudioIds) ? task.excludedAudioIds : []).forEach(function(id) {
                claimedIds.add(String(id));
              });
            });
            var matches = requestedTasks.map(function(task) {
              var candidates = list.filter(function(item) {
                if (task.audioId) return String(item.audio_id || '') === String(task.audioId);
                if (!task.text) return false;
                var audioId = String(item.audio_id || '');
                var itemText = String(item.text || '').replace(/\s+/g, ' ').trim();
                var taskText = String(task.text || '').replace(/\s+/g, ' ').trim();
                return itemText === taskText && !claimedIds.has(audioId);
              });
              if (!task.audioId && task.voiceName) {
                candidates = candidates.filter(function(item) {
                  var actual = String(item.voice_name || '').trim().toLowerCase();
                  var expected = String(task.voiceName || '').trim().toLowerCase();
                  actual = actual.replace(/\s+/g, ' ');
                  expected = expected.replace(/\s+/g, ' ');
                  if (!expected) return true;
                  if (!actual) return false;
                  return actual === expected
                    || expected.indexOf(actual + ' -') === 0
                    || actual.indexOf(expected + ' -') === 0;
                });
              }
              candidates.sort(function(a, b) {
                if (!task.submittedAt) return Number(b.update_time || 0) - Number(a.update_time || 0);
                return Math.abs(Number(a.update_time || 0) - Number(task.submittedAt))
                  - Math.abs(Number(b.update_time || 0) - Number(task.submittedAt));
              });
              candidates = candidates.filter(function(item) {
                if (task.audioId || !task.submittedAt) return true;
                return Number(item.update_time || 0) >= Number(task.submittedAt);
              });
              if (!task.audioId && candidates.length > 1) {
                return {
                  localId: task.localId,
                  record: null,
                  ambiguous: true,
                  candidateAudioIds: candidates.map(function(item) { return String(item.audio_id || ''); })
                };
              }
              var record = candidates[0] || null;
              if (!record) return { localId: task.localId, record: null };
              claimedIds.add(String(record.audio_id || ''));
              return {
                localId: task.localId,
                record: {
                  audioId: String(record.audio_id || ''),
                  status: Number(record.status),
                  async: Number(record.async),
                  audioUrl: String(record.audio_url || ''),
                  updateTime: Number(record.update_time || 0),
                  voiceName: String(record.voice_name || ''),
                  hasWav: record.has_wav === true,
                  hasSrt: record.has_srt === true
                }
              };
            });
            return {
              ok: true,
              matches: matches,
              audioIds: list.map(function(item) { return String(item.audio_id || ''); }).filter(Boolean),
              capturedAt: Date.now(),
              pagesFetched: pagesFetched,
              historyComplete: !hasMore
            };
          },

          consumeGeneratedAudioHistory: async function(task, timeout) {
            var capture = window.__minimaxLongTextHistoryCapture;
            if (!capture?.installed) return { ok: false, reason: 'history_capture_not_installed' };
            var startedAt = Date.now();
            var maxWait = Number(timeout) || 60000;
            var taskText = String(task?.text || '').replace(/\s+/g, ' ').trim();
            var expectedVoice = String(task?.voiceName || task?.voiceId || '').trim().toLowerCase().replace(/\s+/g, ' ');
            var submittedAt = Number(task?.submittedAt || 0);

            while (Date.now() - startedAt < maxWait) {
              var list = capture.snapshot?.data?.audio_list;
              if (Array.isArray(list)) {
                var candidates = list.filter(function(item) {
                  var itemText = String(item.text || '').replace(/\s+/g, ' ').trim();
                  if (!taskText || itemText !== taskText) return false;
                  if (submittedAt && Number(item.update_time || 0) < submittedAt) return false;
                  var actualVoice = String(item.voice_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
                  if (!expectedVoice) return true;
                  if (!actualVoice) return false;
                  return actualVoice === expectedVoice
                    || expectedVoice.indexOf(actualVoice + ' -') === 0
                    || actualVoice.indexOf(expectedVoice + ' -') === 0;
                });
                candidates.sort(function(a, b) {
                  return Number(b.update_time || 0) - Number(a.update_time || 0);
                });
                var record = candidates.find(function(item) {
                  return Number(item.status) === 0 && !!item.audio_url;
                });
                if (record) {
                  return {
                    ok: true,
                    record: {
                      audioId: String(record.audio_id || ''),
                      status: Number(record.status),
                      audioUrl: String(record.audio_url || ''),
                      updateTime: Number(record.update_time || 0),
                      voiceName: String(record.voice_name || '')
                    }
                  };
                }
              }
              await new Promise(function(resolve) { setTimeout(resolve, 200); });
            }

            return { ok: false, reason: 'generated_audio_history_timeout' };
          },

          ensureAudioCaptureInstalled: function() {
            function buildSession() {
              return {
                resetAt: Date.now(),
                state: 'started',
                cancelled: false,
                blob: null,
                blobType: '',
                blobUrl: '',
                mediaSource: null,
                mediaSourceUrl: '',
                sourceBufferTypes: [],
                chunks: [],
                totalBytes: 0,
                firstChunkAt: 0,
                lastChunkAt: 0,
                endedAt: 0,
                finalSignalAt: 0,
                finalSignalKind: ''
              };
            }

            if (window.__minimaxAudioCapture && window.__minimaxAudioCapture.installed) {
              return { ok: true, alreadyInstalled: true };
            }

            if (typeof MediaSource === 'undefined' || !MediaSource.prototype) {
              return { ok: false, reason: 'mediasource_unavailable' };
            }

            var originalCreateObjectURL = URL.createObjectURL.bind(URL);
            var originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
            var originalEndOfStream = MediaSource.prototype.endOfStream;
            var originalWebSocketDispatchEvent = typeof WebSocket !== 'undefined' && WebSocket.prototype
              ? WebSocket.prototype.dispatchEvent
              : null;
            var mediaSourceSessions = new WeakMap();
            var sourceBufferSessions = new WeakMap();

            function shouldCaptureBlob(blob) {
              if (!(blob instanceof Blob)) return false;
              var type = String(blob.type || '').toLowerCase();
              return type.indexOf('audio/') === 0 || type.indexOf('mpeg') >= 0 || type.indexOf('mp3') >= 0;
            }

            function normalizeChunk(data) {
              if (!data) return null;
              var view = data instanceof Uint8Array ? data : new Uint8Array(data);
              return view.slice ? view.slice(0) : new Uint8Array(view);
            }

            function registerMediaSourceSession(mediaSource, session, url) {
              session.mediaSource = mediaSource;
              session.mediaSourceUrl = url;
              session.state = 'receiving_chunks';
              mediaSourceSessions.set(mediaSource, session);
            }

            function markFinalSignal(kind) {
              var session = capture && capture.activeSession;
              if (!session) return;
              session.finalSignalAt = Date.now();
              session.finalSignalKind = kind || 'unknown';
              if (session.state !== 'stream_closed') {
                session.state = 'terminal_signal_seen';
              }
            }

            function inspectWebSocketPayload(payload) {
              if (!payload || typeof payload !== 'object') return;
              if (payload.extra_info) {
                markFinalSignal('extra_info');
                return;
              }
              if (payload.base_resp && (payload.base_resp.status_code === 0 || payload.base_resp.code === 0) && payload.data && !payload.input_sensitive) {
                if (payload.data.finish_reason || payload.data.is_final || payload.data.completed) {
                  markFinalSignal('data_final');
                }
              }
            }

            function blobToDataUrl(blob) {
              return new Promise(function(resolve, reject) {
                var reader = new FileReader();
                reader.onloadend = function() { resolve(reader.result); };
                reader.onerror = function() { reject(reader.error || new Error('blob read failed')); };
                reader.readAsDataURL(blob);
              });
            }

            function isGenerationUiBusy() {
              var buttons = Array.from(document.querySelectorAll('button'));
              return buttons.some(function(btn) {
                var text = String(btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text) return false;
                var isGenerateButton = text.indexOf('generate') >= 0 || text.indexOf('regenerate') >= 0 || text.indexOf('generating') >= 0;
                if (!isGenerateButton) return false;
                return text.indexOf('generating') >= 0 || !!btn.disabled || btn.classList.contains('opacity-60');
              });
            }

            var capture = {
              installed: true,
              activeSession: buildSession(),
              resetSession: function() {
                if (this.activeSession) this.activeSession.cancelled = true;
                this.activeSession = buildSession();
                return { ok: true, resetAt: this.activeSession.resetAt };
              },
              consumeCapturedAudio: async function(timeout) {
                var maxWait = Number(timeout) || 10000;
                var startedAt = Date.now();
                var session = this.activeSession;

                while (Date.now() - startedAt < maxWait) {
                  if (session.cancelled) {
                    return { ok: false, reason: 'capture_cancelled', state: session.state };
                  }
                  if (session.blob && session.blob.size > 0) {
                    session.state = 'ready_to_consume';
                    return {
                      ok: true,
                      source: 'blob',
                      completionReason: 'blob_ready',
                      src: session.blobUrl || '',
                      size: session.blob.size,
                      terminalSignalSeen: !!session.finalSignalAt,
                      streamClosed: !!session.endedAt,
                      dataUrl: await blobToDataUrl(session.blob)
                    };
                  }

                  if (session.chunks.length > 0) {
                    var quietForMs = session.lastChunkAt ? (Date.now() - session.lastChunkAt) : 0;
                    var hasFinalSignal = !!session.finalSignalAt;
                    var streamClosed = !!session.endedAt;
                    var websocketFinished = hasFinalSignal && quietForMs > 1500;
                    if (streamClosed || websocketFinished) {
                      var audioType = session.sourceBufferTypes.find(function(type) {
                        return String(type || '').toLowerCase().indexOf('audio/') === 0;
                      }) || 'audio/mpeg';
                      var chunkBlob = new Blob(session.chunks, { type: audioType });
                      if (chunkBlob.size > 0) {
                        session.state = 'ready_to_consume';
                        return {
                          ok: true,
                          source: 'mediasource',
                          completionReason: streamClosed
                            ? 'endofstream'
                            : ('ws_' + (session.finalSignalKind || 'final')),
                          src: session.mediaSourceUrl || '',
                          size: chunkBlob.size,
                          chunkCount: session.chunks.length,
                          quietForMs: quietForMs,
                          terminalSignalSeen: hasFinalSignal,
                          streamClosed: streamClosed,
                          dataUrl: await blobToDataUrl(chunkBlob)
                        };
                      }
                    }
                  }

                  await new Promise(function(resolve) { setTimeout(resolve, 250); });
                }

                return {
                  ok: false,
                  reason: session.totalBytes > 0
                    ? (session.finalSignalAt || session.endedAt ? 'generation_stalled_after_audio' : 'final_signal_missing')
                    : 'generation_never_started',
                  state: session.state,
                  src: session.blobUrl || session.mediaSourceUrl || '',
                  chunkCount: session.chunks.length,
                  totalBytes: session.totalBytes,
                  terminalSignalSeen: !!session.finalSignalAt,
                  streamClosed: !!session.endedAt,
                  sourceBufferTypes: session.sourceBufferTypes
                };
              }
            };

            URL.createObjectURL = function(object) {
              var url = originalCreateObjectURL(object);
              var session = capture.activeSession;

              try {
                if (shouldCaptureBlob(object)) {
                  session.blob = object;
                  session.blobType = object.type || 'audio/mpeg';
                  session.blobUrl = url;
                } else if (object instanceof MediaSource) {
                  registerMediaSourceSession(object, session, url);
                }
              } catch (error) {
                console.warn('[MiniMax Capture] createObjectURL hook failed:', error);
              }

              return url;
            };

            MediaSource.prototype.addSourceBuffer = function(mimeType) {
              var sourceBuffer = originalAddSourceBuffer.apply(this, arguments);

              try {
                var session = mediaSourceSessions.get(this);
                if (session) {
                  session.sourceBufferTypes.push(String(mimeType || ''));

                  if (!sourceBufferSessions.has(sourceBuffer)) {
                    sourceBufferSessions.set(sourceBuffer, session);
                    var originalAppendBuffer = sourceBuffer.appendBuffer;
                    sourceBuffer.appendBuffer = function(data) {
                      var targetSession = sourceBufferSessions.get(sourceBuffer);
                      if (targetSession) {
                        var chunk = normalizeChunk(data);
                        if (chunk && chunk.byteLength > 0) {
                          if (!targetSession.firstChunkAt) {
                            targetSession.firstChunkAt = Date.now();
                          }
                          targetSession.state = 'receiving_chunks';
                          targetSession.chunks.push(chunk);
                          targetSession.totalBytes += chunk.byteLength;
                          targetSession.lastChunkAt = Date.now();
                        }
                      }
                      return originalAppendBuffer.apply(this, arguments);
                    };
                  }
                }
              } catch (error) {
                console.warn('[MiniMax Capture] addSourceBuffer hook failed:', error);
              }

              return sourceBuffer;
            };

            MediaSource.prototype.endOfStream = function() {
              try {
                var session = mediaSourceSessions.get(this);
                if (session) {
                  session.endedAt = Date.now();
                  session.state = 'stream_closed';
                }
              } catch (error) {
                console.warn('[MiniMax Capture] endOfStream hook failed:', error);
              }

              return originalEndOfStream.apply(this, arguments);
            };

            if (originalWebSocketDispatchEvent) {
              WebSocket.prototype.dispatchEvent = function(event) {
                try {
                  if (event && event.type === 'message' && typeof event.data === 'string') {
                    var trimmed = event.data.trim();
                    if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
                      inspectWebSocketPayload(JSON.parse(trimmed));
                    }
                  }
                } catch (error) {
                  console.warn('[MiniMax Capture] websocket hook failed:', error);
                }
                return originalWebSocketDispatchEvent.apply(this, arguments);
              };
            }

            window.__minimaxAudioCapture = capture;
            return { ok: true, alreadyInstalled: false };
          },

          resetAudioCaptureSession: function() {
            var capture = window.__minimaxAudioCapture;
            if (!capture || !capture.installed || typeof capture.resetSession !== 'function') {
              return { ok: false, reason: 'capture_not_installed' };
            }
            return capture.resetSession();
          },

          consumeCapturedAudio: async function(timeout) {
            var capture = window.__minimaxAudioCapture;
            if (!capture || !capture.installed || typeof capture.consumeCapturedAudio !== 'function') {
              return { ok: false, reason: 'capture_not_installed' };
            }
            return await capture.consumeCapturedAudio(timeout);
          },

        };

        const func = slateFunctions[request.method];
        if (!func) {
          sendResponse({ success: false, reason: 'unknown method: ' + request.method });
          return;
        }

        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: func,
            args: request.args || []
          });
          sendResponse({ success: true, result: results[0]?.result });
        } catch (e) {
          sendResponse({ success: false, reason: e.message });
        }
      }
    } catch (error) {
      console.error('Error:', error);
      sendResponse({ success: false, reason: error.message });
    }
  })();

  return true;
});

// Функция удалена - теперь пользователь сам отмечает записи как готовые через кнопку

// ============================================
// BATCH MANAGER (Очередь файлов с персистентным хранением)
// ============================================

// В Manifest V3 Service Worker "усыпляется" через ~30 секунд бездействия.
// Все переменные в памяти сбрасываются. Храним состояние в chrome.storage.local.

const MINIMAX_TTS_URL = 'https://www.minimax.io/audio/text-to-speech';
const LONG_TEXT_ALARM = 'longTextHistoryPoll';

function getDefaultLongTextState() {
  return {
    tasks: [],
    baselineAudioIds: [],
    monitorTabId: null,
    isSubmitting: false,
    updatedAt: null
  };
}

let longTextState = getDefaultLongTextState();
let longTextStopRequested = false;

async function loadLongTextState() {
  const data = await chrome.storage.local.get('longTextState');
  longTextState = data.longTextState || getDefaultLongTextState();
  return longTextState;
}

async function saveLongTextState() {
  longTextState.updatedAt = Date.now();
  const activeTasks = longTextState.tasks.filter((task) => {
    return ['queued', 'submitting', 'awaiting_match', 'pending', 'ready', 'downloading', 'reconciliation_required'].includes(task.status);
  });
  const finishedTasks = longTextState.tasks.filter((task) => !activeTasks.includes(task)).slice(-100);
  longTextState.tasks = [...finishedTasks, ...activeTasks];
  await chrome.storage.local.set({ longTextState });
}

function getLongTextSummary() {
  const tasks = Array.isArray(longTextState.tasks) ? longTextState.tasks : [];
  const count = (statuses) => tasks.filter((task) => statuses.includes(task.status)).length;
  return {
    total: tasks.length,
    queued: count(['queued', 'submitting']),
    pending: count(['awaiting_match', 'pending']),
    ready: count(['ready', 'downloading']),
    completed: count(['completed']),
    failed: count(['error', 'reconciliation_required']),
    isSubmitting: longTextState.isSubmitting === true,
    hasPollable: count(['queued', 'submitting', 'awaiting_match', 'pending', 'ready', 'downloading']) > 0,
    hasActive: count(['queued', 'submitting', 'awaiting_match', 'pending', 'ready', 'downloading', 'reconciliation_required']) > 0
  };
}

async function getSubmissionRecoverySummary() {
  const [regularSubmissions] = await Promise.all([
    getUnresolvedRegularSubmissions(),
    loadLongTextState()
  ]);
  const unresolvedLongText = longTextState.tasks.filter((task) => (
    ['queued', 'submitting', 'awaiting_match', 'pending', 'reconciliation_required'].includes(task.status)
  ));
  return {
    regular: regularSubmissions.length,
    longText: unresolvedLongText.length,
    total: regularSubmissions.length + unresolvedLongText.length
  };
}

async function confirmAutomationStopped(tabId, matchesRuntime) {
  if (!tabId) return true;
  try {
    await chrome.tabs.get(tabId);
  } catch (error) {
    return true;
  }

  let runtime;
  try {
    runtime = await sendTabMessageWithTimeout(tabId, { action: 'getAutomationRuntimeState' }, 7000);
  } catch (error) {
    throw new Error('automation_runtime_unconfirmed');
  }
  if (!runtime?.success) throw new Error('automation_runtime_unconfirmed');
  if (runtime.state?.isRunning && matchesRuntime(runtime.state)) {
    throw new Error('automation_runtime_active');
  }
  if (runtime.state?.isRunning) throw new Error('another_automation_runtime_active');
  return true;
}

async function resolveSubmissionRecovery(tabId) {
  await Promise.all([loadBatchState(), loadParallelBatchState(), loadLongTextState()]);
  if (longTextState.isSubmitting
    || (batchState.isRunning && !batchState.activeJob)
    || (parallelBatchState.isRunning && !parallelBatchState.runId)) {
    throw new Error('automation_running');
  }
  if (batchState.activeJob && batchState.activeTabId) {
    await confirmAutomationStopped(batchState.activeTabId, (runtime) => (
      runtime.legacyJobId === batchState.activeJob.legacyJobId
    ));
  }
  if (parallelBatchState.runId) {
    for (const worker of parallelBatchState.workers || []) {
      await confirmAutomationStopped(worker.tabId, (runtime) => (
        runtime.runId === parallelBatchState.runId && runtime.workerId === worker.workerId
      ));
    }
  }

  batchState.isRunning = false;
  parallelBatchState.isRunning = false;
  await Promise.all([saveBatchState(), saveParallelBatchState()]);

  const recoverySummary = await getSubmissionRecoverySummary();
  if (recoverySummary.total > 0 && !tabId) {
    throw new Error('minimax_tab_required_for_history_reconciliation');
  }
  if (recoverySummary.total > 0) {
    await chrome.tabs.get(tabId);
    await reconcileRegularSubmissionLedger(tabId);
    const unresolvedLongText = longTextState.tasks.filter((task) => (
      ['queued', 'submitting', 'awaiting_match', 'pending', 'reconciliation_required'].includes(task.status)
    ));
    const claimedAudioIds = longTextState.tasks.map((task) => task.audioId).filter(Boolean);
    const historyResponse = await sendTabMessageWithTimeout(tabId, {
      action: 'queryLongTextHistory',
      timeout: 30000,
      tasks: unresolvedLongText.map((task) => ({
        localId: task.localId,
        audioId: task.audioId,
        text: task.text,
        voiceId: task.voiceId,
        voiceName: task.selectedVoiceName,
        submittedAt: task.submittedAt,
        excludedAudioIds: [...(longTextState.baselineAudioIds || []), ...claimedAudioIds]
      }))
    }, 30000);
    if (!historyResponse?.success) {
      throw new Error(historyResponse?.reason || 'long_text_history_reconciliation_failed');
    }
    for (const match of historyResponse.matches || []) {
      const task = longTextState.tasks.find((item) => item.localId === match.localId);
      if (task && match.record) applyLongTextHistoryRecord(task, match.record);
    }
    await saveLongTextState();
  }

  const regularSubmissions = await getUnresolvedRegularSubmissions();
  await chrome.storage.local.set({ [REGULAR_SUBMISSION_LEDGER_KEY]: [] });

  let abandonedLongText = 0;
  for (const task of longTextState.tasks) {
    if (!['queued', 'submitting', 'awaiting_match', 'pending', 'reconciliation_required'].includes(task.status)) continue;
    task.status = 'error';
    task.submissionPhase = 'manually_abandoned';
    task.error = 'Manually cleared after History review; automatic retry is disabled';
    abandonedLongText += 1;
  }
  await saveLongTextState();
  await stopLongTextAlarmIfIdle();
  broadcastLongTextProgress();

  if (batchState.recoveryRequired) {
    batchState.activeJob = null;
    batchState.recoveryRequired = false;
    batchState.error = null;
    batchState.isRunning = false;
    await saveBatchState();
  }
  if (!parallelBatchState.isRunning && parallelBatchState.runId) {
    const secondaryTabId = parallelBatchState.secondaryTabId;
    parallelBatchState = getDefaultParallelBatchState();
    await saveParallelBatchState();
    await closeTabSafely(secondaryTabId);
  }

  return {
    success: true,
    clearedRegular: regularSubmissions.length,
    clearedLongText: abandonedLongText
  };
}

function broadcastLongTextProgress() {
  chrome.runtime.sendMessage({
    action: 'longTextProgress',
    summary: getLongTextSummary()
  }).catch(() => {});
}

function partitionLongTextJobs(jobs) {
  const longTextEntries = [];
  const regularJobs = [];

  (Array.isArray(jobs) ? jobs : []).forEach((job) => {
    const regularQueue = [];
    (Array.isArray(job.queue) ? job.queue : []).forEach((entry) => {
      const length = String(entry.text || '').length;
      if (length > 5000 && length <= 200000) {
        longTextEntries.push({ ...entry, mode: job.mode, scriptName: entry.scriptName || job.scriptName || null });
        return;
      }
      regularQueue.push(entry);
    });
    if (regularQueue.length > 0) regularJobs.push({ ...job, queue: regularQueue });
  });

  return { longTextEntries, regularJobs };
}

function assertLongTextLimits(jobs) {
  for (const job of Array.isArray(jobs) ? jobs : []) {
    for (const entry of Array.isArray(job.queue) ? job.queue : []) {
      const length = String(entry.text || '').length;
      if (length > 200000) {
        throw new Error(`Long Text exceeds the 200000 character limit (${length})`);
      }
    }
  }
}

function createLongTextTask(entry) {
  return {
    localId: `long-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    status: 'queued',
    text: String(entry.text || ''),
    preview: String(entry.text || '').slice(0, 160),
    audioId: null,
    audioUrl: null,
    serverStatus: null,
    submittedAt: null,
    submissionPhase: null,
    reservedAt: null,
    dispatchedAt: null,
    completedAt: null,
    error: null,
    voiceId: entry.voiceId || null,
    selectedVoiceName: entry.voiceName || null,
    voiceName: entry.originalTag || entry.speaker || 'dictor',
    speakerName: entry.speaker || null,
    language: entry.language || 'Auto',
    scriptName: entry.scriptName || null,
    downloadIndex: entry.downloadIndex || entry.speakerIndex || null,
    downloadLayout: entry.downloadLayout || null,
    sourceFileName: entry.sourceFileName || null,
    sourceFileBaseName: entry.sourceFileBaseName || null,
    mode: entry.mode || 'single'
  };
}

function applyLongTextHistoryRecord(task, record) {
  if (!task || !record) return;
  task.audioId = record.audioId || task.audioId;
  task.serverStatus = record.status;
  task.hasWav = record.hasWav === true;
  task.hasSrt = record.hasSrt === true;
  task.lastSeenAt = Date.now();
  task.error = null;
  if (task.audioId) task.text = null;

  if (record.status === 0 && record.audioUrl) {
    task.audioUrl = record.audioUrl;
    task.status = 'ready';
    return;
  }
  if (record.status === 1) {
    task.status = 'pending';
    return;
  }
  task.status = 'error';
  task.error = `MiniMax returned Long Text status ${record.status}`;
}

async function ensureLongTextAlarm() {
  const summary = getLongTextSummary();
  if (!summary.hasPollable || longTextState.isSubmitting) return;
  await chrome.alarms.create(LONG_TEXT_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}

async function initializeLongTextState() {
  await loadLongTextState();
  const hasInterruptedSubmissions = longTextState.tasks.some((task) => {
    return task.status === 'queued' || task.status === 'submitting';
  });
  if (longTextState.isSubmitting || hasInterruptedSubmissions) {
    longTextState.isSubmitting = false;
    longTextState.tasks.forEach((task) => {
      if (task.status !== 'queued' && task.status !== 'submitting') return;
      const wasDispatched = task.submissionPhase === 'dispatched'
        || (task.submissionPhase == null && task.submissionStartedAt);
      if (task.status === 'submitting' && wasDispatched) {
        task.status = 'awaiting_match';
        task.submittedAt = task.dispatchedAt || task.submissionStartedAt;
        task.error = null;
        return;
      }
      task.status = 'error';
      task.error = 'Long Text submission was interrupted before confirmation';
    });
    await saveLongTextState();
  }
  await ensureLongTextAlarm();
}

async function stopLongTextAlarmIfIdle() {
  if (getLongTextSummary().hasPollable) return;
  await chrome.alarms.clear(LONG_TEXT_ALARM);
}

async function submitLongTextEntries(entries, tabId) {
  if (!Array.isArray(entries) || entries.length === 0) return { submitted: 0, failed: 0 };

  const cancellationReset = await sendTabMessageWithTimeout(
    tabId,
    { action: 'resetLongTextCancellation' },
    7000
  );
  if (!cancellationReset?.success) throw new Error('long_text_cancellation_reset_failed');

  const baselineResponse = await sendTabMessageWithTimeout(tabId, {
    action: 'queryLongTextHistory',
    timeout: 30000,
    tasks: []
  }, 30000);
  if (!baselineResponse?.success || !Array.isArray(baselineResponse.audioIds)) {
    throw new Error(baselineResponse?.reason || 'long_text_history_preflight_failed');
  }
  const baselineAudioIds = baselineResponse.audioIds;

  const tasks = entries.map(createLongTextTask);
  longTextState.tasks = tasks;
  longTextState.baselineAudioIds = baselineAudioIds;
  longTextState.monitorTabId = tabId;
  longTextState.isSubmitting = true;
  await saveLongTextState();
  broadcastLongTextProgress();

  let restoreError = null;
  let reconciliationRequired = false;
  let terminalFailure = null;
  try {
    for (const task of tasks) {
      if (longTextStopRequested) {
        terminalFailure = 'Long Text submission stopped before the next task';
        for (const queuedTask of tasks.filter((item) => item.status === 'queued')) {
          queuedTask.status = 'error';
          queuedTask.error = 'Not submitted because Stop was requested';
        }
        await saveLongTextState();
        broadcastLongTextProgress();
        break;
      }
      task.status = 'submitting';
      task.intentCreatedAt = Date.now();
      task.submittedAt = null;
      task.submissionStartedAt = null;
      task.submissionPhase = null;
      task.reservedAt = null;
      task.dispatchedAt = null;
      await saveLongTextState();
      broadcastLongTextProgress();

      try {
        const response = await sendTabMessageWithTimeout(tabId, {
          action: 'submitLongText',
          task: {
            localId: task.localId,
            text: task.text,
            voiceId: task.voiceId,
            voiceName: task.selectedVoiceName,
            language: task.language
          }
        }, 120000);
        if (!response?.success) {
          if (task.submissionPhase === 'dispatched') {
            task.status = 'awaiting_match';
            task.submittedAt = task.dispatchedAt || task.submittedAt || Date.now();
            task.error = response?.reason || 'Long Text dispatch requires History reconciliation';
            reconciliationRequired = true;
          } else {
            task.status = 'error';
            task.error = response?.reason || 'long_text_submit_failed';
            if (task.submissionPhase === 'rejected') terminalFailure = task.error;
          }
        } else {
          task.submittedAt = response.submittedAt || Date.now();
          task.status = 'awaiting_match';
          task.error = null;

          try {
            const claimedAudioIds = longTextState.tasks.map((item) => item.audioId).filter(Boolean);
            const unmatchedTasks = longTextState.tasks
              .filter((item) => item.status === 'awaiting_match')
              .sort((a, b) => Number(a.submittedAt || 0) - Number(b.submittedAt || 0));
            const historyResponse = await sendTabMessageWithTimeout(tabId, {
              action: 'queryLongTextHistory',
              timeout: 30000,
              tasks: unmatchedTasks.map((item) => ({
                localId: item.localId,
                text: item.text,
                voiceId: item.voiceId,
                voiceName: item.selectedVoiceName,
                submittedAt: item.submittedAt,
                excludedAudioIds: [...(longTextState.baselineAudioIds || []), ...claimedAudioIds]
              }))
            }, 30000);
            if (historyResponse?.success) {
              (historyResponse.matches || []).forEach((match) => {
                const matchedTask = longTextState.tasks.find((item) => item.localId === match.localId);
                if (match.record) applyLongTextHistoryRecord(matchedTask, match.record);
              });
            }
          } catch (error) {
            console.warn('[Background] Long Text accepted but not matched yet:', error);
          }
        }
      } catch (error) {
        const wasDispatched = task.submissionPhase === 'dispatched'
          || (task.submissionPhase == null && task.submissionStartedAt);
        task.status = wasDispatched ? 'awaiting_match' : 'error';
        task.error = error.message;
        reconciliationRequired = wasDispatched;
        if (task.submissionPhase === 'rejected') terminalFailure = task.error;
      }

      await saveLongTextState();
      broadcastLongTextProgress();
      if (longTextStopRequested && !reconciliationRequired && !terminalFailure) {
        terminalFailure = 'Long Text submission stopped before the next task';
      }
      if (reconciliationRequired || terminalFailure) {
        for (const queuedTask of tasks.filter((item) => item.status === 'queued')) {
          queuedTask.status = 'error';
          queuedTask.error = reconciliationRequired
            ? 'Not submitted because an earlier Long Text task requires reconciliation'
            : longTextStopRequested
              ? 'Not submitted because Stop was requested'
              : 'Not submitted because an earlier Long Text task was rejected';
        }
        await saveLongTextState();
        broadcastLongTextProgress();
        break;
      }
    }
  } finally {
    longTextState.isSubmitting = false;
    try {
      await sendTabMessageWithTimeout(tabId, { action: 'resetLongTextMode' }, 15000);
    } catch (error) {
      console.warn('[Background] Failed to restore regular text mode:', error);
      restoreError = error;
    }
    await saveLongTextState();
    await ensureLongTextAlarm();
    broadcastLongTextProgress();
  }

  if (restoreError) {
    throw new Error(`Long Text submitted, but regular mode was not restored: ${restoreError.message}`);
  }
  if (reconciliationRequired) {
    throw new Error('Long Text may have been accepted; History reconciliation is required before continuing');
  }
  if (terminalFailure) {
    throw new Error(terminalFailure);
  }

  return {
    submitted: tasks.filter((task) => task.status !== 'error').length,
    failed: tasks.filter((task) => task.status === 'error').length
  };
}

async function findLongTextMonitorTab() {
  if (longTextState.monitorTabId) {
    try {
      const tab = await chrome.tabs.get(longTextState.monitorTabId);
      if (String(tab.url || '').startsWith(MINIMAX_TTS_URL)) return tab.id;
    } catch (error) {
      // Fall through to another open MiniMax tab.
    }
  }
  const tabs = await chrome.tabs.query({ url: `${MINIMAX_TTS_URL}*` });
  return tabs[0]?.id || null;
}

async function confirmLongTextDownload(task) {
  if (!task.downloadId) {
    const startedAt = Number(task.downloadStartedAt || 0);
    if (!startedAt) {
      task.status = 'ready';
      return;
    }
    const recentItems = await chrome.downloads.search({
      startedAfter: new Date(startedAt - 5000).toISOString()
    });
    const matchingDownload = recentItems.find((item) => item.url === task.audioUrl && item.state !== 'interrupted');
    if (matchingDownload) {
      task.downloadId = matchingDownload.id;
    } else if (Date.now() - startedAt > 60000) {
      task.status = 'ready';
      task.downloadStartedAt = null;
      return;
    } else {
      return;
    }
  }
  const items = await chrome.downloads.search({ id: task.downloadId });
  const item = items[0];
  if (!item || item.error || item.state === 'interrupted') {
    task.status = 'ready';
    task.downloadId = null;
    task.downloadStartedAt = null;
    task.error = item?.error || 'download_interrupted';
    return;
  }
  if (item.state !== 'complete') return;

  task.status = 'completed';
  task.completedAt = Date.now();
  task.error = null;
  if (!task.historySaved) {
    await saveToDownloadHistory(task.folderName, task.targetFilename, task.fileNumber);
    task.historySaved = true;
  }
}

async function downloadReadyLongTextTask(task) {
  if (!isValidAudioUrl(task.audioUrl)) throw new Error('invalid_long_text_audio_url');
  const target = await buildDownloadTarget({
    voiceName: task.voiceName,
    scriptName: task.scriptName,
    forceIndex: task.downloadIndex,
    speakerName: task.speakerName,
    downloadLayout: task.downloadLayout,
    sourceFileName: task.sourceFileName,
    sourceFileBaseName: task.sourceFileBaseName
  });

  task.status = 'downloading';
  task.downloadStartedAt = Date.now();
  task.folderName = target.folderName;
  task.targetFilename = target.newFilename;
  task.fileNumber = target.fileNumber;
  task.error = null;
  await saveLongTextState();

  const namedReservation = reserveNamedDownload(task.audioUrl, target.newFilename);
  try {
    task.downloadId = await chrome.downloads.download({
      url: task.audioUrl,
      filename: target.newFilename,
      conflictAction: 'uniquify',
      saveAs: false
    });
  } catch (error) {
    releaseNamedDownload(namedReservation);
    throw error;
  }
  await saveLongTextState();
  await confirmLongTextDownload(task);
}

async function pollLongTextTasks() {
  await Promise.all([loadLongTextState(), loadBatchState(), loadParallelBatchState()]);
  if (longTextState.isSubmitting) return;

  const activeTasks = longTextState.tasks.filter((task) => {
    return ['awaiting_match', 'pending', 'ready', 'downloading'].includes(task.status);
  });
  if (activeTasks.length === 0) {
    await stopLongTextAlarmIfIdle();
    return;
  }

  const tabId = await findLongTextMonitorTab();
  if (!tabId) return;
  longTextState.monitorTabId = tabId;

  const pendingTasks = activeTasks.filter((task) => {
    return task.status === 'awaiting_match' || task.status === 'pending';
  });
  if (pendingTasks.length > 0) {
    const claimedAudioIds = longTextState.tasks.map((task) => task.audioId).filter(Boolean);
    const response = await sendTabMessageWithTimeout(tabId, {
      action: 'queryLongTextHistory',
      timeout: 30000,
      tasks: pendingTasks.map((task) => ({
        localId: task.localId,
        audioId: task.audioId,
        text: task.text,
        voiceId: task.voiceId,
        voiceName: task.selectedVoiceName,
        submittedAt: task.submittedAt,
        excludedAudioIds: [...(longTextState.baselineAudioIds || []), ...claimedAudioIds]
      }))
    }, 30000);
    if (!response?.success) throw new Error(response?.reason || 'long_text_history_poll_failed');

    (response.matches || []).forEach((match) => {
      const task = longTextState.tasks.find((item) => item.localId === match.localId);
      if (!task) return;
      task.pollAttempts = Number(task.pollAttempts || 0) + 1;
      if (match.record) applyLongTextHistoryRecord(task, match.record);
      const submittedAt = Number(task.submittedAt || 0);
      if (!match.record && submittedAt && Date.now() - submittedAt > 24 * 60 * 60 * 1000) {
        task.status = 'reconciliation_required';
        task.error = 'Long Text task is still unresolved after 24 hours; manual reconciliation is required';
      }
    });
  }

  for (const task of longTextState.tasks.filter((item) => item.status === 'downloading')) {
    await confirmLongTextDownload(task);
  }
  for (const task of longTextState.tasks.filter((item) => item.status === 'ready')) {
    try {
      await downloadReadyLongTextTask(task);
    } catch (error) {
      task.status = 'ready';
      task.error = error.message;
    }
  }

  await saveLongTextState();
  await stopLongTextAlarmIfIdle();
  broadcastLongTextProgress();
}

function getDefaultParallelBatchState() {
  return {
    phase: 'idle',
    isRunning: false,
    isPaused: false,
    isFallingBack: false,
    runId: null,
    primaryTabId: null,
    secondaryTabId: null,
    originalJobs: [],
    workers: [],
    startedAt: null
  };
}

let parallelBatchState = getDefaultParallelBatchState();
let parallelOperationQueue = Promise.resolve();

function queueParallelOperation(operation) {
  const result = parallelOperationQueue.then(operation);
  parallelOperationQueue = result.catch(() => {});
  return result;
}

async function loadParallelBatchState() {
  const data = await chrome.storage.local.get('parallelBatchState');
  parallelBatchState = data.parallelBatchState || getDefaultParallelBatchState();
  return parallelBatchState;
}

async function initializeParallelBatchState() {
  await loadParallelBatchState();
  if (parallelBatchState.phase !== 'preparing') return;
  const secondaryTabId = parallelBatchState.secondaryTabId;
  parallelBatchState.isRunning = false;
  parallelBatchState.isPaused = false;
  parallelBatchState.error = 'Parallel preparation was interrupted before regular workers started';
  await saveParallelBatchState();
  await closeTabSafely(secondaryTabId);
  parallelBatchState.secondaryTabId = null;
  await saveParallelBatchState();
}

async function saveParallelBatchState() {
  await chrome.storage.local.set({ parallelBatchState });
}

function annotateParallelJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job, jobIndex) => ({
    ...job,
    queue: (Array.isArray(job.queue) ? job.queue : []).map((entry, entryIndex) => ({
      ...entry,
      _parallelKey: entry._parallelKey || `${jobIndex}:${entryIndex}:${entry.id || 'entry'}`
    }))
  }));
}

function buildParallelPlan(jobs) {
  const groups = new Map();

  jobs.forEach((job) => {
    job.queue.forEach((entry) => {
      const voiceId = String(entry.voiceId || '').trim();
      if (!voiceId) return;
      if (!groups.has(voiceId)) groups.set(voiceId, []);
      groups.get(voiceId).push(entry);
    });
  });

  const totalEntries = jobs.reduce((total, job) => total + job.queue.length, 0);
  const mappedEntries = [...groups.values()].reduce((total, entries) => total + entries.length, 0);
  if (mappedEntries !== totalEntries) {
    return { ok: false, reason: 'Для двух потоков нужны голоса у всех реплик' };
  }
  if (groups.size < 2) {
    return { ok: false, reason: 'Для двух потоков нужны минимум два разных голоса' };
  }

  const workers = [
    { workerId: 'worker-1', queue: [], weight: 0 },
    { workerId: 'worker-2', queue: [], weight: 0 }
  ];
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const weightA = a[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
    const weightB = b[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
    return weightB - weightA;
  });

  sortedGroups.forEach(([, entries]) => {
    const target = workers[0].weight <= workers[1].weight ? workers[0] : workers[1];
    target.queue.push(...entries);
    target.weight += entries.reduce((sum, entry) => sum + String(entry.text || '').length, 0);
  });

  if (workers.some((worker) => worker.queue.length === 0)) {
    return { ok: false, reason: 'Не удалось равномерно разделить очередь' };
  }

  return { ok: true, workers };
}

function getParallelQueueSnapshot(queue) {
  return (Array.isArray(queue) ? queue : []).map((entry) => ({
    _parallelKey: entry._parallelKey,
    id: entry.id,
    status: entry.status || 'pending',
    downloadConfirmed: entry.downloadConfirmed === true,
    paidSubmissionStarted: entry.paidSubmissionStarted === true,
    submissionRejected: entry.submissionRejected === true,
    submittedAt: Number(entry.submittedAt || 0),
    error: entry.error || null
  }));
}

async function waitForParallelTab(tabId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        const health = await sendTabMessageWithTimeout(tabId, { action: 'parallelHealthCheck' }, 7000);
        if (health?.success) return health;
      }
    } catch (error) {
      // Content script may not be injected yet.
    }
    await sleep(500);
  }
  throw new Error('Вторая вкладка MiniMax не готова');
}

async function closeTabSafely(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // The tab may already be closed.
  }
}

async function waitForAutomationStopped(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const runtime = await sendTabMessageWithTimeout(tabId, { action: 'getAutomationRuntimeState' }, 7000);
      if (runtime?.success && !runtime.state?.isRunning) return true;
    } catch (error) {
      // A closed secondary tab is already stopped from the queue's perspective.
      try {
        await chrome.tabs.get(tabId);
      } catch (tabError) {
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}

async function stopPrimaryWorkerForFallback(tabId, runId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendTabMessageWithTimeout(tabId, { action: 'stopAutomation', runId }, 7000);
    } catch (error) {
      // Retry after the runtime-state check below; a reload is the final recovery path.
    }
    if (await waitForAutomationStopped(tabId)) return;
  }

  // A reload terminates an unresponsive content-script run without requiring a user action.
  await chrome.tabs.reload(tabId);
  await waitForParallelTab(tabId, 45000);
  if (!await waitForAutomationStopped(tabId, 10000)) {
    throw new Error('Не удалось остановить основной поток для автоматического восстановления');
  }
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tab message timed out: ${message.action}`)), timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      callback(value);
    };
    const send = () => chrome.tabs.sendMessage(tabId, message).then(
      (response) => finish(resolve, response),
      async (error) => {
        // Long Text polling can outlive a page reload. Reinject only after Chrome
        // confirms that this tab has no receiver, then retry the original request.
        if (!String(error?.message || '').includes('Receiving end does not exist')) {
          finish(reject, error);
          return;
        }
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['diag_log.js', 'voice_mapping.js', 'content_script.js'] });
          await sleep(250);
          const response = await chrome.tabs.sendMessage(tabId, message);
          finish(resolve, response);
        } catch (retryError) {
          finish(reject, retryError);
        }
      }
    );
    send();
  });
}

async function assertDirectTtsCapability(tabId) {
  const response = await sendTabMessageWithTimeout(tabId, { action: 'getDirectTtsCapability' }, 10000);
  if (response?.success && response?.ok) return;
  throw new Error(`MiniMax direct TTS is incompatible: ${response?.reason || 'direct_tts_capability_unavailable'}`);
}

function getParallelProgress() {
  const workers = parallelBatchState.workers || [];
  const completedIds = workers.flatMap((worker) => (worker.queue || [])
    .filter((entry) => entry.status === 'completed' || entry.downloadConfirmed)
    .map((entry) => entry.id));
  const currentIndex = workers.reduce((sum, worker) => sum + Number(worker.currentIndex || 0), 0);
  const total = workers.reduce((sum, worker) => sum + Number(worker.total || 0), 0);
  return {
    currentIndex,
    total,
    completedIds,
    isRunning: parallelBatchState.isRunning,
    isPaused: parallelBatchState.isPaused,
    workerCount: workers.length
  };
}

async function broadcastParallelProgress() {
  const progress = getParallelProgress();
  await saveAutomationState({ progress, mode: 'multi' });
  chrome.runtime.sendMessage({
    action: 'parallelBatchProgress',
    runId: parallelBatchState.runId,
    progress,
    workers: parallelBatchState.workers.map((worker) => ({
      workerId: worker.workerId,
      currentIndex: worker.currentIndex,
      total: worker.total,
      status: worker.status
    }))
  }).catch(() => {});
}

function buildRemainingParallelJobs() {
  const protectedKeys = new Set((parallelBatchState.workers || []).flatMap((worker) => {
    return (worker.queue || [])
      .filter((entry) => entry.status === 'completed'
        || entry.status === 'skipped_manual'
        || entry.status === 'skipped_voice_not_found'
        || entry.downloadConfirmed
        || entry.paidSubmissionStarted
        || entry.submissionRejected)
      .map((entry) => entry._parallelKey);
  }));

  return (parallelBatchState.originalJobs || [])
    .map((job) => ({
      ...job,
      queue: job.queue.filter((entry) => !protectedKeys.has(entry._parallelKey))
    }))
    .filter((job) => job.queue.length > 0);
}

async function finishParallelBatch() {
  const secondaryTabId = parallelBatchState.secondaryTabId;
  DiagLog.info('parallel', 'Двухпоточный пакет завершён', {
    runId: parallelBatchState.runId,
    workers: (parallelBatchState.workers || []).map((worker) => ({
      workerId: worker.workerId,
      total: worker.total,
      status: worker.status
    }))
  });
  parallelBatchState = getDefaultParallelBatchState();
  await saveParallelBatchState();
  await chrome.alarms.clear('parallelBatchWatchdog');
  await closeTabSafely(secondaryTabId);
  await saveAutomationState({
    progress: { currentIndex: 0, total: 0, completedIds: [], isRunning: false, isPaused: false, workerCount: 0 },
    mode: 'multi'
  });
  chrome.runtime.sendMessage({ action: 'parallelBatchComplete' }).catch(() => {});
}

async function fallbackParallelBatch(reason) {
  await loadParallelBatchState();
  if (!parallelBatchState.isRunning || parallelBatchState.isFallingBack) return;

  DiagLog.warn('parallel', 'Откат двух потоков в один', {
    reason,
    runId: parallelBatchState.runId,
    workers: (parallelBatchState.workers || []).map((worker) => ({
      workerId: worker.workerId,
      currentIndex: worker.currentIndex,
      total: worker.total,
      status: worker.status
    }))
  });
  parallelBatchState.isFallingBack = true;
  await saveParallelBatchState();

  const primaryTabId = parallelBatchState.primaryTabId;
  const secondaryTabId = parallelBatchState.secondaryTabId;
  await Promise.allSettled((parallelBatchState.workers || []).filter((worker) => worker.tabId !== primaryTabId).map((worker) => {
    return sendTabMessageWithTimeout(worker.tabId, {
      action: 'stopAutomation',
      runId: parallelBatchState.runId,
      workerId: worker.workerId
    }, 7000);
  }));
  await stopPrimaryWorkerForFallback(primaryTabId, parallelBatchState.runId);

  const unresolvedPaidEntries = (parallelBatchState.workers || []).flatMap((worker) => (
    (worker.queue || []).filter((entry) => entry.paidSubmissionStarted && !entry.downloadConfirmed)
  ));
  if (unresolvedPaidEntries.length > 0) {
    parallelBatchState.isRunning = false;
    parallelBatchState.isFallingBack = false;
    parallelBatchState.error = 'Paid submissions require History reconciliation before retry';
    await saveParallelBatchState();
    await chrome.alarms.clear('parallelBatchWatchdog');
    await closeTabSafely(secondaryTabId);
    chrome.runtime.sendMessage({
      action: 'automationError',
      error: 'Параллельный пакет остановлен: отправленные задачи требуют сверки с History перед повтором.'
    }).catch(() => {});
    return;
  }

  const remainingJobs = buildRemainingParallelJobs();
  parallelBatchState = getDefaultParallelBatchState();
  await saveParallelBatchState();
  await chrome.alarms.clear('parallelBatchWatchdog');
  await closeTabSafely(secondaryTabId);

  if (remainingJobs.length === 0) {
    await finishParallelBatch();
    return;
  }

  await ensureAutomationStateLoaded();
  await saveAutomationState({
    progress: { ...(automationState.progress || {}), workerCount: 1 }
  });
  await startLegacyBatchProcessing(remainingJobs, primaryTabId);
  chrome.runtime.sendMessage({
    action: 'parallelBatchFallback',
    reason,
    remaining: remainingJobs.reduce((sum, job) => sum + job.queue.length, 0)
  }).catch(() => {});
}

async function updateParallelWorker(request, sender, isComplete = false) {
  await loadParallelBatchState();
  if (!parallelBatchState.isRunning || request.runId !== parallelBatchState.runId) return;

  const worker = parallelBatchState.workers.find((item) => item.workerId === request.workerId);
  if (!worker || (sender.tab?.id && worker.tabId !== sender.tab.id)) return;

  if (Array.isArray(request.queue)) {
    const persistedByKey = new Map((worker.queue || []).map((entry) => [entry._parallelKey, entry]));
    worker.queue = getParallelQueueSnapshot(request.queue).map((entry) => {
      const persisted = persistedByKey.get(entry._parallelKey);
      if (!persisted?.paidSubmissionStarted) return entry;
      return {
        ...entry,
        paidSubmissionStarted: true,
        submittedAt: Number(persisted.submittedAt || entry.submittedAt || 0)
      };
    });
  }
  worker.currentIndex = Number(request.currentIndex ?? request.completed ?? worker.currentIndex ?? 0);
  worker.total = worker.queue.length;
  worker.lastProgressAt = Date.now();
  if (isComplete) worker.status = 'complete';
  await saveParallelBatchState();
  await broadcastParallelProgress();

  if (!isComplete) return;
  const hasErrors = worker.queue.some((entry) => entry.status === 'error');
  if (hasErrors) {
    await fallbackParallelBatch('Один из потоков завершился с ошибкой');
    return;
  }
  if (parallelBatchState.workers.every((item) => item.status === 'complete')) {
    await finishParallelBatch();
  }
}

async function prepareParallelBatchProcessing(jobs, primaryTabId) {
  await Promise.all([loadBatchState(), loadParallelBatchState()]);
  if (batchState.isRunning || parallelBatchState.isRunning) {
    throw new Error('automation_already_running');
  }

  const originalJobs = annotateParallelJobs(jobs);
  const plan = buildParallelPlan(originalJobs);
  if (!plan.ok) throw new Error(plan.reason);

  let secondaryTab = null;
  try {
    await waitForParallelTab(primaryTabId, 10000);
    secondaryTab = await chrome.tabs.create({ url: MINIMAX_TTS_URL, active: false });
    const runId = `parallel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    parallelBatchState = {
      ...getDefaultParallelBatchState(),
      phase: 'preparing',
      runId,
      primaryTabId,
      secondaryTabId: secondaryTab.id,
      originalJobs,
      startedAt: Date.now()
    };
    await saveParallelBatchState();
    await waitForParallelTab(secondaryTab.id);

    await assertDirectTtsCapability(primaryTabId);
    await assertDirectTtsCapability(secondaryTab.id);

    const workers = plan.workers.map((worker, index) => ({
      ...worker,
      tabId: index === 0 ? primaryTabId : secondaryTab.id,
      currentIndex: 0,
      total: worker.queue.length,
      status: 'preparing',
      lastProgressAt: Date.now()
    }));

    await Promise.all(workers.map((worker) => {
      const firstEntry = worker.queue[0];
      return sendTabMessageWithTimeout(worker.tabId, {
        action: 'prepareParallelWorker',
        voiceId: firstEntry.voiceId,
        voiceName: firstEntry.voiceName,
        language: firstEntry.language || 'Auto'
      // A fresh secondary tab must load My Voices before applying an Instant Clone.
      // This is materially slower than the already-warm primary tab.
      }, 60000).then((response) => {
        if (!response?.success) throw new Error(response?.reason || 'Worker preflight failed');
      });
    }));

    parallelBatchState.workers = workers.map((worker) => ({
      ...worker,
      queue: getParallelQueueSnapshot(worker.queue)
    }));
    await saveParallelBatchState();
    return { runId, originalJobs, secondaryTab, workers };
  } catch (error) {
    await closeTabSafely(secondaryTab?.id);
    parallelBatchState = getDefaultParallelBatchState();
    await saveParallelBatchState();
    throw error;
  }
}

async function discardPreparedParallelBatch(prepared) {
  await closeTabSafely(prepared?.secondaryTab?.id);
  await loadParallelBatchState();
  if (parallelBatchState.phase !== 'preparing') return;
  if (prepared?.runId && parallelBatchState.runId !== prepared.runId) return;
  parallelBatchState = getDefaultParallelBatchState();
  await saveParallelBatchState();
}

async function startParallelBatchProcessing(jobs, primaryTabId, prepared = null) {
  let context = prepared;
  try {
    if (!context) context = await prepareParallelBatchProcessing(jobs, primaryTabId);
    const { runId, originalJobs, secondaryTab, workers } = context;

    parallelBatchState = {
      phase: 'running',
      isRunning: true,
      isPaused: false,
      isFallingBack: false,
      runId,
      primaryTabId,
      secondaryTabId: secondaryTab.id,
      originalJobs,
      workers: workers.map((worker) => ({
        ...worker,
        queue: getParallelQueueSnapshot(worker.queue),
        status: 'running'
      })),
      startedAt: Date.now()
    };
    await saveParallelBatchState();
    await chrome.alarms.create('parallelBatchWatchdog', { periodInMinutes: 0.5 });
    await broadcastParallelProgress();

    const startResults = await Promise.all(workers.map((worker) => {
      return sendTabMessageWithTimeout(worker.tabId, {
        action: 'startAutomation',
        queue: worker.queue,
        mode: 'multi',
        scriptName: null,
        runId,
        workerId: worker.workerId
      }, 10000);
    }));
    if (startResults.some((response) => !response?.success)) {
      throw new Error('Один из потоков не принял очередь');
    }

    return { success: true, parallel: true, runId, workerCount: workers.length };
  } catch (error) {
    if (parallelBatchState.isRunning) {
      const tabIds = parallelBatchState.workers.map((worker) => worker.tabId);
      const secondaryTabId = parallelBatchState.secondaryTabId;
      await Promise.allSettled(tabIds.map((tabId) => sendTabMessageWithTimeout(tabId, { action: 'stopAutomation' }, 7000)));
      const unconfirmedWorkers = [];
      for (const worker of parallelBatchState.workers) {
        try {
          await confirmAutomationStopped(worker.tabId, (runtime) => (
            runtime.runId === parallelBatchState.runId && runtime.workerId === worker.workerId
          ));
        } catch (stopError) {
          unconfirmedWorkers.push(worker.workerId);
        }
      }
      await chrome.alarms.clear('parallelBatchWatchdog');
      if (unconfirmedWorkers.length === 0) {
        parallelBatchState = getDefaultParallelBatchState();
        await saveParallelBatchState();
        await closeTabSafely(secondaryTabId);
      } else {
        parallelBatchState.isRunning = false;
        parallelBatchState.isPaused = false;
        parallelBatchState.error = `Parallel startup failed; Stop unconfirmed for workers: ${unconfirmedWorkers.join(', ')}`;
        await saveParallelBatchState();
      }
    } else {
      await closeTabSafely(context?.secondaryTab?.id);
    }
    return { success: false, parallel: false, reason: error.message };
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'parallelBatchWatchdog') return;
  queueParallelOperation(async () => {
    await loadParallelBatchState();
    if (!parallelBatchState.isRunning || parallelBatchState.isFallingBack) return;

    const now = Date.now();
    for (const worker of parallelBatchState.workers) {
      if (worker.status === 'complete') continue;
      if (!parallelBatchState.isPaused && now - Number(worker.lastProgressAt || parallelBatchState.startedAt || now) > 360000) {
        await fallbackParallelBatch('Поток не сообщил о прогрессе более 360 секунд');
        return;
      }
      try {
        const runtime = await sendTabMessageWithTimeout(worker.tabId, { action: 'getAutomationRuntimeState' }, 7000);
        if (!runtime?.success || !runtime.state?.isRunning || runtime.state.runId !== parallelBatchState.runId) {
          throw new Error('Worker runtime unavailable');
        }
      } catch (error) {
        await fallbackParallelBatch('Одна из вкладок перестала отвечать');
        return;
      }
    }
  }).catch((error) => console.error('[Background] Parallel watchdog failed:', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LONG_TEXT_ALARM) return;
  queueParallelOperation(() => pollLongTextTasks()).catch((error) => {
    console.error('[Background] Long Text polling failed:', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueParallelOperation(async () => {
    await loadParallelBatchState();
    if (!parallelBatchState.isRunning) return;
    if (!parallelBatchState.workers.some((worker) => worker.tabId === tabId)) return;

    if (tabId === parallelBatchState.primaryTabId && parallelBatchState.secondaryTabId) {
      parallelBatchState.primaryTabId = parallelBatchState.secondaryTabId;
      parallelBatchState.secondaryTabId = null;
      await saveParallelBatchState();
    }
    await fallbackParallelBatch('Одна из рабочих вкладок была закрыта');
  }).catch((error) => console.error('[Background] Parallel tab close handling failed:', error));
});

let batchState = {
  queue: [],
  activeTabId: null,
  isRunning: false,
  activeJob: null,
  recoveryRequired: false,
  error: null
};
let legacyBatchOperationQueue = Promise.resolve();

function queueLegacyBatchOperation(operation) {
  const result = legacyBatchOperationQueue.then(operation);
  legacyBatchOperationQueue = result.catch(() => {});
  return result;
}

// Загружаем состояние при старте воркера
async function loadBatchState() {
  try {
    const data = await chrome.storage.local.get('batchState');
    if (data.batchState) {
      batchState = {
        queue: [],
        activeTabId: null,
        isRunning: false,
        activeJob: null,
        recoveryRequired: false,
        error: null,
        ...data.batchState
      };
      console.log('[Background] Batch state loaded:', batchState);
    }
  } catch (e) {
    console.error('[Background] Error loading batch state:', e);
  }
}

// Сохраняем состояние в storage
async function saveBatchState() {
  await chrome.storage.local.set({ batchState });
  console.log('[Background] Batch state saved');
}

async function startLegacyBatchProcessing(jobs, tabId) {
  return queueLegacyBatchOperation(async () => {
    await loadBatchState();
    if (batchState.activeJob || batchState.recoveryRequired) {
      return { success: false, reason: 'legacy_batch_reconciliation_required' };
    }
    batchState = {
      queue: Array.isArray(jobs) ? jobs : [],
      activeTabId: tabId,
      isRunning: true,
      activeJob: null,
      recoveryRequired: false,
      error: null
    };
    await saveBatchState();
    return processNextBatchItemLocked();
  });
}

async function initializeLegacyBatchState() {
  await loadBatchState();
  if (!batchState.isRunning) return;
  if (batchState.activeJob) {
    let runtime = null;
    try {
      runtime = await sendTabMessageWithTimeout(
        batchState.activeTabId,
        { action: 'getAutomationRuntimeState' },
        7000
      );
    } catch (error) {}
    if (runtime?.success
      && runtime.state?.isRunning
      && runtime.state?.legacyJobId === batchState.activeJob.legacyJobId) {
      return;
    }
    batchState.isRunning = false;
    batchState.recoveryRequired = true;
    batchState.error = 'Active file was interrupted; automatic retry is blocked to prevent duplicate generation';
    await saveBatchState();
    return;
  }
  if (!batchState.activeTabId || batchState.queue.length === 0) {
    batchState.isRunning = false;
    await saveBatchState();
    return;
  }
  await processNextBatchItemLocked();
}

async function startLongTextAwareBatch(jobs, tabId, useParallel) {
  await Promise.all([loadBatchState(), loadParallelBatchState(), loadLongTextState()]);
  DiagLog.info('batch', 'Запуск пакета', {
    mode: useParallel ? 'parallel' : 'single',
    jobs: jobs.length,
    entries: jobs.reduce((sum, job) => sum + (job.queue?.length || 0), 0),
    longText: jobs.reduce((sum, job) => sum + (job.queue || []).filter((entry) => entry.isLongText).length, 0),
    tabId
  });
  assertLongTextLimits(jobs);
  if (batchState.activeJob || batchState.recoveryRequired) {
    return { success: false, reason: 'legacy_batch_reconciliation_required' };
  }
  if (parallelBatchState.runId) {
    return { success: false, reason: 'parallel_batch_reconciliation_required' };
  }
  await assertDirectTtsCapability(tabId);
  const unresolvedRegularSubmissions = await reconcileRegularSubmissionLedger(tabId);
  if (unresolvedRegularSubmissions.length > 0) {
    return { success: false, reason: 'regular_submission_reconciliation_required' };
  }
  if (batchState.isRunning || parallelBatchState.isRunning || getLongTextSummary().hasActive) {
    return { success: false, reason: 'automation_already_running' };
  }

  const { longTextEntries, regularJobs } = partitionLongTextJobs(jobs);
  let preparedParallel = null;
  let parallelFallbackReason = '';
  if (useParallel && regularJobs.length > 0) {
    const plan = buildParallelPlan(regularJobs);
    if (!plan.ok) {
      useParallel = false;
      parallelFallbackReason = plan.reason;
    } else {
      try {
        preparedParallel = await prepareParallelBatchProcessing(regularJobs, tabId);
      } catch (error) {
        return { success: false, parallel: false, reason: error.message };
      }
    }
  }
  let longTextResult;
  try {
    longTextResult = await submitLongTextEntries(longTextEntries, tabId);
  } catch (error) {
    await discardPreparedParallelBatch(preparedParallel);
    throw error;
  }
  let regularResult = { success: true, parallel: false };

  if (regularJobs.length > 0) {
    if (longTextStopRequested) {
      await discardPreparedParallelBatch(preparedParallel);
      throw new Error('Automation stopped before regular submission');
    }
    if (useParallel) {
      regularResult = await startParallelBatchProcessing(regularJobs, tabId, preparedParallel);
    } else {
      regularResult = await startLegacyBatchProcessing(regularJobs, tabId);
      if (parallelFallbackReason && regularResult.success !== false) {
        regularResult = { ...regularResult, fallback: true, reason: parallelFallbackReason };
      }
    }
  }

  const outcome = {
    ...regularResult,
    success: regularResult.success !== false,
    regularStarted: regularJobs.length > 0,
    longTextSubmitted: longTextResult.submitted,
    longTextFailed: longTextResult.failed
  };
  DiagLog.info('batch', 'Пакет запущен', outcome);
  return outcome;
}

// Инициализация при пробуждении Service Worker
queueLegacyBatchOperation(() => initializeLegacyBatchState()).catch((error) => {
  console.error('[Background] Legacy batch state initialization failed:', error);
});
queueParallelOperation(() => initializeParallelBatchState()).catch((error) => {
  console.error('[Background] Parallel batch state initialization failed:', error);
});
queueLongTextSubmission(() => initializeLongTextState()).catch((error) => {
  console.error('[Background] Long Text state initialization failed:', error);
});

// Слушаем команды от POPUP и CONTENT SCRIPT
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSubmissionRecoveryStatus') {
    Promise.all([loadBatchState(), loadParallelBatchState()])
      .then(() => getSubmissionRecoverySummary())
      .then((summary) => sendResponse({ success: true, summary: {
        ...summary,
        legacyRecoveryRequired: batchState.recoveryRequired === true,
        parallelRecoveryRequired: !parallelBatchState.isRunning && !!parallelBatchState.runId
      } }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === 'resolveSubmissionRecovery') {
    if (request.confirmed !== true) {
      sendResponse({ success: false, reason: 'confirmation_required' });
      return true;
    }
    queueParallelOperation(() => resolveSubmissionRecovery(request.tabId || null))
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === 'getLongTextStatus') {
    queueParallelOperation(async () => {
      await loadLongTextState();
      return getLongTextSummary();
    }).then((summary) => {
      sendResponse({ success: true, summary });
    }).catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === "getBatchStatus") {
    queueLegacyBatchOperation(async () => {
      await Promise.all([loadBatchState(), loadParallelBatchState()]);
      if (parallelBatchState.isRunning) {
        return {
          success: true,
          isRunning: true,
          isParallel: true,
          state: parallelBatchState,
          runtime: { ...getParallelProgress(), mode: 'multi' }
        };
      }
      if (!batchState.isRunning || !batchState.activeTabId) {
        return { success: true, isRunning: false, state: batchState };
      }

      let runtimeResponse = null;
      try {
        runtimeResponse = await sendTabMessageWithTimeout(
          batchState.activeTabId,
          { action: 'getAutomationRuntimeState' },
          7000
        );
      } catch (error) {}
      if (runtimeResponse?.success
        && runtimeResponse.state?.isRunning
        && runtimeResponse.state?.legacyJobId === batchState.activeJob?.legacyJobId) {
        return { success: true, isRunning: true, state: batchState, runtime: runtimeResponse.state };
      }

      batchState.isRunning = false;
      batchState.recoveryRequired = !!batchState.activeJob;
      batchState.error = batchState.activeJob
        ? 'Active file was interrupted; automatic retry is blocked to prevent duplicate generation'
        : null;
      await saveBatchState();
      await ensureAutomationStateLoaded();
      await saveAutomationState({
        progress: { ...(automationState.progress || {}), isRunning: false, isPaused: false }
      });
      return { success: true, isRunning: false, state: batchState };
    }).then(sendResponse).catch((error) => {
      console.error('[Background] getBatchStatus error:', error);
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  
  // 1. Команда от POPUP: Начать обработку списка файлов
  if (request.action === "startBatchProcessing") {
    extensionEnabledReady.then(() => {
      if (!extensionEnabled) return { success: false, reason: 'disabled' };
      console.log(`[Background] Получен пакет задач: ${request.jobs.length} файлов`);
      return queueParallelOperation(async () => {
        longTextStopRequested = false;
        return startLongTextAwareBatch(request.jobs, request.tabId, false);
      });
    }).then(sendResponse).catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === "startParallelBatchProcessing") {
    extensionEnabledReady.then(() => {
      if (!extensionEnabled) return { success: false, reason: 'disabled' };
      return queueParallelOperation(() => {
        longTextStopRequested = false;
        return startLongTextAwareBatch(request.jobs, request.tabId, true);
      });
    }).then(sendResponse)
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === 'automationProgress' && request.runId) {
    queueParallelOperation(() => updateParallelWorker(request, sender, false)).catch((error) => {
      console.error('[Background] Parallel progress failed:', error);
    });
    return;
  }

  if (request.action === 'automationProgress' && !request.runId) {
    queueLegacyBatchOperation(async () => {
      await loadBatchState();
      if (!batchState.activeJob) return;
      if (sender.tab?.id !== batchState.activeTabId) return;
      if (request.legacyJobId !== batchState.activeJob.legacyJobId) return;
      batchState.activeJob.queue = Array.isArray(request.queue) ? request.queue : batchState.activeJob.queue;
      batchState.activeJob.currentIndex = Number(request.currentIndex || 0);
      batchState.activeJob.lastProgressAt = Date.now();
      batchState.activeJob.phase = 'running';
      await saveBatchState();
    }).catch((error) => console.error('[Background] Legacy progress persistence failed:', error));
    return;
  }

  if (request.action === 'reservePaidSubmission' && request.runId) {
    queueParallelOperation(async () => {
      await loadParallelBatchState();
      if (!parallelBatchState.isRunning || parallelBatchState.runId !== request.runId) {
        throw new Error('parallel_run_not_active');
      }
      const worker = parallelBatchState.workers.find((item) => item.workerId === request.workerId);
      if (worker?.tabId !== sender.tab?.id) throw new Error('parallel_worker_owner_mismatch');
      const entry = worker?.queue?.find((item) => item._parallelKey === request.parallelKey);
      if (!entry) throw new Error('parallel_entry_not_found');
      entry.paidSubmissionStarted = true;
      entry.submittedAt = Number(request.submittedAt || Date.now());
      await saveParallelBatchState();
      return { success: true };
    }).then(sendResponse).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  if (request.action === 'reserveRegularSubmission') {
    const submissionId = String(request.submissionId || '');
    const ownerTabId = sender.tab?.id;
    if (!submissionId || !ownerTabId) {
      sendResponse({ success: false, reason: !submissionId ? 'submission_id_missing' : 'submission_owner_missing' });
      return;
    }
    queueRegularSubmissionLedger(() => saveRegularSubmission({
      submissionId,
      submittedAt: Number(request.submittedAt || Date.now()),
      runId: request.runId || null,
      workerId: request.workerId || null,
      parallelKey: request.parallelKey || null,
      text: String(request.text || ''),
      voiceId: String(request.voiceId || ''),
      voiceName: String(request.voiceName || ''),
      transport: String(request.transport || 'unknown'),
      phase: 'reserved',
      baselineAudioIds: Array.isArray(request.baselineAudioIds) ? request.baselineAudioIds.map(String) : [],
      speakerName: String(request.speakerName || ''),
      scriptName: request.scriptName || null,
      downloadIndex: Number(request.downloadIndex || 0),
      downloadLayout: request.downloadLayout || null,
      sourceFileName: request.sourceFileName || null,
      sourceFileBaseName: request.sourceFileBaseName || null,
      ownerTabId,
      completedAt: null
    })).then(() => sendResponse({ success: true })).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  if (request.action === 'markRegularSubmissionSent') {
    const submissionId = String(request.submissionId || '');
    queueRegularSubmissionLedger(async () => {
      const unresolved = await getUnresolvedRegularSubmissions();
      const entry = unresolved.find((item) => item.submissionId === submissionId);
      if (!entry) throw new Error('regular_submission_not_found');
      if (entry.ownerTabId !== sender.tab?.id) throw new Error('regular_submission_owner_mismatch');
      entry.phase = 'sent';
      entry.sentAt = Number(request.sentAt || Date.now());
      await saveRegularSubmission(entry);
    }).then(() => sendResponse({ success: true })).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  if (request.action === 'completeRegularSubmission') {
    queueRegularSubmissionLedger(async () => {
      const submissionId = String(request.submissionId || '');
      const unresolved = await getUnresolvedRegularSubmissions();
      const entry = unresolved.find((item) => item.submissionId === submissionId);
      if (!entry) return;
      if (entry.ownerTabId !== sender.tab?.id) throw new Error('regular_submission_owner_mismatch');
      await completeRegularSubmission(submissionId);
    })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === 'releasePaidSubmission' && request.runId) {
    queueParallelOperation(async () => {
      await loadParallelBatchState();
      if (parallelBatchState.runId !== request.runId) {
        throw new Error('parallel_run_not_active');
      }
      const worker = parallelBatchState.workers.find((item) => item.workerId === request.workerId);
      if (worker?.tabId !== sender.tab?.id) throw new Error('parallel_worker_owner_mismatch');
      const entry = worker?.queue?.find((item) => item._parallelKey === request.parallelKey);
      if (!entry) throw new Error('parallel_entry_not_found');
      entry.paidSubmissionStarted = false;
      entry.submittedAt = 0;
      const hasUnresolvedPaid = parallelBatchState.workers.some((item) => (
        (item.queue || []).some((queuedEntry) => queuedEntry.paidSubmissionStarted && !queuedEntry.downloadConfirmed)
      ));
      if (!parallelBatchState.isRunning && !hasUnresolvedPaid) {
        parallelBatchState = getDefaultParallelBatchState();
      }
      await saveParallelBatchState();
      return { success: true };
    }).then(sendResponse).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  if (request.action === 'reserveLongTextSubmission') {
    queueLongTextSubmission(async () => {
      if (longTextState.monitorTabId !== sender.tab?.id) throw new Error('long_text_submission_owner_mismatch');
      const task = longTextState.tasks.find((item) => item.localId === request.localId);
      if (!task || task.status !== 'submitting') throw new Error('long_text_task_not_submitting');
      task.submissionPhase = 'reserved';
      task.reservedAt = Number(request.reservedAt || Date.now());
      task.transport = String(request.transport || 'unknown');
      await saveLongTextState();
      return { success: true };
    }).then(sendResponse).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  if (request.action === 'markLongTextDispatched') {
    queueLongTextSubmission(async () => {
      if (longTextState.monitorTabId !== sender.tab?.id) throw new Error('long_text_submission_owner_mismatch');
      const task = longTextState.tasks.find((item) => item.localId === request.localId);
      if (!task || task.status !== 'submitting' || task.submissionPhase !== 'reserved') {
        throw new Error('long_text_task_not_reserved');
      }
      task.submissionPhase = 'dispatched';
      task.dispatchedAt = Number(request.dispatchedAt || Date.now());
      task.submissionStartedAt = task.dispatchedAt;
      task.submittedAt = task.dispatchedAt;
      await saveLongTextState();
      return { success: true };
    }).then(sendResponse).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  if (request.action === 'releaseLongTextReservation') {
    queueLongTextSubmission(async () => {
      if (longTextState.monitorTabId !== sender.tab?.id) throw new Error('long_text_submission_owner_mismatch');
      const task = longTextState.tasks.find((item) => item.localId === request.localId);
      if (!task) throw new Error('long_text_task_not_found');
      task.submissionPhase = null;
      task.reservedAt = null;
      task.dispatchedAt = null;
      task.submissionStartedAt = null;
      task.submittedAt = null;
      await saveLongTextState();
      return { success: true };
    }).then(sendResponse).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  if (request.action === 'markLongTextRejected') {
    queueLongTextSubmission(async () => {
      if (longTextState.monitorTabId !== sender.tab?.id) throw new Error('long_text_submission_owner_mismatch');
      const task = longTextState.tasks.find((item) => item.localId === request.localId);
      if (!task) throw new Error('long_text_task_not_found');
      task.submissionStartedAt = null;
      task.submittedAt = null;
      task.transport = 'direct_rejected';
      task.submissionPhase = 'rejected';
      task.reservedAt = null;
      task.dispatchedAt = null;
      task.error = String(request.reason || 'direct_long_text_rejected');
      await saveLongTextState();
      return { success: true };
    }).then(sendResponse).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  // 2. Сигнал от CONTENT SCRIPT: Текущий файл завершен
  if (request.action === "automationComplete") {
    if (request.runId) {
      queueParallelOperation(() => updateParallelWorker(request, sender, true)).catch((error) => {
        console.error('[Background] Parallel completion failed:', error);
      });
      return;
    }
    // Сначала обновляем состояние из storage (воркер мог спать)
    queueLegacyBatchOperation(async () => {
      await loadBatchState();
      if (!batchState.activeJob) return;
      if (sender.tab?.id !== batchState.activeTabId) return;
      if (request.legacyJobId !== batchState.activeJob.legacyJobId) return;
      if (request.success !== true) {
        batchState.isRunning = false;
        batchState.recoveryRequired = request.unresolved === true;
        batchState.error = request.error || 'Active file failed';
        if (request.unresolved === true) {
          batchState.activeJob.phase = 'unresolved';
        } else {
          batchState.activeJob = null;
          batchState.activeTabId = null;
        }
        await saveBatchState();
        return;
      }
      batchState.activeJob = null;
      batchState.recoveryRequired = false;
      batchState.error = null;
      batchState.isRunning = batchState.queue.length > 0;
      if (!batchState.isRunning) batchState.activeTabId = null;
      await saveBatchState();
      if (batchState.isRunning && batchState.queue.length > 0) {
        console.log(`[Background] Файл завершен. Осталось файлов: ${batchState.queue.length}`);
        
        setTimeout(() => {
          queueLegacyBatchOperation(() => processNextBatchItemLocked()).catch((error) => {
            console.error('[Background] Legacy next item failed:', error);
          });
        }, 3000);
      }
    }).catch((error) => console.error('[Background] Legacy completion failed:', error));
  }

  if (request.action === 'pauseBatchProcessing' || request.action === 'resumeBatchProcessing') {
    queueParallelOperation(async () => {
      await Promise.all([loadBatchState(), loadParallelBatchState()]);
      const action = request.action === 'pauseBatchProcessing' ? 'pauseAutomation' : 'resumeAutomation';
      const tabIds = parallelBatchState.isRunning
        ? parallelBatchState.workers.map((worker) => worker.tabId)
        : [batchState.activeTabId].filter(Boolean);
      if (tabIds.length === 0) throw new Error('automation_worker_missing');
      const acknowledgements = await Promise.allSettled(
        tabIds.map((tabId) => sendTabMessageWithTimeout(tabId, { action }, 7000))
      );
      const failedAcknowledgement = acknowledgements.find((result) => (
        result.status !== 'fulfilled' || result.value?.success !== true
      ));
      if (failedAcknowledgement) {
        const reason = failedAcknowledgement.status === 'rejected'
          ? failedAcknowledgement.reason?.message
          : failedAcknowledgement.value?.reason;
        throw new Error(reason || `${action}_not_acknowledged`);
      }
      if (parallelBatchState.isRunning) {
        parallelBatchState.isPaused = action === 'pauseAutomation';
        await saveParallelBatchState();
        await broadcastParallelProgress();
      }
      sendResponse({ success: true, isPaused: action === 'pauseAutomation' });
    }).catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  // 3. Команда остановки
  if (request.action === "stopAutomation") {
    longTextStopRequested = true;
    if (longTextState.monitorTabId) {
      chrome.tabs.sendMessage(longTextState.monitorTabId, { action: 'cancelLongTextSubmissions' }).catch(() => {});
    }
    queueParallelOperation(async () => {
      await Promise.all([loadBatchState(), loadParallelBatchState()]);
      if (parallelBatchState.isRunning) {
        const tabIds = parallelBatchState.workers.map((worker) => worker.tabId);
        const secondaryTabId = parallelBatchState.secondaryTabId;
        await Promise.allSettled(tabIds.map((tabId) => sendTabMessageWithTimeout(tabId, { action: 'stopAutomation' }, 7000)));
        await loadParallelBatchState();
        const unconfirmedWorkers = [];
        for (const worker of parallelBatchState.workers || []) {
          try {
            await confirmAutomationStopped(worker.tabId, (runtime) => (
              runtime.runId === parallelBatchState.runId && runtime.workerId === worker.workerId
            ));
          } catch (error) {
            unconfirmedWorkers.push(worker.workerId);
          }
        }
        if (unconfirmedWorkers.length > 0) {
          parallelBatchState.isRunning = false;
          parallelBatchState.isPaused = false;
          parallelBatchState.error = `Stop is unconfirmed for workers: ${unconfirmedWorkers.join(', ')}`;
          await saveParallelBatchState();
          sendResponse({
            success: false,
            stopped: false,
            recoveryRequired: true,
            reason: parallelBatchState.error
          });
          return;
        }
        const hasUnresolvedPaid = (parallelBatchState.workers || []).some((worker) => (
          (worker.queue || []).some((entry) => entry.paidSubmissionStarted && !entry.downloadConfirmed)
        ));
        if (hasUnresolvedPaid) {
          parallelBatchState.isRunning = false;
          parallelBatchState.isPaused = false;
          parallelBatchState.error = 'Stopped with paid submissions awaiting History reconciliation';
        } else {
          parallelBatchState = getDefaultParallelBatchState();
        }
        await saveParallelBatchState();
        await chrome.alarms.clear('parallelBatchWatchdog');
        await closeTabSafely(secondaryTabId);
        await saveAutomationState({
          progress: { currentIndex: 0, total: 0, completedIds: [], isRunning: false, isPaused: false, workerCount: 0 },
          mode: 'multi'
        });
        sendResponse({ success: true, stopped: true, reconciliationRequired: hasUnresolvedPaid });
        return;
      }
      return queueLegacyBatchOperation(async () => {
        await loadBatchState();
        const activeTabId = batchState.activeTabId;
        let deliveryError = null;

        if (activeTabId) {
          try {
            await chrome.tabs.sendMessage(activeTabId, { action: 'stopAutomation' });
          } catch (error) {
            deliveryError = error;
          }
        }

        batchState.isRunning = false;
        if (deliveryError && batchState.activeJob) {
          batchState.recoveryRequired = true;
          batchState.error = `Stop delivery failed; active file requires reconciliation: ${deliveryError.message}`;
        } else {
          batchState.queue = [];
          batchState.activeTabId = null;
          batchState.activeJob = null;
          batchState.recoveryRequired = false;
          batchState.error = null;
        }
        await saveBatchState();

        await ensureAutomationStateLoaded();
        await saveAutomationState({
          progress: {
            ...(automationState.progress || {}),
            isRunning: false,
            isPaused: false
          }
        });

        if (deliveryError) {
          sendResponse({
            success: false,
            stopped: false,
            recoveryRequired: !!batchState.activeJob,
            reason: deliveryError.message
          });
          return;
        }
        sendResponse({ success: true, stopped: true });
      });
    }).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }
});

// Функция отправки задачи во вкладку
async function processNextBatchItemLocked() {
  // Загружаем актуальное состояние
  await loadBatchState();
  
  if (!batchState.activeTabId || batchState.queue.length === 0 || batchState.activeJob) {
    console.log('[Background] No more items or no active tab');
    return;
  }

  const nextJob = batchState.queue.shift();
  const legacyJobId = `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  batchState.activeJob = {
    ...nextJob,
    legacyJobId,
    phase: 'dispatching',
    currentIndex: 0,
    dispatchedAt: Date.now()
  };
  batchState.recoveryRequired = false;
  batchState.error = null;
  await saveBatchState();
  
  console.log(`[Background] Запуск файла: ${nextJob.scriptName}`);

  try {
    // Uses the same recovery path as Long Text polling. A TTS tab can be open
    // before the extension reloads, leaving it without a content-script receiver.
    const response = await sendTabMessageWithTimeout(batchState.activeTabId, {
      action: 'startAutomation',
      queue: nextJob.queue,
      mode: nextJob.mode,
      scriptName: nextJob.scriptName,
      legacyJobId
    }, 15000);

    if (!response?.success) {
      throw new Error(response?.reason || 'start_automation_rejected');
    }

    batchState.activeJob.phase = 'running';
    await saveBatchState();
    return { success: true };
  } catch (error) {
    console.error('[Background] Failed to start automation in TTS tab:', error);
    batchState.isRunning = false;
    batchState.recoveryRequired = true;
    batchState.error = `Active file dispatch is unresolved: ${error.message}`;
    await saveBatchState();
    await ensureAutomationStateLoaded();
    await saveAutomationState({
      progress: {
        ...(automationState.progress || {}),
        isRunning: false,
        isPaused: false,
        error: error.message
      }
    });
    chrome.runtime.sendMessage({
      action: 'automationError',
      error: `Не удалось запустить в MiniMax: ${error.message}`
    }).catch(() => {});
    return { success: false, reason: error.message };
  }
}
