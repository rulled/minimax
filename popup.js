document.addEventListener('DOMContentLoaded', async () => {
  // ============================================
  // 1. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
  // ============================================
  const AVAILABLE_LANGUAGES = [
    "Auto", "English", "Arabic", "Cantonese", "Chinese (Mandarin)", "Dutch",
    "French", "German", "Indonesian", "Italian", "Japanese", "Korean",
    "Portuguese", "Russian", "Spanish", "Turkish", "Ukrainian", "Vietnamese",
    "Thai", "Polish", "Romanian", "Greek", "Czech", "Finnish", "Hindi",
    "Bulgarian", "Danish", "Hebrew", "Malay", "Persian", "Slovak",
    "Swedish", "Croatian", "Filipino", "Hungarian", "Norwegian",
    "Slovenian", "Catalan", "Nynorsk", "Tamil", "Afrikaans"
  ];
  const DEFAULT_MULTI_LANGUAGE = 'Auto';
  const LANGUAGE_CODE_TO_MINIMAX = {
    AF: 'Afrikaans',
    AR: 'Arabic',
    BG: 'Bulgarian',
    CA: 'Catalan',
    CS: 'Czech',
    DA: 'Danish',
    DE: 'German',
    EL: 'Greek',
    EN: 'English',
    ES: 'Spanish',
    FA: 'Persian',
    FI: 'Finnish',
    FIL: 'Filipino',
    FR: 'French',
    GR: 'Greek',
    HE: 'Hebrew',
    HI: 'Hindi',
    HR: 'Croatian',
    HU: 'Hungarian',
    ID: 'Indonesian',
    IT: 'Italian',
    JA: 'Japanese',
    KO: 'Korean',
    MS: 'Malay',
    NL: 'Dutch',
    NN: 'Nynorsk',
    NO: 'Norwegian',
    PL: 'Polish',
    PT: 'Portuguese',
    RO: 'Romanian',
    RU: 'Russian',
    SK: 'Slovak',
    SL: 'Slovenian',
    SV: 'Swedish',
    TA: 'Tamil',
    TH: 'Thai',
    TR: 'Turkish',
    UA: 'Ukrainian',
    UK: 'Ukrainian',
    VI: 'Vietnamese',
    ZH: 'Chinese (Mandarin)'
  };

  let parsedEntries = [];
  
  // Single Mode
  let selectedSpeaker = null;
  let excludedIds = new Set(); 
  let currentVoiceName = 'dictor'; 

  // Multi Mode
  let voiceMappings = {};
  let cachedSiteVoices = [];
  let multiExcludedIds = new Set();
  let activeMode = 'single';
  let parallelModeEnabled = false;

  // Батч-режим хранилище
  let batchFiles_Single = []; 
  let batchFiles_Multi = [];

  let uiStateSaveTimer = null;

  // ============================================
  // 2. ЭЛЕМЕНТЫ ИНТЕРФЕЙСА
  // ============================================
  
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  // Общие
  const toggleSwitch = document.getElementById('toggleSwitch');
  const toggleLabel = document.getElementById('toggleLabel');
  const status = document.getElementById('status');
  const automationStatus = document.getElementById('automationStatus');
  const automationControlsCard = document.getElementById('automationControlsCard');
  
  // Настройки
  const customVoiceSelect = document.getElementById('customVoiceSelect');
  const selectTrigger = customVoiceSelect.querySelector('.select-trigger');
  const currentVoiceLabel = document.getElementById('currentVoiceLabel');
  const voiceOptionsList = document.getElementById('voiceOptionsList');
  const newCustomNameInput = document.getElementById('newCustomName');
  const counterValue = document.getElementById('counterValue');
  const resetButton = document.getElementById('resetButton');
  const directTtsStatus = document.getElementById('directTtsStatus');
  const submissionRecoveryArea = document.getElementById('submissionRecoveryArea');
  const submissionRecoveryStatus = document.getElementById('submissionRecoveryStatus');
  const resolveSubmissionRecoveryButton = document.getElementById('resolveSubmissionRecoveryButton');
  const voiceCleanupQuota = document.getElementById('voiceCleanupQuota');
  const voiceCleanupCapacityFill = document.getElementById('voiceCleanupCapacityFill');
  const voiceCleanupDeleteButton = document.getElementById('voiceCleanupDeleteButton');
  const voiceCleanupStatus = document.getElementById('voiceCleanupStatus');

  // Автоозвучка (Single)
  const uploadButton = document.getElementById('uploadButton');
  const scriptFile = document.getElementById('scriptFile');
  const fileName = document.getElementById('fileName');
  const languageSelect = document.getElementById('languageSelect');
  const languageSelectorEl = document.getElementById('languageSelector');
  const speakerSelector = document.getElementById('speakerSelector');
  const previewContainer = document.getElementById('previewContainer');
  const previewList = document.getElementById('previewList');
  const selectionCount = document.getElementById('selectionCount');
  const toggleSelectionBtn = document.getElementById('toggleSelectionBtn');
  const startAutomationButton = document.getElementById('startAutomationButton');
  
  // Управление
  const pauseAutomationButton = document.getElementById('pauseAutomationButton');
  const stopAutomationButton = document.getElementById('stopAutomationButton');
  const skippedReportArea = document.getElementById('skippedReportArea');
  const longTextStatusArea = document.getElementById('longTextStatusArea');

  // Мульти-войс
  const multiUploadButton = document.getElementById('multiUploadButton');
  const multiScriptFile = document.getElementById('multiScriptFile');
  const multiFileName = document.getElementById('multiFileName');
  const multiConfigContainer = document.getElementById('multiConfigContainer');
  const voiceMappingList = document.getElementById('voiceMappingList');
  const multiVoicePrefixInput = document.getElementById('multiVoicePrefixInput');
  const refreshSiteVoicesButton = document.getElementById('refreshSiteVoicesButton');
  const siteVoicesStatus = document.getElementById('siteVoicesStatus');
  const voiceMappingInspectionStatus = document.getElementById('voiceMappingInspectionStatus');
  // Removed: const multiPreviewList = document.getElementById('multiPreviewList');
  // Removed: const multiSelectionCount = document.getElementById('multiSelectionCount');
  // Removed: const multiToggleSelectionBtn = document.getElementById('multiToggleSelectionBtn');
  const startMultiAutomationButton = document.getElementById('startMultiAutomationButton');
  const resetMultiButton = document.getElementById('resetMultiButton');
  const multiStatus = document.getElementById('multiStatus');
  const multiSkippedReportArea = document.getElementById('multiSkippedReportArea');
  const multiLongTextStatusArea = document.getElementById('multiLongTextStatusArea');
  const parallelModeToggle = document.getElementById('parallelModeToggle');
  const parallelModeStatus = document.getElementById('parallelModeStatus');

  // Батч элементы
  const batchFilesCounter_Single = document.getElementById('batchFilesCounter_Single');
  const batchFilesCountValue = document.getElementById('batchFilesCountValue');
  const addFileButton_Multi = document.getElementById('addFileButton_Multi');
  const batchFilesContainer_Multi = document.getElementById('batchFilesContainer_Multi');
  const batchFilesList_Multi = document.getElementById('batchFilesList_Multi');
  // Helpers для single mode batch (скрытые)
  const addFileButton_Single = document.getElementById('addFileButton_Single');
  const batchFilesContainer_Single = document.getElementById('batchFilesContainer_Single');

  // История
  const historyList = document.getElementById('historyList');
  const openFolderButton = document.getElementById('openFolderButton');
  const clearHistoryButton = document.getElementById('clearHistoryButton');

  // UI Modes
  const uploadModeSingle = document.getElementById('uploadMode_Single');
  const pasteModeSingle = document.getElementById('pasteMode_Single');
  const switchToPasteSingle = document.getElementById('switchToPaste_Single');
  const pasteTextareaSingle = document.getElementById('pasteTextarea_Single');
  const processPasteBtnSingle = document.getElementById('processPasteBtn_Single');
  const cancelPasteBtnSingle = document.getElementById('cancelPasteBtn_Single');

  const uploadModeMulti = document.getElementById('uploadMode_Multi');
  const pasteModeMulti = document.getElementById('pasteMode_Multi');
  const switchToPasteMulti = document.getElementById('switchToPaste_Multi');
  const pasteTextareaMulti = document.getElementById('pasteTextarea_Multi');
  const processPasteBtnMulti = document.getElementById('processPasteBtn_Multi');
  const cancelPasteBtnMulti = document.getElementById('cancelPasteBtn_Multi');


  // ============================================
  // 3. ИНИЦИАЛИЗАЦИЯ
  // ============================================
  
  const data = await chrome.storage.local.get([
    'tabVoices',
    'customNames',
    'extensionEnabled',
    'voiceMappings',
    'multiVoicePrefix',
    'cachedSiteVoices',
    'parallelModeEnabled',
    'directTtsLastResult'
  ]);
  let extensionEnabled = data.extensionEnabled !== false;
  const customNames = data.customNames || [];
  voiceMappings = data.voiceMappings || {}; 
  cachedSiteVoices = Array.isArray(data.cachedSiteVoices)
      ? data.cachedSiteVoices.filter(voice => voice && typeof voice === 'object' && voice.voiceId && voice.voiceName)
      : [];
  parallelModeEnabled = data.parallelModeEnabled === true;

  let tabId = 'fallback-tab';
  try {
    const t = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t[0]?.id) tabId = String(t[0].id);
  } catch (e) {}

  if (data.tabVoices && data.tabVoices[tabId]) {
    currentVoiceName = data.tabVoices[tabId];
  }

  renderVoiceSelector(customNames);
  updateToggleSwitch(extensionEnabled);
  updateCounterDisplay();
  initLanguageSelector();
  if (multiVoicePrefixInput) multiVoicePrefixInput.value = data.multiVoicePrefix || 'mp';
  if (parallelModeToggle) parallelModeToggle.checked = parallelModeEnabled;
  const lastDirectResult = data.directTtsLastResult;
  if (directTtsStatus) {
      const modeLabel = 'Транспорт: прямой API.';
      if (lastDirectResult) {
          const code = lastDirectResult.code == null ? '' : ` · code ${lastDirectResult.code}`;
          directTtsStatus.textContent = `${modeLabel} Последний: ${lastDirectResult.mode} / ${lastDirectResult.disposition}${code}`;
      } else {
          directTtsStatus.textContent = modeLabel;
      }
  }
  await refreshSubmissionRecoveryStatus();
  if (parallelModeStatus && parallelModeEnabled) {
      parallelModeStatus.textContent = 'При запуске откроется вторая вкладка MiniMax.';
  }
  renderSiteVoicesStatus(cachedSiteVoices.length ? `Загружено голосов: ${cachedSiteVoices.length}` : 'Нажмите «Обновить», чтобы подтянуть My Voices.', cachedSiteVoices.length ? 'success' : '');
  await loadBatchFiles();
  const automationRunning = await restoreAutomationState();
  await restoreUiState(automationRunning);
  await loadSkippedEntries();
  syncSingleBatchUi();
  ensureSingleEmptyUi();

  function renderVoiceCleanupStatus(message, type = '') {
      if (!voiceCleanupStatus) return;
      voiceCleanupStatus.textContent = message || '';
      voiceCleanupStatus.className = `voice-source-status${type ? ` ${type}` : ''}`;
  }

  async function refreshSubmissionRecoveryStatus() {
      if (!submissionRecoveryArea || !submissionRecoveryStatus) return;
      const response = await chrome.runtime.sendMessage({ action: 'getSubmissionRecoveryStatus' }).catch(() => null);
      const summary = response?.summary;
      const hasRecovery = response?.success && (
          summary.total > 0 || summary.legacyRecoveryRequired || summary.parallelRecoveryRequired
      );
      submissionRecoveryArea.style.display = hasRecovery ? 'block' : 'none';
      if (!hasRecovery) return;
      submissionRecoveryStatus.textContent = `Требуется сверка History: regular ${summary.regular}, Long Text ${summary.longText}.`;
  }

  if (resolveSubmissionRecoveryButton) {
      resolveSubmissionRecoveryButton.addEventListener('click', async () => {
          const confirmed = confirm(
              'Подтвердите, что вы проверили MiniMax History. Ненайденные задачи будут сняты с блокировки без автоматического повтора.'
          );
          if (!confirmed) return;
          const tabs = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
          const response = await chrome.runtime.sendMessage({
              action: 'resolveSubmissionRecovery',
              confirmed: true,
              tabId: tabs[0]?.id || null
          }).catch((error) => ({ success: false, reason: error.message }));
          if (!response?.success) {
              showStatus(`Не удалось снять блокировку: ${response?.reason || 'unknown error'}`, 'error');
              return;
          }
          showStatus('Блокировка снята без повторной генерации', 'success');
          await refreshSubmissionRecoveryStatus();
      });
  }

  function getProtectedVoiceNames() {
      return [...new Set([
          currentVoiceName,
          ...Object.values(data.tabVoices || {}),
          ...Object.values(voiceMappings)
      ].map(value => String(value?.voiceName || value || '').trim()).filter(Boolean))];
  }

  function getProtectedVoiceIds() {
      return [...new Set(Object.values(voiceMappings).map(value => String(value?.voiceId || '').trim()).filter(Boolean))];
  }

  async function getActiveMinimaxTab() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (!activeTab?.id || !String(activeTab.url || '').startsWith('https://www.minimax.io/audio/')) {
          throw new Error('Откройте активной вкладку MiniMax Audio');
      }
      return activeTab;
  }

  function renderVoiceCleanupQuota(equity) {
      const used = Number(equity?.used || 0);
      const total = Number(equity?.total || 0);
      if (voiceCleanupQuota) {
          voiceCleanupQuota.textContent = total
              ? `${used}/${total} занято · ${Math.max(0, total - used)} свободно`
              : 'данные о слотах недоступны';
      }
      if (voiceCleanupCapacityFill) {
          const percentage = total ? Math.min(100, Math.max(0, used / total * 100)) : 0;
          voiceCleanupCapacityFill.style.width = `${percentage}%`;
      }
  }

  async function refreshVoiceCleanupQuota() {
      try {
          const tab = await getActiveMinimaxTab();
          const response = await chrome.tabs.sendMessage(tab.id, {
              action: 'voiceCleanupPreview',
              count: 20,
              protectedVoiceNames: getProtectedVoiceNames(),
              protectedVoiceIds: getProtectedVoiceIds()
          });
          if (response?.success) renderVoiceCleanupQuota(response.equity);
      } catch (error) {
          // The cleanup control remains usable when a MiniMax tab becomes active later.
      }
  }

  async function deleteOldestVoices() {
      voiceCleanupDeleteButton.disabled = true;
      voiceCleanupDeleteButton.textContent = 'Проверяю...';
      renderVoiceCleanupStatus('');
      try {
          const tab = await getActiveMinimaxTab();
          const preview = await chrome.tabs.sendMessage(tab.id, {
              action: 'voiceCleanupPreview',
              count: 20,
              protectedVoiceNames: getProtectedVoiceNames(),
              protectedVoiceIds: getProtectedVoiceIds()
          });
          if (!preview?.success) throw new Error(preview?.reason || 'Не удалось получить список голосов');
          renderVoiceCleanupQuota(preview.equity);

          const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
          if (candidates.length === 0) throw new Error('Нет старых Instant Clone для удаления');
          if (!confirm(`Удалить ${candidates.length} самых старых Instant Clone? Отменить это действие нельзя.`)) {
              renderVoiceCleanupStatus('Удаление отменено.');
              return;
          }

          voiceCleanupDeleteButton.textContent = 'Удаляю...';
          renderVoiceCleanupStatus('Не закрывайте MiniMax...');
          const response = await chrome.tabs.sendMessage(tab.id, {
              action: 'voiceCleanupDelete',
              candidates,
              protectedVoiceNames: getProtectedVoiceNames(),
              protectedVoiceIds: getProtectedVoiceIds()
          });
          const deletedCount = Array.isArray(response?.deleted) ? response.deleted.length : 0;
          if (response?.equity) renderVoiceCleanupQuota(response.equity);
          if (!response?.success) {
              if (deletedCount > 0 && !response?.equity) {
                  if (voiceCleanupQuota) voiceCleanupQuota.textContent = 'слоты изменились · требуется обновление';
                  if (voiceCleanupCapacityFill) voiceCleanupCapacityFill.style.width = '0%';
              }
              throw new Error(`${response?.reason || 'Удаление остановлено'}. Удалено: ${deletedCount}`);
          }
          cachedSiteVoices = [];
          await chrome.storage.local.set({ cachedSiteVoices: [] });
          renderSiteVoicesStatus('Список голосов изменился. Нажмите «Обновить».');
          renderVoiceCleanupStatus(`Удалено: ${deletedCount}.`, 'success');
      } catch (error) {
          renderVoiceCleanupStatus(error.message, 'error');
      } finally {
          voiceCleanupDeleteButton.disabled = false;
          voiceCleanupDeleteButton.textContent = 'Удалить 20 старых голосов';
      }
  }

  if (voiceCleanupDeleteButton) voiceCleanupDeleteButton.addEventListener('click', deleteOldestVoices);
  refreshVoiceCleanupQuota();

  // ============================================
  // 4. ЛОГИКА ВКЛАДОК
  // ============================================
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });

  function switchTab(targetId) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === targetId));
    tabContents.forEach(tc => tc.classList.toggle('active', tc.id === targetId));
    
    if (targetId === 'history') loadDownloadHistory();
    if (targetId === 'automation') activeMode = 'single';
    if (targetId === 'multivoice') activeMode = 'multi';

    scheduleSaveUiState();
  }

  function initLanguageSelector() {
    const fillSelect = (sel) => {
        if(!sel) return;
        sel.innerHTML = '';
        AVAILABLE_LANGUAGES.forEach(lang => {
           const opt = document.createElement('option');
           opt.value = lang;
           opt.textContent = lang;
            if (lang === 'Auto') opt.selected = true;
           sel.appendChild(opt);
        });
    };
    fillSelect(languageSelect);

    chrome.storage.local.get(['selectedLanguage'], (d) => {
        if (d.selectedLanguage && languageSelect) languageSelect.value = d.selectedLanguage;
    });

    if(languageSelect) languageSelect.addEventListener('change', () => chrome.storage.local.set({ selectedLanguage: languageSelect.value }));
  }

  function collectUiState() {
      const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'settings';
      return {
          activeTab,
          activeMode,
          fileNameText: fileName?.textContent || '',
          multiFileNameText: multiFileName?.textContent || '',
          pasteModeSingle: pasteModeSingle?.style.display === 'block',
          pasteModeMulti: pasteModeMulti?.style.display === 'block'
      };
  }

  function renderSiteVoicesStatus(message, type = '') {
      if (!siteVoicesStatus) return;
      siteVoicesStatus.textContent = message || '';
      siteVoicesStatus.className = `voice-source-status${type ? ` ${type}` : ''}`;
  }

  function normalizeLookupText(value) {
      return VoiceMappingResolver.normalize(value);
  }

  function getVoiceMappingKey(speaker, languageCode = '') {
      const normalizedSpeaker = String(speaker || '').trim();
      const normalizedLanguage = String(languageCode || '').trim().toUpperCase();
      return normalizedLanguage ? `${normalizedLanguage}::${normalizedSpeaker}` : normalizedSpeaker;
  }

  function getVoiceMappingValue(speaker, languageCode = '') {
      const scopedKey = getVoiceMappingKey(speaker, languageCode);
      if (voiceMappings[scopedKey]) return voiceMappings[scopedKey];
      if (String(languageCode || '').trim()) return '';
      return voiceMappings[String(speaker || '').trim()] || '';
  }

  function getMappingVoiceName(mapping) {
      return String(mapping?.voiceName || mapping || '').trim();
  }

  function getMappingVoiceId(mapping) {
      return String(mapping?.voiceId || '').trim();
  }

  function findUniqueVoiceByName(voiceName, voices = cachedSiteVoices) {
      const matches = voices.filter(voice => voice.voiceName === String(voiceName || '').trim());
      return matches.length === 1 ? matches[0] : null;
  }

  function migrateLegacyVoiceMappings(currentVoices) {
      let changed = false;
      Object.entries(voiceMappings).forEach(([key, mapping]) => {
          if (typeof mapping !== 'string' || !mapping.trim()) return;
          const match = findUniqueVoiceByName(mapping, currentVoices);
          if (!match) return;
          voiceMappings[key] = { voiceId: match.voiceId, voiceName: match.voiceName };
          changed = true;
      });
      return changed;
  }

  function getEntryLanguageCode(entry, file = null) {
      const entryCode = String(entry?.languageCode || '').trim().toUpperCase();
      if (entryCode) return entryCode;
      return String(file?.languageCode || '').trim().toUpperCase();
  }

  function getEntryMinimaxLanguage(entry, file = null) {
      const explicit = normalizeMinimaxLanguage(entry?.minimaxLanguage || '');
      if (explicit) return explicit;
      const fromEntryCode = resolveMinimaxLanguageFromCode(getEntryLanguageCode(entry, file));
      if (fromEntryCode) return fromEntryCode;
      const fromFile = normalizeMinimaxLanguage(file?.language || '');
      if (fromFile) return fromFile;
      return getDefaultMultiLanguage();
  }

  function getFileLanguageSummary(file) {
      const codes = new Set();
      const minimaxLanguages = new Set();

      (file?.entries || []).forEach((entry) => {
          const code = getEntryLanguageCode(entry, file);
          const lang = getEntryMinimaxLanguage(entry, file);
          if (code) codes.add(code);
          if (lang) minimaxLanguages.add(lang);
      });

      return {
          codes: [...codes],
          minimaxLanguages: [...minimaxLanguages],
          isMixed: codes.size > 1 || minimaxLanguages.size > 1
      };
  }

  function findBestCachedVoiceMatch(speaker, languageCode = '') {
      if (!Array.isArray(cachedSiteVoices) || cachedSiteVoices.length === 0) return '';
      const result = VoiceMappingResolver.resolveVoice(
          speaker,
          languageCode,
          cachedSiteVoices,
          multiVoicePrefixInput?.value || 'mp'
      );
      return result.status === 'ok' ? result.voice : '';
  }

  function ensureAutoVoiceMappings() {
      let changed = false;

      batchFiles_Multi.forEach(file => {
          file.entries.forEach(entry => {
              const languageCode = getEntryLanguageCode(entry, file);
              const existingValue = getVoiceMappingValue(entry.speaker, languageCode);
              if (existingValue) return;

              const matchedVoice = findBestCachedVoiceMatch(entry.speaker, languageCode);
              if (!matchedVoice) return;

              const scopedKey = getVoiceMappingKey(entry.speaker, languageCode);
              voiceMappings[scopedKey] = matchedVoice;
              changed = true;
          });
      });

      if (changed) {
          chrome.storage.local.set({ voiceMappings });
          saveState();
          saveBatchFiles();
          // Автомаппинг меняет сводку голосов на карточках файлов — перерисовываем,
          // иначе карточки остаются с устаревшим «Голоса не назначены».
          renderBatchFilesList('multi');
      }
  }

  function buildVoiceMappingPlan() {
      const mappings = new Map();
      batchFiles_Multi.forEach(file => {
          file.entries.forEach(entry => {
              if (file.excludedIds.has(entry.id)) return;
              const languageCode = getEntryLanguageCode(entry, file);
              const key = getVoiceMappingKey(entry.speaker, languageCode);
              const mapping = getVoiceMappingValue(entry.speaker, languageCode);
              if (!mappings.has(key)) {
                  mappings.set(key, {
                      key,
                      speaker: entry.speaker,
                      languageCode,
                      voiceId: getMappingVoiceId(mapping),
                      voiceName: getMappingVoiceName(mapping),
                      entryCount: 0,
                      files: []
                  });
              }
              const item = mappings.get(key);
              item.entryCount += 1;
              if (!item.files.includes(file.name)) item.files.push(file.name);
          });
      });
      return {
          prefix: String(multiVoicePrefixInput?.value || 'mp').trim(),
          fileCount: batchFiles_Multi.length,
          mappings: [...mappings.values()]
      };
  }

  function renderVoiceMappingInspection(result, unavailable = false) {
      if (!voiceMappingInspectionStatus) return;
      if (unavailable) {
          voiceMappingInspectionStatus.textContent = 'Live-проверка недоступна. Запуск заблокирован до восстановления связи с MiniMax.';
          voiceMappingInspectionStatus.className = 'voice-source-status error';
          return;
      }
      const totals = result?.totals || {};
      voiceMappingInspectionStatus.textContent = result?.valid
          ? `Проверено: ${totals.entries || 0} реплик, ${totals.mappings || 0} маппингов. Ошибок нет.`
          : `Маппинг заблокирован: missing ${totals.missing || 0}, stale ${totals.stale || 0}, unavailable ${totals.unavailable || 0}, ambiguous ${totals.ambiguous || 0}, not found ${totals.notFound || 0}.`;
      voiceMappingInspectionStatus.className = `voice-source-status ${result?.valid ? 'success' : 'error'}`;
  }

  async function inspectVoiceMappingPlan() {
      const tabId = await getMinimaxTabId();
      if (!tabId) {
          throw new Error('Откройте MiniMax TTS для live-проверки маппинга');
      }
      const response = await chrome.tabs.sendMessage(tabId, {
          action: 'inspectVoiceMappingPlan',
          plan: buildVoiceMappingPlan()
      }).catch((error) => ({ success: false, reason: error?.message || 'mapping_inspection_unavailable' }));
      if (!response?.success) {
          renderVoiceMappingInspection(null, true);
          throw new Error(response?.reason || 'Не удалось проверить маппинг');
      }
      renderVoiceMappingInspection(response);
      return { available: true, ...response };
  }

  function applyVoiceMappingValue(speaker, rawValue, languageCode = '') {
      const value = String(rawValue || '').trim();
      const scopedKey = getVoiceMappingKey(speaker, languageCode);
      const matchedVoice = findUniqueVoiceByName(value);
      voiceMappings[scopedKey] = matchedVoice
          ? { voiceId: matchedVoice.voiceId, voiceName: matchedVoice.voiceName }
          : value;

      chrome.storage.local.set({ voiceMappings });
      saveState();
      saveBatchFiles();
      renderBatchFilesList('multi');
  }

  async function fetchSiteVoices() {
      renderSiteVoicesStatus('Читаю My Voices со страницы MiniMax...');
      if (refreshSiteVoicesButton) refreshSiteVoicesButton.disabled = true;

      try {
          const prefix = String(multiVoicePrefixInput?.value || 'mp').trim();
          await chrome.storage.local.set({ multiVoicePrefix: prefix });

          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const activeTab = tabs[0];
          if (!activeTab?.id || !String(activeTab.url || '').startsWith('https://www.minimax.io/')) {
              renderSiteVoicesStatus('Откройте активной вкладку MiniMax TTS и нажмите «Обновить».', 'error');
              return;
          }

          const response = await chrome.tabs.sendMessage(activeTab.id, {
              action: 'listMyVoices'
          }).catch((error) => ({
              success: false,
              reason: error?.message || 'content_script_unavailable'
          }));

          if (!response?.success) {
              renderSiteVoicesStatus(`Не удалось прочитать My Voices: ${response?.reason || 'unknown error'}`, 'error');
              return;
          }

          const currentVoices = Array.isArray(response.voices) ? response.voices : [];
          cachedSiteVoices = currentVoices.filter(voice => Number(voice.voiceStatus) === 2)
              .filter(voice => !prefix || normalizeLookupText(voice.voiceName).includes(normalizeLookupText(prefix)));
          const mappingsChanged = migrateLegacyVoiceMappings(currentVoices);
          await chrome.storage.local.set({ cachedSiteVoices, ...(mappingsChanged ? { voiceMappings } : {}) });
          renderSiteVoicesStatus(
              cachedSiteVoices.length
                  ? `Загружено голосов: ${cachedSiteVoices.length}`
                  : `По префиксу "${prefix || 'без фильтра'}" ничего не найдено.`,
              cachedSiteVoices.length ? 'success' : ''
          );

          if (batchFiles_Multi.length) {
              renderMultiVoiceUI();
          }
      } finally {
          if (refreshSiteVoicesButton) refreshSiteVoicesButton.disabled = false;
      }
  }

  async function preflightQueueVoices(batchJobs, tabId) {
      const hasMappedVoices = batchJobs.some(job => (job.queue || []).some(entry => (
          String(entry.voiceId || '').trim() || String(entry.voiceName || '').trim()
      )));
      if (!hasMappedVoices) return;
      const response = await chrome.tabs.sendMessage(tabId, { action: 'listMyVoices' }).catch((error) => ({
          success: false,
          reason: error?.message || 'content_script_unavailable'
      }));
      if (!response?.success) {
          throw new Error(`Не удалось проверить My Voices: ${response?.reason || 'unknown error'}`);
      }

      const voicesById = new Map((response.voices || []).map(voice => [String(voice.voiceId || ''), voice]));
      let mappingsChanged = migrateLegacyVoiceMappings(response.voices || []);
      for (const job of batchJobs) {
          for (const entry of job.queue || []) {
              let voiceId = String(entry.voiceId || '').trim();
              const voiceName = String(entry.voiceName || '').trim();
              if (!voiceId && !voiceName) continue;
              if (!voiceId) {
                  const match = findUniqueVoiceByName(voiceName, response.voices || []);
                  if (!match) {
                      throw new Error(`Голос для «${entry.speaker || 'спикер'}» отсутствует или неоднозначен: ${voiceName}`);
                  }
                  entry.voiceId = match.voiceId;
                  entry.voiceName = match.voiceName;
                  voiceId = match.voiceId;
              }
              const currentVoice = voicesById.get(voiceId);
              if (!currentVoice || Number(currentVoice.voiceStatus) !== 2) {
                  throw new Error(`Голос для «${entry.speaker || 'спикер'}» недоступен: ${voiceName || voiceId}`);
              }
              entry.voiceName = currentVoice.voiceName;
          }
      }
      Object.entries(voiceMappings).forEach(([key, mapping]) => {
          const voiceId = getMappingVoiceId(mapping);
          const currentVoice = voicesById.get(voiceId);
          if (!currentVoice || getMappingVoiceName(mapping) === currentVoice.voiceName) return;
          voiceMappings[key] = { voiceId: currentVoice.voiceId, voiceName: currentVoice.voiceName };
          mappingsChanged = true;
      });
      if (mappingsChanged) await chrome.storage.local.set({ voiceMappings });
  }

  async function preflightGenerationCredit(batchJobs, tabId) {
      const requestedCharacters = batchJobs.reduce((total, job) => (
          total + (job.queue || []).reduce((sum, entry) => {
              const length = String(entry.text || '').length;
              return length > 0 && length <= 200000 ? sum + length : sum;
          }, 0)
      ), 0);
      if (requestedCharacters === 0) return;
      const response = await chrome.tabs.sendMessage(tabId, {
          action: 'getGenerationCredit',
          requestedCharacters
      }).catch((error) => ({
          success: false,
          reason: error?.message || 'content_script_unavailable'
      }));
      if (!response?.success) {
          throw new Error(`Не удалось проверить кредиты MiniMax: ${response?.reason || 'unknown error'}`);
      }
      if (!response.sufficient) {
          throw new Error(
              `Недостаточно кредитов MiniMax: нужно ${response.requiredCredit}, доступно ${response.totalCredit}`
          );
      }
  }

  function getDefaultMultiLanguage() {
      return DEFAULT_MULTI_LANGUAGE;
  }

  function createLanguageSelectElement(currentValue, onChange) {
      const select = document.createElement('select');
      select.className = 'input';
      AVAILABLE_LANGUAGES.forEach((lang) => {
          const option = document.createElement('option');
          option.value = lang;
          option.textContent = lang;
          if (lang === currentValue) option.selected = true;
          select.appendChild(option);
      });
      select.addEventListener('change', onChange);
      return select;
  }

  function scheduleSaveUiState() {
      if (uiStateSaveTimer) clearTimeout(uiStateSaveTimer);
      uiStateSaveTimer = setTimeout(async () => {
          const uiState = collectUiState();
          await chrome.storage.local.set({ uiState });
      }, 250);
  }

  async function restoreUiState(automationRunning) {
      const d = await chrome.storage.local.get('uiState');
      const uiState = d.uiState;
      if (!uiState) return;

      if (uiState.fileNameText && fileName) fileName.textContent = uiState.fileNameText;
      if (uiState.multiFileNameText && multiFileName) multiFileName.textContent = uiState.multiFileNameText;

      if (!automationRunning && uiState.activeTab) {
          switchTab(uiState.activeTab);
      }

      if (uiState.pasteModeSingle) togglePasteMode('single', true);
      if (uiState.pasteModeMulti) togglePasteMode('multi', true);
  }

  // ============================================
  // 5. НАСТРОЙКИ ГОЛОСА
  // ============================================

  function renderVoiceSelector(names) {
    voiceOptionsList.innerHTML = '';
    const defaults = ['dictor', 'doctor'];
    const allOptions = [...defaults, ...names];
    currentVoiceLabel.textContent = currentVoiceName;

    allOptions.forEach(name => {
      const div = document.createElement('div');
      div.className = `select-option ${name === currentVoiceName ? 'selected' : ''}`;
      div.innerHTML = `<span>${name}</span>`;
      
      if (!defaults.includes(name)) {
        const delBtn = document.createElement('div');
        delBtn.className = 'option-delete-btn';
        delBtn.innerHTML = '✕'; 
        delBtn.onclick = (e) => { e.stopPropagation(); deleteCustomName(name); };
        div.appendChild(delBtn);
      }
      
      div.onclick = () => {
          currentVoiceName = name;
          chrome.storage.local.get('tabVoices').then(d => {
              const tv = d.tabVoices || {};
              tv[tabId] = name;
              chrome.storage.local.set({tabVoices: tv});
          });
          customVoiceSelect.classList.remove('open');
          renderVoiceSelector(names);
          updateCounterDisplay();
      };
      voiceOptionsList.appendChild(div);
    });
  }

  selectTrigger.onclick = () => customVoiceSelect.classList.toggle('open');
  document.addEventListener('click', (e) => {
    if (!customVoiceSelect.contains(e.target)) customVoiceSelect.classList.remove('open');
  });

  if(newCustomNameInput) {
      newCustomNameInput.addEventListener('keydown', async (e) => {
          if(e.key === 'Enter') {
              const name = newCustomNameInput.value.trim();
              if(!name) return;
              const d = await chrome.storage.local.get('customNames');
              const names = d.customNames || [];
              if(!names.includes(name)) {
                  names.push(name);
                  await chrome.storage.local.set({customNames: names});
              }
              currentVoiceName = name;
              const tv = (await chrome.storage.local.get('tabVoices')).tabVoices || {};
              tv[tabId] = name;
              await chrome.storage.local.set({tabVoices: tv});
              
              renderVoiceSelector(names);
              updateCounterDisplay();
              newCustomNameInput.value = '';
              customVoiceSelect.classList.remove('open');
              showStatus(`Выбрано: "${name}"`, 'success');
          }
      });
  }

  async function deleteCustomName(name) {
      if(!confirm(`Удалить "${name}"?`)) return;
      const d = await chrome.storage.local.get('customNames');
      const names = (d.customNames||[]).filter(n => n!==name);
      await chrome.storage.local.set({customNames: names});
      if(currentVoiceName === name) {
          currentVoiceName = 'dictor';
          const tv = (await chrome.storage.local.get('tabVoices')).tabVoices || {};
          tv[tabId] = 'dictor';
          await chrome.storage.local.set({tabVoices: tv});
      }
      renderVoiceSelector(names);
  }
  
  async function updateCounterDisplay() {
      const d = await chrome.storage.local.get('fileCounters');
      counterValue.textContent = (d.fileCounters?.[currentVoiceName] || 0) + 1;
  }
  
  function selectCounterText(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
  }

  async function commitCounterEdit() {
      const raw = counterValue.textContent.trim();
      const val = parseInt(raw, 10);
      if (isNaN(val) || val < 1) {
          await updateCounterDisplay();
          return;
      }
      const d = await chrome.storage.local.get('fileCounters');
      const fc = d.fileCounters || {};
      fc[currentVoiceName] = val - 1;
      await chrome.storage.local.set({fileCounters: fc});
      await updateCounterDisplay();
      scheduleSaveUiState();
  }

  function endCounterEdit(commit) {
      counterValue.contentEditable = 'false';
      counterValue.classList.remove('editing');
      if (commit) commitCounterEdit(); else updateCounterDisplay();
  }

  if (counterValue) {
      counterValue.addEventListener('click', () => {
          counterValue.contentEditable = 'true';
          counterValue.classList.add('editing');
          counterValue.focus();
          selectCounterText(counterValue);
      });
      counterValue.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
              e.preventDefault();
              endCounterEdit(true);
          } else if (e.key === 'Escape') {
              e.preventDefault();
              endCounterEdit(false);
          }
      });
      counterValue.addEventListener('blur', () => endCounterEdit(true));
  }
  
  if(resetButton) resetButton.onclick = async () => {
      if(confirm('Сбросить счетчик?')) {
          const d = await chrome.storage.local.get('fileCounters');
          const fc = d.fileCounters || {};
          delete fc[currentVoiceName];
          await chrome.storage.local.set({fileCounters: fc});
          updateCounterDisplay();
          scheduleSaveUiState();
      }
  };

  toggleSwitch.addEventListener('change', () => {
      extensionEnabled = toggleSwitch.checked;
      chrome.storage.local.set({extensionEnabled});
      updateToggleSwitch(extensionEnabled);
      chrome.runtime.sendMessage({action: 'updateExtensionState', enabled: extensionEnabled});
  });

  function updateToggleSwitch(enabled) {
      toggleSwitch.checked = enabled;
      toggleLabel.textContent = enabled ? 'расширение активно' : 'расширение остановлено';
      toggleLabel.style.color = enabled ? 'var(--accent-green)' : 'var(--text-secondary)';
  }

  // ============================================
  // 6. ЗАГРУЗКА ФАЙЛОВ
  // ============================================

  uploadButton.addEventListener('click', () => scriptFile.click());
  multiUploadButton.addEventListener('click', () => multiScriptFile.click());
  if (refreshSiteVoicesButton) refreshSiteVoicesButton.addEventListener('click', fetchSiteVoices);
  if (parallelModeToggle) {
      parallelModeToggle.addEventListener('change', async () => {
          parallelModeEnabled = parallelModeToggle.checked;
          await chrome.storage.local.set({ parallelModeEnabled });
          if (parallelModeStatus) {
              parallelModeStatus.textContent = parallelModeEnabled
                  ? 'При запуске откроется вторая вкладка MiniMax.'
                  : '';
          }
      });
  }

  scriptFile.addEventListener('change', (e) => { handleMultipleFiles(e.target.files, 'single'); e.target.value = ''; });
  multiScriptFile.addEventListener('change', (e) => { handleMultipleFiles(e.target.files, 'multi'); e.target.value = ''; });

  addFileButton_Multi.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.txt,.md'; input.multiple = true;
      input.onchange = async (e) => {
          for (const file of Array.from(e.target.files)) await handleFileLoad(file, 'multi', true);
          e.target.value = ''; // Сброс для возможности повторного выбора того же файла
      };
      input.click();
  });

  async function handleMultipleFiles(files, mode) {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    
    if (mode === 'single') {
      batchFiles_Single = [];
      parsedEntries = [];
      for (let i = 0; i < fileArray.length; i++) {
        const text = await fileArray[i].text();
        const entries = parseMarkdownText(text);
        const metadata = extractScriptMetadata(text, fileArray[i].name);
        const displayName = buildDisplayFileName(fileArray[i].name, metadata.scriptName);
        if (entries.length) {
          batchFiles_Single.push({
            name: displayName,
            scriptName: metadata.scriptName,
            entries: entries,
            selectedSpeaker: null,
            excludedIds: new Set(),
            languageCode: metadata.languageCode || '',
            minimaxLanguage: metadata.minimaxLanguage || ''
          });
        }
      }
      if (batchFiles_Single.length === 0) return showStatus('Реплики не найдены', 'error');
      
      const allSpeakers = new Set();
      batchFiles_Single.forEach(file => file.entries.forEach(entry => allSpeakers.add(entry.speaker)));
      
      renderSpeakerSelectorForMultipleFiles([...allSpeakers]);
      if (batchFilesCounter_Single) {
        batchFilesCounter_Single.style.display = batchFiles_Single.length > 1 ? 'block' : 'none';
      }
      if (batchFilesCountValue) batchFilesCountValue.textContent = batchFiles_Single.length;

      parsedEntries = batchFiles_Single.length === 1 ? batchFiles_Single[0].entries : parsedEntries;
      previewContainer.style.display = 'none';
      if (batchFiles_Single.length > 1) {
        renderBatchFilesList('single');
        batchFilesContainer_Single.style.display = 'block';
      } else {
        batchFilesContainer_Single.style.display = 'none';
      }
      speakerSelector.style.display = 'block';
      if (automationStatus) automationStatus.style.display = 'none';
      
      fileName.textContent = batchFiles_Single.length === 1 ? batchFiles_Single[0].name : `${batchFiles_Single.length} файлов`;
      applyDetectedSingleLanguage(batchFiles_Single.length === 1
          ? batchFiles_Single[0].minimaxLanguage || 'Auto'
          : 'Auto');
      syncSingleBatchUi();
      await saveBatchFiles();
      showStatus(`${batchFiles_Single.length} файл(ов) загружено`, 'success');
      
    } else {
      // Новая загрузка в Multi = новая сессия (очищаем предыдущие файлы и маппинги)
      batchFiles_Multi = [];
      parsedEntries = [];
      voiceMappings = {};
      multiExcludedIds.clear();
      if (voiceMappingList) voiceMappingList.innerHTML = '';
      if (batchFilesList_Multi) batchFilesList_Multi.innerHTML = '';
      if (multiSkippedReportArea) multiSkippedReportArea.innerHTML = '';
      if (multiConfigContainer) multiConfigContainer.style.display = 'none';
      if (multiFileName) multiFileName.textContent = '';
      updateTotalFilesCount();
      await chrome.storage.local.set({ voiceMappings: {} });
      await chrome.runtime.sendMessage({ action: 'saveSkippedEntries', entries: [], mode: 'multi' }).catch(() => {});
      await saveBatchFiles();

      for (const file of fileArray) await handleFileLoad(file, 'multi');
    }
  }

  function renderSpeakerSelectorForMultipleFiles(speakers) {
    const container = speakerSelector.querySelector('div');
    container.innerHTML = '';
    speakers.forEach(speakerName => {
      const totalCount = batchFiles_Single.reduce((sum, file) => sum + file.entries.filter(e => e.speaker === speakerName).length, 0);
      const label = document.createElement('label');
      label.style.cssText = 'display: flex; align-items: center; padding: 12px; background-color: rgba(17, 21, 26, 0.8); border: 1px solid var(--md-sys-color-outline); border-radius: 10px; cursor: pointer; margin-bottom: 8px;';
      
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'speaker'; input.value = speakerName;
      input.className = 'md-radio';
      if (speakerName === selectedSpeaker) input.checked = true;
      
      const textSpan = document.createElement('span');
      textSpan.textContent = `${speakerName} (${totalCount})`;
      
      label.append(input, textSpan);
      container.appendChild(label);

      input.addEventListener('change', () => {
        selectedSpeaker = input.value;
        batchFiles_Single.forEach(file => file.selectedSpeaker = selectedSpeaker);
        if (batchFiles_Single.length === 1) {
          excludedIds.clear();
          renderPreview();
        }
        if (batchFiles_Single.length > 1) {
          renderBatchFilesList('single');
        }
        syncSingleBatchUi();
        saveState();
        saveBatchFiles();
      });
    });
    speakerSelector.style.display = 'block';
  }

  function togglePasteMode(mode, showPaste) {
      const uploadEl = mode === 'single' ? uploadModeSingle : uploadModeMulti;
      const pasteEl = mode === 'single' ? pasteModeSingle : pasteModeMulti;
      const textarea = mode === 'single' ? pasteTextareaSingle : pasteTextareaMulti;
      if (showPaste) {
          uploadEl.style.display = 'none'; pasteEl.style.display = 'block'; textarea.focus();
      } else {
          uploadEl.style.display = 'block'; pasteEl.style.display = 'none'; textarea.value = '';
      }
      scheduleSaveUiState();
  }

  switchToPasteSingle.onclick = () => togglePasteMode('single', true);
  cancelPasteBtnSingle.onclick = () => togglePasteMode('single', false);
  processPasteBtnSingle.onclick = () => {
      const text = pasteTextareaSingle.value;
      if (!text.trim()) return showStatus('Пустой текст', 'error');
      handleMultipleFiles([new File([text], 'Manual Paste.md', { type: 'text/plain' })], 'single');
      togglePasteMode('single', false);
  };

  switchToPasteMulti.onclick = () => togglePasteMode('multi', true);
  cancelPasteBtnMulti.onclick = () => togglePasteMode('multi', false);
  processPasteBtnMulti.onclick = async () => {
      const text = pasteTextareaMulti.value;
      if (!text.trim()) return showStatus('Пустой текст', 'error');
      batchFiles_Multi = [];
      parsedEntries = [];
      voiceMappings = {};
      multiExcludedIds.clear();
      if (voiceMappingList) voiceMappingList.innerHTML = '';
      if (batchFilesList_Multi) batchFilesList_Multi.innerHTML = '';
      if (multiSkippedReportArea) multiSkippedReportArea.innerHTML = '';
      if (multiConfigContainer) multiConfigContainer.style.display = 'none';
      if (multiFileName) multiFileName.textContent = '';
      updateTotalFilesCount();
      await chrome.storage.local.set({ voiceMappings: {} }).catch(() => {});
      await chrome.runtime.sendMessage({ action: 'saveSkippedEntries', entries: [], mode: 'multi' }).catch(() => {});
      await saveBatchFiles();
      processScriptContent(text, 'Manual Paste.md', 'multi');
      togglePasteMode('multi', false);
  };

  async function handleFileLoad(file, mode, isBatchAdd = false) {
    if (!file) return;
    try {
      const text = await file.text();
      const metadata = extractScriptMetadata(text, file.name);
      const displayName = buildDisplayFileName(file.name, metadata.scriptName);
      if (mode === 'single' && metadata.minimaxLanguage) {
        applyDetectedSingleLanguage(metadata.minimaxLanguage);
      }
      if (isBatchAdd) await addBatchFile(displayName, text, mode, metadata);
      else processScriptContent(text, displayName, mode, metadata);
    } catch (e) { console.error(e); showStatus('Ошибка чтения', 'error'); }
  }

  async function addBatchFile(filename, text, mode, metadata = null) {
    const entries = parseMarkdownText(text);
    if (!entries.length) return showStatus('Реплики не найдены', 'error');

    // Проверка на дубликат файла
    const isDuplicate = mode === 'single' 
      ? batchFiles_Single.some(f => f.name === filename)
      : batchFiles_Multi.some(f => f.name === filename);
    
    if (isDuplicate) {
      showStatus(`Файл "${filename}" уже добавлен`, 'error');
      return;
    }

    const batchData = {
      name: filename,
      scriptName: metadata?.scriptName || getScriptNameForNaming(filename),
      entries: entries,
      excludedIds: new Set(),
      expanded: false,
      language: mode === 'multi' ? (metadata?.minimaxLanguage || getDefaultMultiLanguage()) : undefined,
      languageCode: metadata?.languageCode || ''
    };
    if (mode === 'single') {
        if (metadata?.minimaxLanguage) applyDetectedSingleLanguage(metadata.minimaxLanguage);
        // Logic kept simple for brevity
        batchData.selectedSpeaker = selectedSpeaker || Object.keys(getStatistics(entries))[0];
        batchFiles_Single.push(batchData);
        renderBatchFilesList('single');
        batchFilesContainer_Single.style.display = 'block';
        await saveBatchFiles();
    } else {
        // Each file has its own exclusion set
        batchFiles_Multi.push(batchData);
        renderBatchFilesList('multi');
        updateTotalFilesCount();
        await saveBatchFiles();
        // Update global parsedEntries and voice UI for all speakers
        parsedEntries = [...parsedEntries, ...entries];
        renderMultiVoiceUI();
    }
    showStatus(`Файл добавлен`, 'success');
  }

  function renderBatchFilesList(mode) {
    const isSingle = mode === 'single';
    const listEl = isSingle ? batchFilesContainer_Single : batchFilesList_Multi;
    const files = isSingle ? batchFiles_Single : batchFiles_Multi;
    if (!listEl) return;
    const listScrollTop = listEl.scrollTop;
    listEl.innerHTML = '';
    if (!files.length) {
        if (isSingle) batchFilesContainer_Single.style.display = 'none';
        return;
    }

    const chevronRight = `<svg class="md-chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`;
    const chevronDown = `<svg class="md-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`;

    files.forEach((file, index) => {
      const stats = getStatistics(file.entries);
      const totalEntriesAll = Object.values(stats).reduce((a, b) => a + b, 0);

      let activeSpeaker = file.selectedSpeaker;
      if (isSingle && !activeSpeaker) {
        activeSpeaker = Object.keys(stats)[0];
        file.selectedSpeaker = activeSpeaker;
      }

      const entriesForPreview = isSingle && selectedSpeaker
        ? file.entries.filter(e => e.speaker === activeSpeaker)
        : (isSingle ? [] : file.entries);

      const totalEntries = isSingle ? entriesForPreview.length : totalEntriesAll;
      const selectedCount = entriesForPreview.filter(e => !file.excludedIds.has(e.id)).length;
      
      const fileContainer = document.createElement('div');
      fileContainer.className = 'batch-file-item';
      fileContainer.style.flexDirection = 'column';
      fileContainer.style.background = 'rgba(20, 24, 29, 0.9)';
      fileContainer.style.border = '1px solid rgba(255, 255, 255, 0.06)';
      fileContainer.style.borderRadius = '12px';
      fileContainer.style.padding = '10px';
      fileContainer.style.marginBottom = '8px';
      
      const headerDiv = document.createElement('div');
      headerDiv.style.cssText = 'display:flex; justify-content:space-between; align-items:center; cursor:pointer; width:100%';
      const expandIcon = file.expanded ? chevronDown : chevronRight;
      const hasSelectedSpeakerInFile = isSingle && activeSpeaker
        ? file.entries.some(e => e.speaker === activeSpeaker)
        : true;
      const subline = isSingle && activeSpeaker
        ? `<div style="font-size:11px; color:${hasSelectedSpeakerInFile ? 'var(--md-sys-color-on-surface-variant)' : 'var(--md-sys-color-error)'};">${activeSpeaker}${hasSelectedSpeakerInFile ? '' : ' — нет в этом файле'}</div>`
        : '';
      const titleWrap = document.createElement('div');
      titleWrap.style.cssText = 'display:flex; align-items:center; gap:6px;';
      titleWrap.innerHTML = `
        ${expandIcon}
        <div>
          <div style="font-weight:600; font-size:13px;">${file.name}</div>
          ${subline}
        </div>
      `;
      const rightWrap = document.createElement('div');
      rightWrap.style.cssText = 'display:flex; align-items:center; gap:8px;';

      const countWrap = document.createElement('div');
      countWrap.style.cssText = 'font-size:11px; color:var(--md-sys-color-on-surface-variant);';
      countWrap.textContent = `${selectedCount}/${totalEntries}`;

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'background:none; border:none; color:var(--accent-red); font-size:18px; cursor:pointer; margin-left:10px; padding:0 4px;';
      removeBtn.onclick = (e) => { e.stopPropagation(); removeBatchFile(index, mode); };
      rightWrap.append(countWrap, removeBtn);
      headerDiv.append(titleWrap, rightWrap);

      const expandDiv = document.createElement('div');
      expandDiv.style.display = file.expanded ? 'block' : 'none';
      expandDiv.style.marginTop = '10px';

      if (!isSingle) {
        const fileLanguageSummary = getFileLanguageSummary(file);
        const languageRow = document.createElement('div');
        languageRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';

        const languageLabel = document.createElement('div');
        languageLabel.style.cssText = 'font-size:11px; color:var(--md-sys-color-on-surface-variant); white-space:nowrap;';
        languageLabel.textContent = fileLanguageSummary.isMixed ? 'Языки реплик:' : 'Язык файла:';

        if (fileLanguageSummary.isMixed) {
          const mixedLabel = document.createElement('div');
          mixedLabel.style.cssText = 'font-size:11px; color:var(--md-sys-color-on-surface-variant);';
          mixedLabel.textContent = fileLanguageSummary.minimaxLanguages.join(', ') || 'Mixed';
          languageRow.append(languageLabel, mixedLabel);
        } else {
          const languageSelect = createLanguageSelectElement(file.language || fileLanguageSummary.minimaxLanguages[0] || getDefaultMultiLanguage(), (e) => {
            file.language = e.target.value;
            saveBatchFiles();
            saveState();
          });
          languageSelect.style.maxWidth = '180px';
          languageRow.append(languageLabel, languageSelect);
        }
        expandDiv.appendChild(languageRow);

        const voiceSummary = document.createElement('div');
        voiceSummary.style.cssText = 'font-size:11px; color:var(--md-sys-color-on-surface-variant); margin-bottom:8px; padding:6px; background:rgba(0,0,0,0.2); border-radius:8px;';
        const assignedVoices = [];
        const seenVoiceKeys = new Set();
        file.entries.forEach(entry => {
          const entryLanguageCode = getEntryLanguageCode(entry, file);
          const summaryKey = `${entryLanguageCode}::${entry.speaker}`;
          if (seenVoiceKeys.has(summaryKey)) return;
          seenVoiceKeys.add(summaryKey);
           const mapping = getVoiceMappingValue(entry.speaker, entryLanguageCode);
           const voiceName = getMappingVoiceName(mapping);
           if (voiceName) {
             const label = entryLanguageCode ? `[${entryLanguageCode}] ${entry.speaker}` : entry.speaker;
             assignedVoices.push(`${label}: ${voiceName}`);
          }
        });
        voiceSummary.textContent = assignedVoices.length > 0 
          ? 'Назначены: ' + assignedVoices.join(', ')
          : 'Голоса не назначены';
        expandDiv.appendChild(voiceSummary);
      }

      if (!isSingle || selectedSpeaker) {
        const previewLabel = document.createElement('div');
        previewLabel.style.cssText = 'font-size:11px; color:var(--md-sys-color-on-surface-variant); margin-bottom:6px; font-weight:600;';
        previewLabel.textContent = 'Выбор реплик:';
        expandDiv.appendChild(previewLabel);
      }

      let missingSpeakers = new Set();
      let missingSpeakerKeys = new Set();
      let selectableEntries = entriesForPreview;
      if (!isSingle) {
        file.entries.forEach(entry => {
            const entryLanguageCode = getEntryLanguageCode(entry, file);
            const mappingKey = getVoiceMappingKey(entry.speaker, entryLanguageCode);
             if (!getMappingVoiceName(getVoiceMappingValue(entry.speaker, entryLanguageCode))) {
                missingSpeakers.add(entry.speaker);
                missingSpeakerKeys.add(mappingKey);
            }
        });
        selectableEntries = file.entries.filter(e => !missingSpeakerKeys.has(getVoiceMappingKey(e.speaker, getEntryLanguageCode(e, file))));
      }

      const allSelectableSelected = selectableEntries.length > 0 && selectableEntries.every(e => !file.excludedIds.has(e.id));

      if (!isSingle || selectedSpeaker) {
        const toggleBtn = document.createElement('button');
        toggleBtn.style.cssText = 'background:none; border:none; color:var(--accent-blue); font-size:11px; cursor:pointer; margin-bottom:8px; padding:0;';
        toggleBtn.textContent = allSelectableSelected ? 'снять выделение' : 'выделить все';
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            if (allSelectableSelected) {
                selectableEntries.forEach(e => file.excludedIds.add(e.id));
            } else {
                selectableEntries.forEach(e => file.excludedIds.delete(e.id));
            }
            renderBatchFilesList(isSingle ? 'single' : 'multi');
            saveBatchFiles();
        };
        if (!isSingle || hasSelectedSpeakerInFile) {
          expandDiv.appendChild(toggleBtn);
        }
      }
      
      if (!isSingle || selectedSpeaker) {
        const previewDiv = document.createElement('div');
        previewDiv.style.cssText = 'max-height:200px; overflow-y:auto; background:rgba(0,0,0,0.2); border:1px solid var(--md-sys-color-outline); border-radius:10px; padding:6px;';
        previewDiv.className = 'file-preview-list';
        previewDiv.dataset.fileIndex = String(index);
        if (!isSingle && typeof file.scrollTop === 'number') {
          previewDiv.scrollTop = file.scrollTop;
        }
        previewDiv.addEventListener('scroll', () => {
          if (!isSingle) file.scrollTop = previewDiv.scrollTop;
        });
        
        const speakerCounters = {};
        entriesForPreview.forEach(entry => {
            if (!speakerCounters[entry.speaker]) speakerCounters[entry.speaker] = 0;
            speakerCounters[entry.speaker]++;
            const card = createCard(entry, speakerCounters[entry.speaker], file.excludedIds, !isSingle, voiceMappings, {
                missingVoice: !isSingle && missingSpeakerKeys.has(getVoiceMappingKey(entry.speaker, getEntryLanguageCode(entry, file)))
            });
            previewDiv.appendChild(card);
        });
        if (isSingle && selectedSpeaker && !hasSelectedSpeakerInFile) {
          const empty = document.createElement('div');
          empty.style.cssText = 'font-size:11px; color:var(--md-sys-color-on-surface-variant); padding:8px; text-align:center;';
          empty.textContent = 'В этом файле нет выбранного персонажа';
          previewDiv.appendChild(empty);
        }
        expandDiv.appendChild(previewDiv);
      }

      headerDiv.onclick = () => {
          file.expanded = !file.expanded;
          expandDiv.style.display = file.expanded ? 'block' : 'none';
          titleWrap.innerHTML = `
            ${file.expanded ? chevronDown : chevronRight}
            <div>
              <div style="font-weight:600; font-size:13px;">${file.name}</div>
              ${subline}
            </div>
          `;
          saveBatchFiles();
      };

      fileContainer.appendChild(headerDiv);
      fileContainer.appendChild(expandDiv);
      listEl.appendChild(fileContainer);
    });

    if (isSingle) batchFilesContainer_Single.style.display = 'block';
    if (!isSingle) {
      requestAnimationFrame(() => {
        listEl.scrollTop = listScrollTop;
        document.querySelectorAll('.file-preview-list').forEach(el => {
          const idx = Number(el.dataset.fileIndex);
          if (!Number.isNaN(idx) && files[idx] && typeof files[idx].scrollTop === 'number') {
            el.scrollTop = files[idx].scrollTop;
          }
        });
      });
    }
  }

  async function removeBatchFile(index, mode) {
    if (mode === 'single') {
      batchFiles_Single.splice(index, 1);
      renderBatchFilesList('single');
      if (batchFiles_Single.length === 0) {
        parsedEntries = [];
        selectedSpeaker = null;
        excludedIds.clear();
        if (speakerSelector) speakerSelector.style.display = 'none';
        if (previewList) previewList.innerHTML = '';
        if (batchFilesCounter_Single) batchFilesCounter_Single.style.display = 'none';
        if (batchFilesCountValue) batchFilesCountValue.textContent = '0';
        if (fileName) fileName.textContent = '';
        if (startAutomationButton) startAutomationButton.style.display = 'none';
        if (automationStatus) {
          automationStatus.textContent = '';
          automationStatus.className = '';
          automationStatus.style.display = 'none';
          automationStatus.style.opacity = '0';
        }
        syncSingleBatchUi();
        await saveState();
      } else {
        if (batchFilesCounter_Single) batchFilesCounter_Single.style.display = 'block';
        if (batchFilesCountValue) batchFilesCountValue.textContent = batchFiles_Single.length;
        if (fileName) {
          fileName.textContent = batchFiles_Single.length === 1
            ? batchFiles_Single[0].name
            : `${batchFiles_Single.length} файлов`;
        }
        syncSingleBatchUi();
      }
    } else { 
      batchFiles_Multi.splice(index, 1); 
      renderBatchFilesList('multi'); 
      updateTotalFilesCount();
      // Перерисовываем голоса если удалили файл
      renderMultiVoiceUI();
    }
    await saveBatchFiles();
  }

  async function saveBatchFiles() {
    // Serialization
    const s = batchFiles_Single.map(f => ({...f, excludedIds: Array.from(f.excludedIds)}));
    const m = batchFiles_Multi.map(f => ({...f, excludedIds: Array.from(f.excludedIds)}));
    await chrome.storage.local.set({ batchFiles_Single: s, batchFiles_Multi: m });
    scheduleSaveUiState();
  }

  async function loadBatchFiles() {
    const d = await chrome.storage.local.get(['batchFiles_Single', 'batchFiles_Multi']);
    if(d.batchFiles_Single) batchFiles_Single = d.batchFiles_Single.map(f => ({...f, excludedIds: new Set(f.excludedIds||[])}));
    if(d.batchFiles_Multi) {
        batchFiles_Multi = d.batchFiles_Multi.map(f => ({
          ...f, 
          language: f.language || getDefaultMultiLanguage(),
          excludedIds: new Set(f.excludedIds||[])
        }));
        renderBatchFilesList('multi');
        updateTotalFilesCount();
    }
    if (batchFiles_Single.length > 0) {
        renderBatchFilesList('single');
        batchFilesContainer_Single.style.display = 'block';
    }
  }

  function syncSingleBatchUi() {
      if (batchFiles_Single.length === 0) {
          if (batchFilesCounter_Single) batchFilesCounter_Single.style.display = 'none';
          if (batchFilesCountValue) batchFilesCountValue.textContent = '0';
          if (fileName) fileName.textContent = '';
          if (previewContainer) previewContainer.style.display = 'none';
          if (startAutomationButton) startAutomationButton.style.display = 'none';
          if (automationControlsCard) automationControlsCard.style.display = 'none';
          if (languageSelectorEl) languageSelectorEl.style.display = 'none';
      } else {
          if (batchFilesCounter_Single) batchFilesCounter_Single.style.display = batchFiles_Single.length > 1 ? 'block' : 'none';
          if (batchFilesCountValue) batchFilesCountValue.textContent = batchFiles_Single.length;
          if (fileName) {
              fileName.textContent = batchFiles_Single.length === 1
                  ? batchFiles_Single[0].name
                  : `${batchFiles_Single.length} файлов`;
          }
          const canStartSingle = !!selectedSpeaker;
          if (startAutomationButton) startAutomationButton.style.display = canStartSingle ? 'flex' : 'none';
          if (automationControlsCard) automationControlsCard.style.display = canStartSingle ? 'block' : 'none';
          if (languageSelectorEl) languageSelectorEl.style.display = 'block';
          if (batchFilesContainer_Single) {
            batchFilesContainer_Single.style.display = batchFiles_Single.length > 1 ? 'block' : 'none';
          }
      }
  }

  function ensureSingleEmptyUi() {
      if (batchFiles_Single.length > 0) return;
      if (speakerSelector) speakerSelector.style.display = 'none';
      if (previewContainer) previewContainer.style.display = 'none';
      if (automationStatus) {
          automationStatus.style.display = 'none';
          automationStatus.style.opacity = '0';
      }
      if (automationControlsCard) automationControlsCard.style.display = 'none';
  }

  function processScriptContent(text, filenameStr, mode, metadata = null) {
    const nameDisplay = mode === 'single' ? fileName : multiFileName;
    nameDisplay.textContent = filenameStr;
    const entries = parseMarkdownText(text);
    if (!entries.length) return showStatus('Реплики не найдены', 'error');
    const resolvedMetadata = metadata || extractScriptMetadata(text, filenameStr);
    const resolvedScriptName = resolvedMetadata.scriptName;

    if (mode === 'single') {
        if (resolvedMetadata.minimaxLanguage) applyDetectedSingleLanguage(resolvedMetadata.minimaxLanguage);
        parsedEntries = entries;
        batchFiles_Single = [{
            name: filenameStr,
            scriptName: resolvedScriptName,
            entries: entries,
            selectedSpeaker: null,
            excludedIds: new Set(),
            languageCode: resolvedMetadata.languageCode || ''
        }];
        addFileButton_Single.style.display = 'flex';
        batchFilesContainer_Single.style.display = 'block';
        selectedSpeaker = null;
        excludedIds.clear();
        renderSpeakerSelector();
        previewContainer.style.display = 'none';
        speakerSelector.style.display = 'block';
        if (automationStatus) automationStatus.style.display = 'none';
    } else {
        // Для мульти-режима - добавляем файл в очередь без перезаписи parsedEntries
        const newFile = {
            name: filenameStr,
            scriptName: resolvedScriptName,
            entries: entries,
            excludedIds: new Set(),  // Каждый файл имеет свой набор исключений
            expanded: false,
            language: resolvedMetadata.minimaxLanguage || getDefaultMultiLanguage(),
            languageCode: resolvedMetadata.languageCode || ''
        };
        batchFiles_Multi.push(newFile);
        
        // Обновляем UI
        renderMultiVoiceUI();
        addFileButton_Multi.style.display = 'block';
        batchFilesContainer_Multi.style.display = 'block';
        renderBatchFilesList('multi');
        updateTotalFilesCount();
        saveBatchFiles();
    }
    saveState();
    showStatus('Скрипт обработан', 'success');
  }
  
  function updateTotalFilesCount() {
    const countEl = document.getElementById('totalFilesCount');
    if (countEl) {
      countEl.textContent = `${batchFiles_Multi.length} файл(ов)`;
    }
  }

  // Single UI
  function renderSpeakerSelector() {
    const stats = getStatistics(parsedEntries);
    const container = speakerSelector.querySelector('div');
    container.innerHTML = '';
    Object.keys(stats).forEach(speakerName => {
      const label = document.createElement('label');
      label.style.cssText = 'display: flex; align-items: center; padding: 12px; background-color: rgba(17, 21, 26, 0.8); border: 1px solid var(--md-sys-color-outline); border-radius: 10px; cursor: pointer; margin-bottom: 8px;';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'speaker'; input.value = speakerName; input.className = 'md-radio';
      if (speakerName === selectedSpeaker) input.checked = true;
      const textSpan = document.createElement('span');
      textSpan.textContent = `${speakerName} (${stats[speakerName]})`;
      label.append(input, textSpan);
      container.appendChild(label);

      input.addEventListener('change', () => {
        selectedSpeaker = input.value;
        if (batchFiles_Single.length === 1) {
          batchFiles_Single[0].excludedIds.clear();
        } else {
          excludedIds.clear();
        }
        renderPreview();
        syncSingleBatchUi();
        saveState();
        saveBatchFiles();
      });
    });
    speakerSelector.style.display = 'block';
  }

  function renderPreview() {
    if (!selectedSpeaker) return;
    const entries = parsedEntries.filter(e => e.speaker === selectedSpeaker);
    previewList.innerHTML = '';
    if (entries.length === 0) return;
    previewContainer.style.display = 'block';
    startAutomationButton.style.display = 'block';
    const exclusionSet = batchFiles_Single.length === 1 ? batchFiles_Single[0].excludedIds : excludedIds;
    updateSelectionButton(toggleSelectionBtn, exclusionSet.size === 0);
    selectionCount.textContent = `${entries.length - exclusionSet.size} выбрано`;
    entries.forEach((entry, index) => {
      const card = createCard(entry, index + 1, exclusionSet, false);
      previewList.appendChild(card);
    });
  }

  // Multi UI - Глобальный модуль голосов для всех файлов
  function renderMultiVoiceUI() {
    ensureAutoVoiceMappings();

    // Собираем уникальные пары язык + спикер из всех файлов
    const mappingItems = new Map();
    batchFiles_Multi.forEach(file => {
      file.entries.forEach(entry => {
        const languageCode = getEntryLanguageCode(entry, file);
        const minimaxLanguage = getEntryMinimaxLanguage(entry, file);
        const mappingKey = getVoiceMappingKey(entry.speaker, languageCode);
        if (!mappingItems.has(mappingKey)) {
          mappingItems.set(mappingKey, {
            mappingKey,
            speaker: entry.speaker,
            languageCode,
            minimaxLanguage,
            count: 0
          });
        }
        mappingItems.get(mappingKey).count += 1;
      });
    });
    
    if (mappingItems.size === 0) return;
    
    voiceMappingList.innerHTML = '';

    [...mappingItems.values()]
      .sort((a, b) => {
        const left = `${a.languageCode} ${a.speaker}`.trim().toLowerCase();
        const right = `${b.languageCode} ${b.speaker}`.trim().toLowerCase();
        return left.localeCompare(right, 'ru');
      })
      .forEach(item => {
      const speakerKey = `${item.languageCode}-${item.speaker}`
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'speaker';
      const datalistId = `siteVoiceOptions-${speakerKey}`;
      const currentValue = getVoiceMappingValue(item.speaker, item.languageCode);
      const div = document.createElement('div');
      div.className = 'voice-mapping-item';
      const autoMatchedVoice = currentValue || findBestCachedVoiceMatch(item.speaker, item.languageCode);
      const languageBadge = item.languageCode
        ? ` <span class="voice-mapping-count">[${item.languageCode}${item.minimaxLanguage ? ` / ${item.minimaxLanguage}` : ''}]</span>`
        : '';
      
      div.innerHTML = `
        <div class="voice-mapping-info">
            <span class="voice-mapping-label">${item.speaker}</span>${languageBadge}
            <span class="voice-mapping-count">${item.count || 0} реплик</span>
        </div>
      `;
      
      const input = document.createElement('input');
      input.className = 'voice-mapping-input';
      input.placeholder = cachedSiteVoices.length ? 'Выберите голос из My Voices...' : 'Сначала нажмите «Обновить»';
      input.value = getMappingVoiceName(currentValue);
      input.setAttribute('list', datalistId);
      if (autoMatchedVoice && !currentValue) {
          input.placeholder = `Автоподбор: ${getMappingVoiceName(autoMatchedVoice)}`;
      }

      const controls = document.createElement('div');
      controls.className = 'voice-mapping-controls';

      const dataList = document.createElement('datalist');
      dataList.id = datalistId;
      cachedSiteVoices.forEach((voice) => {
          const option = document.createElement('option');
          option.value = voice.voiceName;
          dataList.appendChild(option);
      });

      input.addEventListener('change', (e) => {
          applyVoiceMappingValue(item.speaker, e.target.value, item.languageCode);
      });
      input.addEventListener('blur', (e) => {
          applyVoiceMappingValue(item.speaker, e.target.value, item.languageCode);
      });

      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'btn btn-outline voice-mapping-clear';
      clearButton.textContent = 'Очистить';
      clearButton.addEventListener('click', () => {
          input.value = '';
          applyVoiceMappingValue(item.speaker, '', item.languageCode);
      });

      controls.appendChild(input);
      controls.appendChild(clearButton);
      div.appendChild(controls);
      div.appendChild(dataList);
      voiceMappingList.appendChild(div);
    });
    multiConfigContainer.style.display = 'block';
  }

  // Removed: function renderMultiPreview() - now handled per-file in renderBatchFilesList

  // Create Card - с поддержкой отображения Voice ID
  function createCard(entry, indexLabel, exclusionSet, showSpeaker, voiceMap = null, options = {}) {
      const missingVoice = options.missingVoice === true;
      const isExcluded = exclusionSet.has(entry.id);
      const card = document.createElement('div');
      card.className = `preview-card ${isExcluded ? 'disabled' : ''} ${missingVoice ? 'missing-voice' : ''}`;
      card.dataset.id = entry.id;

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'preview-checkbox md-checkbox';
      check.checked = !isExcluded && !missingVoice;
      check.disabled = missingVoice;
      
      const toggle = (e) => {
          e.stopPropagation();
          const val = e.target ? e.target.checked : !check.checked;
          if (e.target) check.checked = val;
          if (val) exclusionSet.delete(entry.id); else exclusionSet.add(entry.id);
          if (activeMode === 'single') {
            if (batchFiles_Single.length > 1) renderBatchFilesList('single'); else renderPreview();
          } else {
            const previewEl = card.closest('.file-preview-list');
            if (previewEl && previewEl.dataset.fileIndex) {
              const idx = Number(previewEl.dataset.fileIndex);
              if (!Number.isNaN(idx) && batchFiles_Multi[idx]) {
                batchFiles_Multi[idx].scrollTop = previewEl.scrollTop;
              }
            }
            renderBatchFilesList('multi');
          }
          saveState();
          saveBatchFiles();
      };

      check.addEventListener('change', toggle);
      card.addEventListener('click', (e) => { 
          if(e.target !== check && !missingVoice) toggle({stopPropagation:()=>{}, target:null}); 
      });

      const content = document.createElement('div');
      content.className = 'preview-content';
      
      // Формируем заголовок с Voice ID если доступен
      let headerHTML;
      if (showSpeaker) {
        const mapping = voiceMap && voiceMap[entry.speaker] ? voiceMap[entry.speaker] : '';
        const voiceName = getMappingVoiceName(mapping);
        const voiceDisplay = voiceName ? `<span style="color:var(--accent-green); font-size:10px;">(${voiceName})</span>` : '';
        headerHTML = `<span style="color:var(--accent-blue)">${entry.speaker}</span> ${voiceDisplay} <span style="opacity:0.7">#${indexLabel}</span>`;
      } else {
        headerHTML = `<span>#${indexLabel}</span>`;
      }
      const missingBadge = missingVoice ? `<span class="missing-badge">нет voice_id</span>` : '';

      // SVG with classes (hidden by default via CSS)
      content.innerHTML = `
        <div class="preview-header">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
             ${headerHTML}
             ${missingBadge}
             <svg class="status-icon status-icon-loading solar-icon" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-8-8"></path><path d="M12 4v2"></path></svg>
             <svg class="status-icon status-icon-check solar-icon" viewBox="0 0 24 24"><path d="M6 12l4 4 8-8"></path></svg>
             <svg class="status-icon status-icon-warning solar-icon" viewBox="0 0 24 24"><path d="M12 4l8 14H4l8-14z"></path><path d="M12 9v4"></path><path d="M12 16h.01"></path></svg>
          </div>
          <span style="font-family: monospace;">${entry.text.length} ch</span>
        </div>
        <div class="preview-text">${entry.preview}</div>
      `;
      card.append(check, content);
      return card;
  }

  function handleToggleAll(exclusionSet, items, renderFn) {
      if (exclusionSet.size === 0) items.forEach(e => exclusionSet.add(e.id)); else exclusionSet.clear();
      renderFn();
      saveState();
      saveBatchFiles();
  }
  if (toggleSelectionBtn) toggleSelectionBtn.onclick = () => {
    const exclusionSet = batchFiles_Single.length === 1 ? batchFiles_Single[0].excludedIds : excludedIds;
    handleToggleAll(exclusionSet, parsedEntries.filter(e => e.speaker === selectedSpeaker), renderPreview);
  };
  // Removed: multiToggleSelectionBtn handler - now handled per-file
  function updateSelectionButton(btn, isAllSelected) {
      btn.textContent = isAllSelected ? 'снять выделение' : 'выделить все';
      btn.style.color = isAllSelected ? 'var(--accent-red)' : 'var(--accent-blue)';
  }

  // ============================================
  // 7. ЗАПУСК И УПРАВЛЕНИЕ
  // ============================================

  function getScriptNameForNaming(fileNameText) {
      if (!fileNameText) return null;
      return fileNameText.replace(/\.(md|txt)$/i, '');
  }

  function normalizeMinimaxLanguage(value) {
      const normalized = String(value || '').trim();
      if (!normalized) return '';
      const directMatch = AVAILABLE_LANGUAGES.find(lang => lang.toLowerCase() === normalized.toLowerCase());
      return directMatch || '';
  }

  function resolveMinimaxLanguageFromCode(languageCode) {
      const normalizedCode = String(languageCode || '').trim().toUpperCase();
      if (!normalizedCode) return '';
      return normalizeMinimaxLanguage(LANGUAGE_CODE_TO_MINIMAX[normalizedCode] || '');
  }

  function extractScriptMetadata(text, fallbackName = null) {
      const source = String(text || '');
      const scriptNameMatch = source.match(/<!--\s*script_name\s*:\s*(.+?)\s*-->/i);
      const minimaxLanguageMatch = source.match(/<!--\s*minimax_language\s*:\s*(.+?)\s*-->/i);
      const languageCodeMatch = source.match(/<!--\s*(?:language_code|target_language_code)\s*:\s*(.+?)\s*-->/i);

      const scriptName = scriptNameMatch && scriptNameMatch[1]
          ? scriptNameMatch[1].trim()
          : getScriptNameForNaming(fallbackName);
      const languageCode = languageCodeMatch && languageCodeMatch[1]
          ? languageCodeMatch[1].trim().toUpperCase()
          : '';
      const minimaxLanguage =
          normalizeMinimaxLanguage(minimaxLanguageMatch && minimaxLanguageMatch[1] ? minimaxLanguageMatch[1] : '') ||
          resolveMinimaxLanguageFromCode(languageCode);

      return {
          scriptName,
          languageCode,
          minimaxLanguage
      };
  }

  function applyDetectedSingleLanguage(minimaxLanguage) {
      const resolved = normalizeMinimaxLanguage(minimaxLanguage);
      if (!resolved || !languageSelect) return;
      languageSelect.value = resolved;
      chrome.storage.local.set({ selectedLanguage: resolved });
  }

  function buildDisplayFileName(originalFileName, scriptName) {
      const extensionMatch = String(originalFileName || '').match(/(\.[^.]+)$/);
      const extension = extensionMatch ? extensionMatch[1] : '.md';
      if (scriptName) {
          return `${scriptName}${extension}`;
      }
      return originalFileName;
  }

  async function getMinimaxTabId() {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeMinimaxTab = activeTabs.find((tab) => String(tab.url || '').startsWith('https://www.minimax.io/audio/text-to-speech'));
      if (activeMinimaxTab?.id) return activeMinimaxTab.id;

      const tabs = await chrome.tabs.query({ currentWindow: true });
      return tabs.find((tab) => String(tab.url || '').startsWith('https://www.minimax.io/audio/text-to-speech'))?.id || null;
  }

  function renderLongTextStatus(summary) {
      const targets = [longTextStatusArea, multiLongTextStatusArea].filter(Boolean);
      const data = summary || {};
      const hasActiveTasks = data.hasActive === true;
      const hasVisibleStatus = Number(data.queued || 0) > 0
          || Number(data.pending || 0) > 0
          || Number(data.ready || 0) > 0
          || Number(data.completed || 0) > 0
          || Number(data.failed || 0) > 0;

      targets.forEach((target) => {
          if (!hasVisibleStatus) {
              target.style.display = 'none';
              target.textContent = '';
              return;
          }
          const parts = [
              `Long Text: ${Number(data.completed || 0)} готово`,
              `${Number(data.pending || 0)} ожидает`
          ];
          if (Number(data.queued || 0) > 0) parts.push(`${Number(data.queued)} отправляется`);
          if (Number(data.ready || 0) > 0) parts.push(`${Number(data.ready)} скачивается`);
          if (Number(data.failed || 0) > 0) parts.push(`${Number(data.failed)} ошибок`);
          target.textContent = parts.join(' · ');
          target.style.display = 'flex';
      });
      [startAutomationButton, startMultiAutomationButton].filter(Boolean).forEach((button) => {
          button.disabled = hasActiveTasks;
          button.title = hasActiveTasks ? 'Дождитесь завершения Long Text задач' : '';
      });
  }

  function getLongTextCount(jobs) {
      return jobs.reduce((total, job) => {
          return total + job.queue.filter((entry) => {
              const length = String(entry.text || '').length;
              return length > 5000 && length <= 200000;
          }).length;
      }, 0);
  }

  startAutomationButton.onclick = async () => {
      activeMode = 'single';
      if (batchFiles_Single.length === 0) return showStatus('Нет файлов', 'error');
      
      const batchJobs = [];
      for (const batchFile of batchFiles_Single) {
          const fileSpeaker = batchFile.selectedSpeaker || selectedSpeaker;
          if (!fileSpeaker) continue;
          
          const entriesToProcess = batchFile.entries.filter(e => e.speaker.toLowerCase().trim() === fileSpeaker.toLowerCase().trim());
          if (entriesToProcess.length === 0) continue;
          
          const scriptName = batchFile.scriptName || getScriptNameForNaming(batchFile.name);
          const queue = prepareQueue(entriesToProcess, batchFile.excludedIds, {
              useVoiceMap: false,
              scriptName,
              downloadLayout: 'default'
          });
          queue.forEach(q => {
              q.language = languageSelect.value === 'Auto'
                  ? getEntryMinimaxLanguage(q, batchFile)
                  : languageSelect.value;
              q.scriptName = scriptName;
          });
          batchJobs.push({ queue, mode: 'single', scriptName });
      }

      if (batchJobs.length === 0) return showStatus('Очередь пуста', 'error');
      
      const activeTabId = await getMinimaxTabId();
      if (!activeTabId) return showStatus('Откройте MiniMax TTS', 'error');
      try {
          await preflightQueueVoices(batchJobs, activeTabId);
          await preflightGenerationCredit(batchJobs, activeTabId);
      } catch (error) {
          return showStatus(error.message, 'error');
      }
      const longTextCount = getLongTextCount(batchJobs);
      if (longTextCount > 0) showStatus(`Отправляю Long Text: ${longTextCount}...`, 'info');
      const response = await chrome.runtime.sendMessage({
          action: 'startBatchProcessing',
          jobs: batchJobs,
          tabId: activeTabId
      }).catch((error) => ({ success: false, reason: error?.message || 'start_failed' }));
      if (!response?.success) {
          showStatus(`Не удалось запустить: ${response?.reason || 'unknown error'}`, 'error');
          return;
      }

      if (response.regularStarted) setRunningState();
      if (response.regularStarted) {
          if (response.longTextFailed) {
              showStatus(
                  `Regular запущен, Long Text не отправлено: ${response.longTextFailed}`,
                  'error'
              );
          } else {
              showStatus(`Запущен пакет: ${batchJobs.length} файлов`, 'success');
          }
      } else {
          resetUI();
          showStatus(`Long Text отправлен: ${response.longTextSubmitted || 0}`, response.longTextFailed ? 'error' : 'success');
      }
  };

  startMultiAutomationButton.onclick = async () => {
      activeMode = 'multi';
      if (batchFiles_Multi.length === 0) return showStatus('Нет файлов', 'error');
      
      const batchJobs = [];
      for (let i = 0; i < batchFiles_Multi.length; i++) {
          const file = batchFiles_Multi[i];
          const scriptName = file.scriptName || getScriptNameForNaming(file.name);
          const sourceFileBaseName = getScriptNameForNaming(file.name);
          const queue = prepareQueue(file.entries, file.excludedIds, {
              useVoiceMap: true,
              scriptName,
              downloadLayout: 'package',
              groupByVoice: true,
              languageCode: file.languageCode || '',
              defaultLanguage: file.language || getDefaultMultiLanguage(),
              sourceFileName: file.name,
              sourceFileBaseName,
              sourceFileIndex: i + 1
          });
          if (queue.length === 0) continue;
          
          const missingMap = new Map();
          queue.forEach((entry) => {
               if (entry.voiceId || entry.voiceName) return;
              const key = getVoiceMappingKey(entry.speaker, entry.languageCode || '');
              if (!missingMap.has(key)) {
                  const label = entry.languageCode ? `[${entry.languageCode}] ${entry.speaker}` : entry.speaker;
                  missingMap.set(key, label);
              }
          });
          const missing = [...missingMap.values()];
          if (missing.length) {
              return showStatus(`Запуск заблокирован. Нет голоса для: ${missing.join(', ')}`, 'error');
          }

          batchJobs.push({ queue, mode: 'multi', scriptName });
      }

      if (batchJobs.length === 0) return showStatus('Очередь пуста', 'error');
      const activeTabId = await getMinimaxTabId();
      if (!activeTabId) return showStatus('Откройте MiniMax TTS', 'error');
      try {
          const mappingInspection = await inspectVoiceMappingPlan();
          if (!mappingInspection.valid) {
              return showStatus('Запуск заблокирован: исправьте voice mapping', 'error');
          }
          await preflightQueueVoices(batchJobs, activeTabId);
          await preflightGenerationCredit(batchJobs, activeTabId);
      } catch (error) {
          return showStatus(error.message, 'error');
      }

      const action = parallelModeEnabled ? 'startParallelBatchProcessing' : 'startBatchProcessing';
      const longTextCount = getLongTextCount(batchJobs);
      if (longTextCount > 0) showStatus(`Отправляю Long Text: ${longTextCount}...`, 'info');
      else if (parallelModeEnabled) showStatus('Проверяю вторую вкладку...', 'info');
      const response = await chrome.runtime.sendMessage({ action, jobs: batchJobs, tabId: activeTabId }).catch((error) => ({
          success: false,
          reason: error?.message || 'start_failed'
      }));
      if (!response?.success) {
          showStatus(`Не удалось запустить: ${response?.reason || 'unknown error'}`, 'error');
          return;
      }

      if (response.regularStarted) setRunningState();
      if (!response.regularStarted) {
          resetUI();
          showStatus(`Long Text отправлен: ${response.longTextSubmitted || 0}`, response.longTextFailed ? 'error' : 'success');
      } else if (response.longTextFailed) {
          showStatus(
              `Regular запущен, Long Text не отправлено: ${response.longTextFailed}`,
              'error'
          );
      } else if (response.parallel) {
          showStatus('Запущено 2 потока', 'success');
      } else if (response.fallback) {
          showStatus(`Один поток: ${response.reason}`, 'info');
      } else {
          showStatus(`Запущен мульти-пакет: ${batchJobs.length} файлов`, 'success');
      }
  };
  
  // Сброс мульти-войс режима
  resetMultiButton.onclick = async () => {
      if (!confirm('Сбросить все файлы и настройки голосов?')) return;
      
      batchFiles_Multi = [];
      voiceMappings = {};
      parsedEntries = [];
      
      // Сброс UI
      voiceMappingList.innerHTML = '';
      batchFilesList_Multi.innerHTML = '';
      batchFilesContainer_Multi.style.display = 'none';
      multiConfigContainer.style.display = 'none';
      multiFileName.textContent = '';
      updateTotalFilesCount();
      
      await chrome.storage.local.set({ voiceMappings: {} });
      await saveBatchFiles();
      await saveState();
      
      showStatus('Всё сброшено', 'success');
  };

  function prepareQueue(items, exclusionSet, options = {}) {
      const useVoiceMap = !!options.useVoiceMap;
      const scriptName = options.scriptName || null;
      const downloadLayout = options.downloadLayout || 'default';
      const groupByVoice = !!options.groupByVoice;
      const sourceFileName = options.sourceFileName || null;
      const sourceFileBaseName = options.sourceFileBaseName || getScriptNameForNaming(sourceFileName || scriptName || '');
      const sourceFileIndex = options.sourceFileIndex || null;
      const fallbackLanguageCode = String(options.languageCode || '').trim().toUpperCase();
      const defaultLanguage = options.defaultLanguage || getDefaultMultiLanguage();
      const languageContext = {
          languageCode: fallbackLanguageCode,
          language: defaultLanguage
      };
      const originalSpeakerCounters = {};
      let originalGlobalCounter = 0;
      const annotatedEntries = items
          .map(entry => {
              const entryLanguageCode = getEntryLanguageCode(entry, languageContext) || fallbackLanguageCode;
              const entryLanguage = getEntryMinimaxLanguage(entry, languageContext) || defaultLanguage;
              if(!originalSpeakerCounters[entry.speaker]) originalSpeakerCounters[entry.speaker] = 0;
              originalSpeakerCounters[entry.speaker]++;
              originalGlobalCounter++;
              return {
                  ...entry,
                   voiceId: useVoiceMap ? (getMappingVoiceId(getVoiceMappingValue(entry.speaker, entryLanguageCode)) || null) : null,
                   voiceName: useVoiceMap ? (getMappingVoiceName(getVoiceMappingValue(entry.speaker, entryLanguageCode)) || null) : null,
                  scriptName: scriptName,
                  downloadLayout,
                  languageCode: entryLanguageCode,
                  language: entryLanguage,
                  sourceFileName,
                  sourceFileBaseName,
                  sourceFileIndex,
                  originalSpeakerIndex: originalSpeakerCounters[entry.speaker],
                  originalDownloadIndex: entry.downloadIndex || originalGlobalCounter
              };
          });

      const resolvedEntries = annotatedEntries
          .filter(entry => !exclusionSet.has(entry.id));

      const processingEntries = groupByVoice
          ? (() => {
              const groupedEntries = new Map();
              resolvedEntries.forEach((entry) => {
                  const voiceGroupId = entry.voiceId
                      ? `voice:${entry.voiceId}`
                      : `speaker:${String(entry.speaker || '').trim().toLowerCase()}`;
                  const groupKey = [
                      voiceGroupId,
                      String(entry.languageCode || '').trim().toUpperCase(),
                      String(entry.language || '').trim().toLowerCase()
                  ].join('||');
                  if (!groupedEntries.has(groupKey)) {
                      groupedEntries.set(groupKey, []);
                  }
                  groupedEntries.get(groupKey).push(entry);
              });
              return [...groupedEntries.values()].flat();
          })()
          : resolvedEntries;

      const speakerCounters = {};
      let globalCounter = 0;
      return processingEntries.map(entry => {
          if(!speakerCounters[entry.speaker]) speakerCounters[entry.speaker] = 0;
          speakerCounters[entry.speaker]++;
          globalCounter++;
          return {
              ...entry,
              speakerIndex: entry.originalSpeakerIndex || speakerCounters[entry.speaker],
              downloadIndex: downloadLayout === 'package'
                  ? (entry.originalDownloadIndex || globalCounter)
                  : (entry.originalSpeakerIndex || speakerCounters[entry.speaker])
          };
      });
  }

  function setRunningState() {
      if (automationControlsCard) automationControlsCard.style.display = 'block';
      startAutomationButton.style.display = 'none';
      startMultiAutomationButton.style.display = 'none';
      if (activeMode === 'multi') multiConfigContainer.style.display = 'block';
      const container = activeMode === 'multi' ? multiConfigContainer : previewContainer.parentNode;
      const controls = pauseAutomationButton.parentElement;
      if (container && controls) container.appendChild(controls); 
      pauseAutomationButton.style.display = 'block';
      stopAutomationButton.style.display = 'block';
  }

  function resetUI() {
      pauseAutomationButton.style.display = 'none';
      stopAutomationButton.style.display = 'none';
      if (activeMode === 'multi') startMultiAutomationButton.style.display = 'block';
      else startAutomationButton.style.display = 'block';
  }

  pauseAutomationButton.onclick = async () => {
      const isPaused = pauseAutomationButton.textContent.includes('Продолжить');
      const response = await chrome.runtime.sendMessage({
          action: isPaused ? 'resumeBatchProcessing' : 'pauseBatchProcessing'
      }).catch((error) => ({ success: false, reason: error?.message || 'pause_failed' }));
      if (!response?.success) {
          showStatus(`Не удалось изменить паузу: ${response?.reason || 'unknown error'}`, 'error');
          return;
      }
      pauseAutomationButton.textContent = response.isPaused ? 'Продолжить' : 'Пауза';
  };
  stopAutomationButton.onclick = async () => {
      const response = await chrome.runtime.sendMessage({ action: 'stopAutomation' }).catch((error) => ({
          success: false,
          reason: error?.message || 'stop_failed'
      }));
      if (!response?.success) {
          showStatus(`Не удалось остановить: ${response?.reason || 'unknown error'}`, 'error');
          return;
      }
      resetUI();
      showStatus(response.warning ? `Стоп: ${response.warning}` : 'Стоп', response.warning ? 'error' : 'info');
  };

  // ============================================
  // 9. ИСТОРИЯ ЗАГРУЗОК (Исправлено)
  // ============================================

  async function loadDownloadHistory() {
      try {
        const r = await chrome.runtime.sendMessage({ action: 'getHistory' });
        renderHistory(r?.history || []);
      } catch(e) { renderHistory([]); }
  }

  function renderHistory(history) {
    historyList.innerHTML = '';
    if (!history.length) { historyList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--md-sys-color-on-surface-variant)">история пуста</div>'; return; }

    const folders = {};
    history.forEach(item => { if (!folders[item.voiceName]) folders[item.voiceName] = []; folders[item.voiceName].push(item); });

    Object.keys(folders).sort().forEach(folderName => {
      const div = document.createElement('div');
      div.className = 'history-folder';
      
      const header = document.createElement('div');
      header.className = 'folder-header';
      header.innerHTML = `<span>${folderName}</span><span style="font-weight:400; font-size:11px; color:var(--md-sys-color-on-surface-variant)">${folders[folderName].length} файлов</span>`;
      
      div.appendChild(header);
      
      folders[folderName].sort((a,b)=>b.timestamp-a.timestamp).forEach(item => {
        const d = document.createElement('div');
        d.className = 'history-item';
        d.innerHTML = `
            <div class="history-filename">${item.filename}</div>
            <div class="history-time">${new Date(item.timestamp).toLocaleString()}</div>
        `;
        div.appendChild(d);
      });
      historyList.appendChild(div);
    });
  }

  if (openFolderButton) openFolderButton.onclick = () => chrome.downloads.showDefaultFolder();
  if (clearHistoryButton) clearHistoryButton.onclick = async () => {
      if (confirm('Очистить историю?')) {
          await chrome.runtime.sendMessage({ action: 'clearHistory' });
          loadDownloadHistory();
      }
  };

  // ============================================
  // 8. СООБЩЕНИЯ
  // ============================================

  chrome.runtime.onMessage.addListener(msg => {
      if (msg.action === 'longTextProgress') {
          renderLongTextStatus(msg.summary);
      }
      else if (msg.action === 'parallelBatchProgress') {
          const progress = msg.progress || {};
          applyCompletedCards(progress.completedIds);
          renderRunningProgress(progress.currentIndex || 0, progress.total || 0, true);
          pauseAutomationButton.textContent = progress.isPaused ? 'Продолжить' : 'Пауза';
      }
      else if (msg.action === 'parallelBatchFallback') {
          showStatus(`2 потока отключены: ${msg.reason}. Осталось: ${msg.remaining}`, 'info');
      }
      else if (msg.action === 'parallelBatchComplete') {
          document.querySelectorAll('.preview-card').forEach(c => c.classList.remove('processing'));
          loadSkippedEntries();
          showStatus('Готово в 2 потока!', 'success');
          resetUI();
      }
      else if (msg.runId) {
          return;
      }
      else if (msg.action === 'automationProgress') {
          // Sync Visuals
          const queue = Array.isArray(msg.queue) ? msg.queue : [];
          const entry = queue[msg.currentIndex];
          document.querySelectorAll('.preview-card').forEach(c => c.classList.remove('processing'));
          if (entry) {
              const card = document.querySelector(`.preview-card[data-id="${entry.id}"]`);
              if (card) {
                  card.classList.add('processing');
                  card.scrollIntoView({behavior:'smooth', block:'center'});
              }
          }
          
          // Show progress text
          renderRunningProgress(msg.currentIndex, queue.length, true);
      }
      else if (msg.action === 'automationComplete') {
          document.querySelectorAll('.preview-card').forEach(c => c.classList.remove('processing'));
          loadSkippedEntries();
          showStatus('Готово!', 'success');
          resetUI();
      }
      else if (msg.action === 'automationStopped') {
          document.querySelectorAll('.preview-card').forEach(c => c.classList.remove('processing'));
          resetUI();
          showStatus('Стоп', 'info');
      }
      else if (msg.action === 'skippedEntryCompleted') loadSkippedEntries();
      else if (msg.action === 'automationError') showStatus(msg.error, 'error');
      else if (msg.action === 'updateAutomationProgress') {
          const progress = msg.progress || {};
          if (progress.isPaused) pauseAutomationButton.textContent = 'Продолжить';
          else pauseAutomationButton.textContent = 'Пауза';
          
          applyCompletedCards(progress.completedIds);
          if (progress.isRunning) {
              renderRunningProgress(progress.currentIndex, progress.total, true);
          }
      }
  });

  async function restoreAutomationState() {
      const [res, batchStatus, longTextStatus] = await Promise.all([
          chrome.runtime.sendMessage({action: 'getAutomationState'}).catch(() => null),
          chrome.runtime.sendMessage({action: 'getBatchStatus'}).catch(() => null),
          chrome.runtime.sendMessage({action: 'getLongTextStatus'}).catch(() => null)
      ]);
      renderLongTextStatus(longTextStatus?.summary);
      const state = res?.state;
      if (!state) return false;

      if (Array.isArray(state.parsedEntries)) parsedEntries = state.parsedEntries;
      if (Array.isArray(state.excludedIds)) excludedIds = new Set(state.excludedIds);
      if (Array.isArray(state.multiExcludedIds)) multiExcludedIds = new Set(state.multiExcludedIds);
      if (state.fileName) {
          fileName.textContent = state.fileName;
          multiFileName.textContent = state.fileName;
      }
      const restoredMode = batchStatus?.runtime?.mode || state.mode;
      if (restoredMode) {
          activeMode = restoredMode;
          switchTab(activeMode === 'multi' ? 'multivoice' : 'automation');
      }

      if (activeMode === 'single' && batchFiles_Single.length) {
          selectedSpeaker = state.selectedSpeaker || batchFiles_Single.find(file => file.selectedSpeaker)?.selectedSpeaker || null;

          if (batchFiles_Single.length === 1) {
              parsedEntries = batchFiles_Single[0].entries;
              renderSpeakerSelector();
          } else {
              const speakers = new Set();
              batchFiles_Single.forEach(file => file.entries.forEach(entry => speakers.add(entry.speaker)));
              renderSpeakerSelectorForMultipleFiles([...speakers]);
          }

          if (selectedSpeaker) {
              batchFiles_Single.forEach(file => {
                  file.selectedSpeaker = file.selectedSpeaker || selectedSpeaker;
              });
              const radio = Array.from(document.querySelectorAll('input[name="speaker"]'))
                  .find(input => input.value === selectedSpeaker);
              if (radio) radio.checked = true;

              if (batchFiles_Single.length === 1) {
                  renderPreview();
              } else {
                  renderBatchFilesList('single');
              }
          }
          syncSingleBatchUi();
      }
      renderMultiVoiceUI();

      const isRunningByState = !!state.progress?.isRunning;
      const isRunning = batchStatus?.success ? !!batchStatus.isRunning : isRunningByState;

      if (!isRunning && isRunningByState) {
          chrome.runtime.sendMessage({
              action: 'updateAutomationProgress',
              progress: { isRunning: false, isPaused: false }
          }).catch(() => {});
      }

      if (isRunning) {
          if (activeMode === 'multi') multiConfigContainer.style.display = 'block';
          setRunningState();
          const runtimeProgress = batchStatus?.runtime || state.progress || {};
          pauseAutomationButton.textContent = runtimeProgress.isPaused ? 'Продолжить' : 'Пауза';
          applyCompletedCards(state.progress?.completedIds);
          renderRunningProgress(runtimeProgress.currentIndex, runtimeProgress.total, true);
      }

      return isRunning;
  }

  async function saveState() {
      const exclusionSet = batchFiles_Single.length === 1 ? batchFiles_Single[0].excludedIds : excludedIds;
      await chrome.runtime.sendMessage({
          action: 'saveAutomationData',
          parsedEntries, selectedSpeaker, fileName: fileName.textContent,
          voiceMappings, mode: activeMode,
          excludedIds: Array.from(exclusionSet), multiExcludedIds: Array.from(multiExcludedIds)
      });
      scheduleSaveUiState();
  }

  async function loadSkippedEntries() {
      const mode = activeMode;
      const res = await chrome.runtime.sendMessage({ action: 'getSkippedEntries', mode });
      const containerId = mode === 'multi' ? 'multiSkippedReportArea' : 'skippedReportArea';
      const container = document.getElementById(containerId);
      container.innerHTML = '';
      if (res?.entries?.length) {
          const wrapper = document.createElement('div');
          wrapper.className = 'skipped-report-container';
          const completed = res.entries.filter(e=>e.completed).length;
          if (completed === res.entries.length) return; // All done

          wrapper.innerHTML = `<div class="skipped-header"><span>Пропущено (>200k)</span><span>${completed}/${res.entries.length}</span></div>`;
          res.entries.filter(e=>!e.completed).forEach(e => {
              const d = document.createElement('div');
              d.className = 'skipped-item';
              d.innerHTML = `
                <div style="font-weight:500; font-size:12px; margin-bottom:4px;">${e.fullFileName}</div>
                <div class="preview-text" style="white-space:normal;">${e.preview}</div>
                <div style="display:flex; gap:8px; margin-top:8px;">
                    <button class="copy-btn" style="flex:1; padding:6px; background:var(--accent-blue); border:none; border-radius:4px; color:white; cursor:pointer;">Копировать</button>
                    <button class="done-btn" style="flex:0; padding:6px; background:var(--accent-green); border:none; border-radius:4px; color:white; cursor:pointer; min-width:60px;">OK</button>
                </div>
              `;
              d.querySelector('.copy-btn').onclick = function() { navigator.clipboard.writeText(e.text); this.textContent='✓'; setTimeout(()=>this.textContent='Копировать', 1000); };
              d.querySelector('.done-btn').onclick = async function() {
                  await chrome.runtime.sendMessage({
                    action:'markSkippedAsCompleted',
                    entryId: e.id,
                    entryKey: e.entryKey || null,
                    mode
                  });
                  d.remove();
              };
              wrapper.appendChild(d);
          });
          container.appendChild(wrapper);
      }
  }

  function applyCompletedCards(completedIds) {
      if (!Array.isArray(completedIds)) return;
      completedIds.forEach(id => {
          const c = document.querySelector(`.preview-card[data-id="${id}"]`);
          if (c) {
              c.classList.add('completed');
              c.classList.remove('processing');
          }
      });
  }

  function renderRunningProgress(currentIndex, total, isRunning = true) {
      if (!isRunning) return;
      const statusEl = activeMode === 'multi' ? multiStatus : automationStatus;
      if (!statusEl) return;

      const indexNum = Number(currentIndex);
      const totalNum = Number(total);
      const safeIndex = Number.isFinite(indexNum) && indexNum >= 0 ? indexNum : 0;
      const safeTotal = Number.isFinite(totalNum) && totalNum > 0 ? totalNum : 0;

      statusEl.textContent = safeTotal > 0
          ? `Озвучиваю ${Math.min(safeIndex + 1, safeTotal)} из ${safeTotal}...`
          : 'Озвучка выполняется...';
      statusEl.className = 'status-info';
      statusEl.style.display = 'block';
      statusEl.style.opacity = '1';
  }

  function showStatus(msg, type) {
      const el = (activeMode === 'multi' ? multiStatus : automationStatus) || status;
      el.textContent = msg;
      el.className = `status-${type}`;
      el.style.display = 'block';
      el.style.opacity = '1';
      setTimeout(() => {
          el.style.opacity = '0';
          setTimeout(() => {
              if (el.style.opacity === '0') el.style.display = 'none';
              if (automationControlsCard &&
                  startAutomationButton.style.display === 'none' &&
                  pauseAutomationButton.style.display === 'none' &&
                  stopAutomationButton.style.display === 'none') {
                automationControlsCard.style.display = 'none';
              }
          }, 300);
      }, 3000);
  }
  
  function parseMarkdownText(text) { return (window.parseMarkdown) ? window.parseMarkdown(text) : []; }
  function getStatistics(entries) { const s = {}; entries.forEach(e => { const n = e.speaker.trim(); s[n] = (s[n] || 0) + 1; }); return s; }
});
