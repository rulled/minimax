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

  let parsedEntries = [];
  
  // Single Mode
  let selectedSpeaker = null;
  let excludedIds = new Set(); 
  let currentVoiceName = 'dictor'; 

  // Multi Mode
  let voiceMappings = {};
  let multiExcludedIds = new Set();
  let activeMode = 'single';

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

  // Мульти-войс
  const multiUploadButton = document.getElementById('multiUploadButton');
  const multiScriptFile = document.getElementById('multiScriptFile');
  const multiFileName = document.getElementById('multiFileName');
  const multiConfigContainer = document.getElementById('multiConfigContainer');
  const voiceMappingList = document.getElementById('voiceMappingList');
  // Removed: const multiPreviewList = document.getElementById('multiPreviewList');
  // Removed: const multiSelectionCount = document.getElementById('multiSelectionCount');
  // Removed: const multiToggleSelectionBtn = document.getElementById('multiToggleSelectionBtn');
  const startMultiAutomationButton = document.getElementById('startMultiAutomationButton');
  const resetMultiButton = document.getElementById('resetMultiButton');
  const multiStatus = document.getElementById('multiStatus');
  const multiSkippedReportArea = document.getElementById('multiSkippedReportArea');
  const multiLanguageSelect = document.getElementById('multiLanguageSelect');

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
  
  const data = await chrome.storage.local.get(['tabVoices', 'customNames', 'extensionEnabled', 'voiceMappings']);
  let extensionEnabled = data.extensionEnabled !== false;
  const customNames = data.customNames || [];
  voiceMappings = data.voiceMappings || {}; 

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
  const automationRunning = await restoreAutomationState();
  await restoreUiState(automationRunning);
  await loadSkippedEntries();
  await loadBatchFiles();
  syncSingleBatchUi();
  ensureSingleEmptyUi();

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
           if (lang === 'Russian') opt.selected = true;
           sel.appendChild(opt);
        });
    };
    fillSelect(languageSelect);
    fillSelect(multiLanguageSelect);

    chrome.storage.local.get(['selectedLanguage', 'selectedMultiLanguage'], (d) => {
        if (d.selectedLanguage && languageSelect) languageSelect.value = d.selectedLanguage;
        if (d.selectedMultiLanguage && multiLanguageSelect) multiLanguageSelect.value = d.selectedMultiLanguage;
    });

    if(languageSelect) languageSelect.addEventListener('change', () => chrome.storage.local.set({ selectedLanguage: languageSelect.value }));
    if(multiLanguageSelect) multiLanguageSelect.addEventListener('change', () => chrome.storage.local.set({ selectedMultiLanguage: multiLanguageSelect.value }));
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
        if (entries.length) {
          batchFiles_Single.push({
            name: fileArray[i].name,
            entries: entries,
            selectedSpeaker: null,
            excludedIds: new Set()
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
      syncSingleBatchUi();
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
      if (isBatchAdd) await addBatchFile(file.name, text, mode);
      else processScriptContent(text, file.name, mode);
    } catch (e) { console.error(e); showStatus('Ошибка чтения', 'error'); }
  }

  async function addBatchFile(filename, text, mode) {
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

    const batchData = { name: filename, entries: entries, excludedIds: new Set(), expanded: false };
    if (mode === 'single') {
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
        const voiceSummary = document.createElement('div');
        voiceSummary.style.cssText = 'font-size:11px; color:var(--md-sys-color-on-surface-variant); margin-bottom:8px; padding:6px; background:rgba(0,0,0,0.2); border-radius:8px;';
        const assignedVoices = [];
        Object.keys(stats).forEach(speaker => {
          const voiceId = voiceMappings[speaker];
          if (voiceId) {
            assignedVoices.push(`${speaker}: ${voiceId}`);
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
      let missingEntries = [];
      let selectableEntries = entriesForPreview;
      if (!isSingle) {
        file.entries.forEach(entry => {
            if (!voiceMappings[entry.speaker] || !voiceMappings[entry.speaker].trim()) {
                missingSpeakers.add(entry.speaker);
            }
        });
        missingEntries = file.entries.filter(e => missingSpeakers.has(e.speaker));
        selectableEntries = file.entries.filter(e => !missingSpeakers.has(e.speaker));
        missingEntries.forEach(e => file.excludedIds.add(e.id));
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
            if (!isSingle) {
                missingEntries.forEach(e => file.excludedIds.add(e.id));
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
                missingVoice: !isSingle && missingSpeakers.has(entry.speaker)
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

  function processScriptContent(text, filenameStr, mode) {
    const nameDisplay = mode === 'single' ? fileName : multiFileName;
    nameDisplay.textContent = filenameStr;
    const entries = parseMarkdownText(text);
    if (!entries.length) return showStatus('Реплики не найдены', 'error');

    if (mode === 'single') {
        parsedEntries = entries;
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
            entries: entries,
            excludedIds: new Set(),  // Каждый файл имеет свой набор исключений
            expanded: false
        };
        batchFiles_Multi.push(newFile);
        
        // Обновляем глобальные voiceMappings если появились новые спикеры
        entries.forEach(entry => {
          if (!voiceMappings[entry.speaker]) {
            voiceMappings[entry.speaker] = '';
          }
        });
        
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
    // Собираем уникальных спикеров из ВСЕХ файлов
    const allSpeakers = new Set();
    batchFiles_Multi.forEach(file => {
      file.entries.forEach(entry => allSpeakers.add(entry.speaker));
    });
    
    if (allSpeakers.size === 0) return;
    
    voiceMappingList.innerHTML = '';
    
    // Считаем статистику по всем файлам
    const stats = {};
    batchFiles_Multi.forEach(file => {
      file.entries.forEach(entry => {
        stats[entry.speaker] = (stats[entry.speaker] || 0) + 1;
      });
    });
    
    [...allSpeakers].sort().forEach(speaker => {
      const div = document.createElement('div');
      div.className = 'voice-mapping-item';
      
      div.innerHTML = `
        <div class="voice-mapping-info">
            <span class="voice-mapping-label">${speaker}</span>
            <span class="voice-mapping-count">${stats[speaker] || 0} реплик</span>
        </div>
      `;
      
      const input = document.createElement('input');
      input.className = 'voice-mapping-input';
      input.placeholder = 'Moss ID / Voice Name...';
      input.value = voiceMappings[speaker] || '';
      
      // === ИСПРАВЛЕНИЕ: Автоматическое включение/выключение реплик ===
      input.oninput = (e) => {
          const value = e.target.value.trim();
          voiceMappings[speaker] = value;
          
          // Автоматическое включение/выключение реплик
          // Если ID введен -> включаем (убираем из excluded)
          // Если ID стерт -> выключаем (добавляем в excluded)
          batchFiles_Multi.forEach(file => {
              // Находим все ID реплик этого спикера в файле
              const speakerEntryIds = file.entries
                  .filter(entry => entry.speaker === speaker)
                  .map(entry => entry.id);
                  
              if (value) {
                  // Если ID есть, делаем их активными (удаляем из исключений)
                  speakerEntryIds.forEach(id => file.excludedIds.delete(id));
              } else {
                  // Если ID стерли, делаем неактивными (добавляем в исключения)
                  speakerEntryIds.forEach(id => file.excludedIds.add(id));
              }
          });

          chrome.storage.local.set({voiceMappings});
          saveState();
          saveBatchFiles();
          
          // Перерисовываем список файлов, чтобы галочки обновились
          renderBatchFilesList('multi');
      };
      // ===================================================================
      
      div.appendChild(input);
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
        const voiceId = voiceMap && voiceMap[entry.speaker] ? voiceMap[entry.speaker] : '';
        const voiceDisplay = voiceId ? `<span style="color:var(--accent-green); font-size:10px;">(${voiceId})</span>` : '';
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
      renderFn(); saveState();
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

  startAutomationButton.onclick = async () => {
      activeMode = 'single';
      if (batchFiles_Single.length === 0) return showStatus('Нет файлов', 'error');
      
      const batchJobs = [];
      for (const batchFile of batchFiles_Single) {
          const fileSpeaker = batchFile.selectedSpeaker || selectedSpeaker;
          if (!fileSpeaker) continue;
          
          const entriesToProcess = batchFile.entries.filter(e => e.speaker.toLowerCase().trim() === fileSpeaker.toLowerCase().trim());
          if (entriesToProcess.length === 0) continue;
          
          const scriptName = getScriptNameForNaming(batchFile.name);
          const queue = prepareQueue(entriesToProcess, batchFile.excludedIds, false, scriptName);
          queue.forEach(q => { q.language = languageSelect.value; q.scriptName = scriptName; });
          batchJobs.push({ queue, mode: 'single', scriptName });
      }

      if (batchJobs.length === 0) return showStatus('Очередь пуста', 'error');
      
      const activeTabId = (await chrome.tabs.query({active: true, currentWindow: true}))[0].id;
      chrome.runtime.sendMessage({ action: "startBatchProcessing", jobs: batchJobs, tabId: activeTabId }, (response) => {
          if (response && response.success) {
              setRunningState();
              showStatus(`Запущен пакет: ${batchJobs.length} файлов`, 'success');
              batchFiles_Single = []; 
              if (batchFilesCountValue) batchFilesCountValue.textContent = '0';
              if (batchFilesCounter_Single) batchFilesCounter_Single.style.display = 'none';
              saveBatchFiles();
          }
      });
  };

  startMultiAutomationButton.onclick = async () => {
      activeMode = 'multi';
      if (batchFiles_Multi.length === 0) return showStatus('Нет файлов', 'error');
      
      const batchJobs = [];
      for (let i = 0; i < batchFiles_Multi.length; i++) {
          const file = batchFiles_Multi[i];
          const scriptName = getScriptNameForNaming(file.name);
          const queue = prepareQueue(file.entries, file.excludedIds, true, scriptName);
          if (queue.length === 0) continue;
          queue.forEach(q => q.language = multiLanguageSelect.value); // Use Multi Language
          
          // Check missing - используем глобальные voiceMappings
          const activeSpeakers = [...new Set(queue.map(e => e.speaker))];
          const missing = activeSpeakers.filter(s => !voiceMappings[s] || !voiceMappings[s].trim());
          if (missing.length && !confirm(`Файл "${file.name}"\nНет голоса для: ${missing.join(', ')}. Продолжить?`)) return;
          
          queue.sort((a, b) => a.speaker.localeCompare(b.speaker) || a.speakerIndex - b.speakerIndex);
          batchJobs.push({ queue, mode: 'multi', scriptName });
      }

      if (batchJobs.length === 0) return showStatus('Очередь пуста', 'error');
      const activeTabId = (await chrome.tabs.query({active: true, currentWindow: true}))[0].id;
      chrome.runtime.sendMessage({ action: "startBatchProcessing", jobs: batchJobs, tabId: activeTabId }, (response) => {
          if (response && response.success) {
              setRunningState();
              showStatus(`Запущен мульти-пакет: ${batchJobs.length} файлов`, 'success');
              batchFiles_Multi = []; 
              renderBatchFilesList('multi');
              updateTotalFilesCount();
              saveBatchFiles();
          }
      });
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

  function prepareQueue(items, exclusionSet, useVoiceMap = false, scriptName = null) {
      const speakerCounters = {};
      return items
          .filter(entry => !exclusionSet.has(entry.id))
          .map(entry => {
              if(!speakerCounters[entry.speaker]) speakerCounters[entry.speaker] = 0;
              speakerCounters[entry.speaker]++;
              return {
                  ...entry,
                  speakerIndex: speakerCounters[entry.speaker],
                  voiceId: useVoiceMap ? (voiceMappings[entry.speaker] || null) : null,
                  scriptName: scriptName
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

  pauseAutomationButton.onclick = () => {
      const isPaused = pauseAutomationButton.textContent.includes('Продолжить');
      chrome.tabs.query({active:true, currentWindow:true}, t => chrome.tabs.sendMessage(t[0].id, {action: isPaused?'resumeAutomation':'pauseAutomation'}));
  };
  stopAutomationButton.onclick = () => chrome.tabs.query({active:true, currentWindow:true}, t => chrome.tabs.sendMessage(t[0].id, {action:'stopAutomation'}, () => {resetUI(); showStatus('Стоп', 'info');}));

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
      if (msg.action === 'automationProgress') {
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
      const [res, batchStatus] = await Promise.all([
          chrome.runtime.sendMessage({action: 'getAutomationState'}).catch(() => null),
          chrome.runtime.sendMessage({action: 'getBatchStatus'}).catch(() => null)
      ]);
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

      if (activeMode === 'single' && parsedEntries.length) {
          renderSpeakerSelector();
          if (state.selectedSpeaker) {
              selectedSpeaker = state.selectedSpeaker;
              const radio = document.querySelector(`input[name="speaker"][value="${selectedSpeaker}"]`);
              if (radio) radio.checked = true;
              renderPreview();
          }
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

          wrapper.innerHTML = `<div class="skipped-header"><span>Пропущено (>5k)</span><span>${completed}/${res.entries.length}</span></div>`;
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
