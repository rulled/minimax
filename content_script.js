// Храним состояние расширения
let extensionEnabled = false;
let isInitialized = false;
let automationOverrideIndex = null;
let automationOverrideSpeaker = null; 
let automationOverrideScriptName = null; 
let currentAutomationMode = 'single'; 

// Сохранение пропущенных записей
let skippedEntriesBuffer = [];

async function initialize() {
  try {
    const data = await chrome.storage.local.get('extensionEnabled');
    extensionEnabled = data.extensionEnabled !== false;
    isInitialized = true;
  } catch (error) {
    extensionEnabled = true;
    isInitialized = true;
  }
}

initialize();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionEnabled) {
    extensionEnabled = changes.extensionEnabled.newValue;
    if (!extensionEnabled && automation && automation.isRunning) {
      automation.stop();
    }
  }
});

function isValidDownloadLink(url) {
  if (!url.endsWith('.mp3')) return false;
  return url.includes('cdn.hailuoai.video') || url.includes('minimax.io'); 
}

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findMp3OptionInOpenDropdown() {
  const dropdowns = Array.from(document.querySelectorAll('.ant-dropdown, [role="menu"]'))
    .filter((el) => isVisibleElement(el) && !el.classList.contains('ant-dropdown-hidden'));

  for (const dropdown of dropdowns) {
    const items = Array.from(dropdown.querySelectorAll('li[role="menuitem"], .ant-dropdown-menu-item, [role="menuitem"]'));
    if (!items.length) continue;

    let mp3Item = items.find((item) => {
      const dataMenuId = String(item.getAttribute('data-menu-id') || '').toLowerCase();
      return dataMenuId.includes('tts_no_watermark') && !dataMenuId.includes('wav');
    });

    if (!mp3Item) {
      mp3Item = items.find((item) => {
        const text = String(item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return text.includes('mp3');
      });
    }

    if (mp3Item) return mp3Item;
  }

  return null;
}

async function clickMp3FromDownloadMenu(maxWaitMs = 4000, intervalMs = 120) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const mp3Item = findMp3OptionInOpenDropdown();
    if (mp3Item) {
      mp3Item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      mp3Item.click();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

let lastClickTime = 0;
const CLICK_DEBOUNCE_MS = 300;

async function handleClick(event) {
  // --- ВАЖНЫЙ ФИКС: Игнорируем клики от робота ---
  if (!event.isTrusted) return;
  // ----------------------------------------------

  const now = Date.now();
  if (now - lastClickTime < CLICK_DEBOUNCE_MS) return;

  const target = event.target.closest('a, div.cursor-pointer');
  if (!target) return;

  const hasDownloadIcon = target.querySelector('path[d^="M12.3984 13.6006H3.59844"]');
  const isAudioLink = target.tagName === 'A' && target.href && target.href.includes('.mp3');

  if (!hasDownloadIcon && !isAudioLink) return;

  if (!isInitialized) await initialize();
  if (!extensionEnabled) return;

  lastClickTime = now;

  if (automationOverrideIndex === null && hasDownloadIcon) {
      const res = await chrome.runtime.sendMessage({ action: "getTabVoiceName" });
      const voiceName = res?.voiceName || 'dictor';

      await chrome.runtime.sendMessage({
          action: "primeNextDownload",
          voiceName: voiceName
      });
  }
  
  if (isAudioLink) {
    event.preventDefault();
    
    const link = target;
    const originalOpacity = link.style.opacity;
    link.style.opacity = '0.5';

    try {
      const message = {
        action: "downloadFile",
        url: link.href
      };

      if (automationOverrideIndex !== null) {
        message.forceIndex = automationOverrideIndex;
        automationOverrideIndex = null;
      }
      
      if (automationOverrideSpeaker !== null) {
          message.forceSpeaker = automationOverrideSpeaker;
          automationOverrideSpeaker = null;
      }
      
      if (automationOverrideScriptName !== null) {
          message.scriptName = automationOverrideScriptName;
          automationOverrideScriptName = null;
      }
      
      message.mode = currentAutomationMode;

      const response = await chrome.runtime.sendMessage(message);

      if (response && response.success) {
        link.style.opacity = originalOpacity;
      } else {
        console.error('Download error:', response?.reason);
        link.style.opacity = originalOpacity;
        if (response?.reason === 'disabled' || response?.reason === 'invalid-url') {
          setTimeout(() => {
            const newEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            document.removeEventListener('click', handleClick, true);
            link.dispatchEvent(newEvent);
            setTimeout(() => document.addEventListener('click', handleClick, true), 100);
          }, 100);
        }
      }
    } catch (error) {
      console.error('Message error:', error);
      link.style.opacity = originalOpacity;
    }
  }
}

document.addEventListener('click', handleClick, true);

// ============================================
// AUTOMATION CLASS
// ============================================

let automation = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startAutomation') {
    if (!extensionEnabled) {
      sendResponse({ success: false, reason: 'disabled' });
      return true;
    }
    if (!automation || !automation.isRunning) automation = new VoiceoverAutomation();
    automation.setQueue(request.queue);
    automation.setMode(request.mode || 'single');
    automation.setScriptName(request.scriptName || null);
    automation.start();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'pauseAutomation') {
    if (automation) automation.pause();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'resumeAutomation') {
    if (automation) automation.resume();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'stopAutomation') {
    if (automation) automation.stop();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'getAutomationRuntimeState') {
    sendResponse({
      success: true,
      state: {
        isRunning: !!(automation && automation.isRunning),
        isPaused: !!(automation && automation.isPaused),
        currentIndex: automation ? automation.currentIndex : 0,
        total: automation && Array.isArray(automation.queue) ? automation.queue.length : 0,
        mode: automation?.mode || currentAutomationMode || 'single'
      }
    });
    return true;
  }
  if (request.action === 'listVoicesFromUi') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.listVoicesFromUi(request.prefix || '').then((result) => {
      sendResponse({
        success: !!result?.ok,
        voices: Array.isArray(result?.voices) ? result.voices : [],
        reason: result?.reason || null
      });
    }).catch((error) => {
      sendResponse({
        success: false,
        voices: [],
        reason: error?.message || 'list_voices_from_ui_failed'
      });
    });
    return true;
  }
});

class VoiceoverAutomation {
    constructor() {
        this.queue = [];
        this.currentIndex = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.isStopped = false;
        this.currentVoiceId = null;
        this.mode = 'single';
        this.scriptName = null;
        this.skippedEntries = []; 
        
        this.selectors = {
            textarea: '[data-slate-editor="true"]',
            switchVoiceBtnXPath: '//div[contains(@class, "flex") and .//path[starts-with(@d, "M5.24492 3.34774")]',
            searchVoiceInput: 'input[placeholder*="Search"], input[placeholder*="voices"], input[placeholder*="Voices"]',
            useVoiceBtnXPath: '//div[contains(text(), "Use") and contains(@class, "ant-btn")]',
            closeModalBtnXPath: '//span[contains(@class, "anticon-close")]',
            languageDropdownTrigger: '.language-select .ant-select-selector',
            languageCurrentValue: '.language-select .ant-select-selection-item',
            languageOptionXPath: (lang) => `//div[contains(@class, "ant-select-item-option") and text()="${lang}"]`
        };
    }

    setMode(mode) {
        this.mode = mode;
        currentAutomationMode = mode;
    }

    setScriptName(name) {
        this.scriptName = name;
    }

    buildExpectedOutputInfo(entry) {
        const downloadLayout = String(entry.downloadLayout || '').trim().toLowerCase();
        const folderBase = sanitizeFilenamePart(entry.scriptName || this.scriptName || entry.speaker || 'dictor');
        const speakerBase = sanitizeFilenamePart(entry.speaker || entry.originalTag || 'dictor');
        const fileNumber = Number(entry.downloadIndex || entry.speakerIndex || 1);

        if (downloadLayout === 'package') {
            const paddedNumber = String(fileNumber).padStart(3, '0');
            return {
                folderName: folderBase || speakerBase || 'dictor',
                fileNamePrefix: speakerBase || 'dictor',
                fullFileName: `${folderBase || speakerBase || 'dictor'}/${paddedNumber}__${speakerBase || 'dictor'}.mp3`
            };
        }

        const paddedNumber = String(fileNumber).padStart(4, '0');
        const folderName = this.scriptName ? `${folderBase} - ${speakerBase}` : speakerBase;
        const fileNamePrefix = this.scriptName ? `${folderBase} - ${speakerBase}` : speakerBase;
        return {
            folderName,
            fileNamePrefix,
            fullFileName: `${folderName}/${paddedNumber}_${fileNamePrefix}.mp3`
        };
    }

    setQueue(entries) {
        this.queue = entries.map(e => ({ ...e, status: 'pending', attempt: 0 }));
        this.currentIndex = 0;
        this.skippedEntries = []; 
        this.notifyProgress();
        this.log('Queue set:', this.queue.length);
    }

    log(msg, data = '') {
        console.log(`%c[Auto-Log] ${msg}`, 'color: #00ff00; font-weight: bold;', data);
    }

    error(msg, err = '') {
        console.error(`%c[Auto-Error] ${msg}`, 'color: #ff0000; font-weight: bold;', err);
        this.notifyError(msg);
    }

    normalizeVoiceLabel(value) {
        return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    voiceLabelsMatch(a, b) {
        const left = this.normalizeVoiceLabel(a);
        const right = this.normalizeVoiceLabel(b);
        if (!left || !right) return false;
        if (left === right) return true;
        if (left.length >= 8 && right.includes(left)) return true;
        if (right.length >= 8 && left.includes(right)) return true;
        return false;
    }

    closeVoiceModal() {
        const modalRoot = document.querySelector('.ant-modal-root .ant-modal-content, .ant-modal-content, .ant-modal');

        if (modalRoot) {
            const titleClosePath = modalRoot.querySelector('.ant-modal-title path[d^="M12 13.8998L7.10005 18.7998"]');
            if (titleClosePath) {
                const clickable = titleClosePath.closest('div.cursor-pointer, button, [role="button"], div');
                if (clickable) {
                    clickable.click();
                    return true;
                }
            }

            const genericClose = modalRoot.querySelector(
                '.ant-modal-close, .ant-modal-header div.cursor-pointer, button[aria-label*="Close"], button[aria-label*="close"]'
            );
            if (genericClose) {
                genericClose.click();
                return true;
            }
        }

        const closeBtn = this.getElementByXPath(this.selectors.closeModalBtnXPath);
        if (closeBtn) {
            closeBtn.click();
            return true;
        }

        return false;
    }

    installStealthVoiceModalStyle() {
        const style = document.createElement('style');
        style.setAttribute('data-minimax-voice-modal-stealth', 'true');
        style.textContent = `
            .ant-modal-root,
            .ant-modal-wrap,
            .ant-modal-mask {
                opacity: 0 !important;
                animation: none !important;
                transition: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
        return () => {
            if (style.parentNode) style.parentNode.removeChild(style);
        };
    }

    getVoiceSelectorButton() {
        const currentVoiceNameEl = document.querySelector('section h4 > span, div.selected-voice-icon h4 > span, div[class*="selected-voice"] h4 > span');
        if (currentVoiceNameEl) {
            const clickable = currentVoiceNameEl.closest('[role="button"], button, div.cursor-pointer, div');
            if (clickable) return clickable;
        }

        const svgPath = document.querySelector('path[d^="M5.24492 3.34774"]');
        if (svgPath) {
            const clickable = svgPath.closest('[role="button"], button, div.cursor-pointer, div.flex, div');
            if (clickable) return clickable;
        }

        return null;
    }

    getVoiceTabButton(label) {
        const target = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return Array.from(document.querySelectorAll('[role="tab"]')).find((tab) => {
            const text = String(tab.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            return text === target;
        }) || null;
    }

    setNativeInputValue(input, value) {
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    getCurrentVoiceCandidates() {
        const candidates = [];

        const pushCandidate = (value) => {
            const text = String(value || '').trim();
            if (text) candidates.push(text);
        };

        const headerNameEl = document.querySelector('section h4 > span') ||
                             document.querySelector('div.selected-voice-icon h4 > span') ||
                             document.querySelector('div[class*="selected-voice"] h4 > span');
        if (headerNameEl) pushCandidate(headerNameEl.textContent);

        const copyIcon = document.querySelector('h4 path[d^="M3.75 1.5C3.61192"]');
        const copyH4 = copyIcon ? copyIcon.closest('h4') : null;
        if (copyH4) {
            const spans = Array.from(copyH4.querySelectorAll('span'));
            spans.forEach((span) => pushCandidate(span.textContent));
        }

        return [...new Set(candidates)];
    }

    async tryReadCurrentVoiceFromCopyButton() {
        const copyIcon = document.querySelector('h4 path[d^="M3.75 1.5C3.61192"]');
        if (!copyIcon) return '';

        const copyH4 = copyIcon.closest('h4');
        if (copyH4) {
            const span = copyH4.querySelector('span');
            if (span && span.textContent && span.textContent.trim()) {
                return span.textContent.trim();
            }
        }

        const btn = copyIcon.closest('div');
        if (!btn || !navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            return '';
        }

        try {
            const before = await navigator.clipboard.readText();
            btn.click();
            await this.sleep(120);
            const after = await navigator.clipboard.readText();
            if (after && after.trim() && after !== before) {
                return after.trim();
            }
        } catch (e) {
            return '';
        }

        return '';
    }

    async isTargetVoiceAlreadyActive(targetId) {
        const candidates = this.getCurrentVoiceCandidates();
        if (candidates.some((candidate) => this.voiceLabelsMatch(candidate, targetId))) {
            return true;
        }

        const copied = await this.tryReadCurrentVoiceFromCopyButton();
        if (copied && this.voiceLabelsMatch(copied, targetId)) {
            return true;
        }

        return false;
    }

    findVoiceResultCards() {
        const modalRoot = document.querySelector('.ant-modal-root .ant-modal-content, .ant-modal-content, .ant-modal') || document;
        const cards = Array.from(modalRoot.querySelectorAll(
            '[role="tabpanel"] [class*="cursor-pointer"], [role="tabpanel"] [role="button"], [role="tabpanel"] button, #voice-selection-scroll-list .ant-list-item, #voice-selection-scroll-list > div > div, #voice-selection-scroll-list > div, div.grid > div'
        )).filter((card) => {
            const text = String(card && card.textContent || '').trim();
            return text && (card.querySelector('h4') || /use|selected/i.test(text));
        });
        const unique = [];
        const seen = new Set();
        cards.forEach((card) => {
            if (!card || seen.has(card)) return;
            seen.add(card);
            unique.push(card);
        });
        return unique;
    }

    extractVoiceNames(cards) {
        const names = [];
        const seen = new Set();

        cards.forEach((card) => {
            const heading = card.querySelector('h4');
            const voiceName = String(heading?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!voiceName) return;

            const key = this.normalizeVoiceLabel(voiceName);
            if (!key || seen.has(key)) return;
            seen.add(key);
            names.push(voiceName);
        });

        return names;
    }

    async listVoicesFromUi(prefix = '') {
        const normalizedPrefix = this.normalizeVoiceLabel(prefix);
        const modalSelector = '.ant-modal-root .ant-modal-content, .ant-modal-content, .ant-modal, [role="dialog"]';
        let modal = document.querySelector(modalSelector);
        let openedByScript = false;
        let removeStealthStyle = null;

        try {
            if (!modal || !isVisibleElement(modal)) {
                const switchBtn = this.getVoiceSelectorButton();
                if (!switchBtn) {
                    return { ok: false, reason: 'voice_selector_button_not_found', voices: [] };
                }
                removeStealthStyle = this.installStealthVoiceModalStyle();
                switchBtn.click();
                openedByScript = true;
                await this.sleep(900);
                modal = document.querySelector(modalSelector);
            }

            if (!modal || !isVisibleElement(modal)) {
                return { ok: false, reason: 'voice_modal_not_visible', voices: [] };
            }

            const myVoicesTab = this.getVoiceTabButton('My Voices');
            if (!myVoicesTab) {
                return { ok: false, reason: 'my_voices_tab_not_found', voices: [] };
            }
            if (myVoicesTab.getAttribute('aria-selected') !== 'true') {
                myVoicesTab.click();
                await this.sleep(800);
            }

            const input = await this.waitForElement(this.selectors.searchVoiceInput, 2500);
            if (input) {
                this.setNativeInputValue(input, prefix);
                await this.sleep(1200);
            }

            const voices = this.extractVoiceNames(this.findVoiceResultCards()).filter((name) => {
                if (!normalizedPrefix) return true;
                return this.normalizeVoiceLabel(name).includes(normalizedPrefix);
            });

            return { ok: true, voices };
        } finally {
            if (openedByScript) {
                this.closeVoiceModal();
                await this.sleep(120);
            }
            if (removeStealthStyle) removeStealthStyle();
        }
    }

    getVoiceActionState(scope) {
        const root = scope || document;
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const spans = Array.from(root.querySelectorAll('span'));

        const selectedSpan = spans.find((span) => normalize(span.textContent) === 'selected');
        if (selectedSpan) {
            const el = selectedSpan.closest('div.cursor-not-allowed, button, [role="button"], div') || selectedSpan;
            return { state: 'selected', element: el };
        }

        const useSpan = spans.find((span) => normalize(span.textContent) === 'use');
        if (useSpan) {
            const el = useSpan.closest('div.cursor-pointer, button, [role="button"], div') || useSpan;
            return { state: 'use', element: el };
        }

        // Fallback: иконка кнопки Use из текущего UI Minimax.
        const useIcon = root.querySelector('div.cursor-pointer path[d^="M11.2553 1.57855"]');
        if (useIcon) {
            const el = useIcon.closest('div.cursor-pointer, button, [role="button"], div') || useIcon;
            return { state: 'use', element: el };
        }

        // Fallback: disabled кнопка без явного текста.
        const selectedContainer = root.querySelector('div.cursor-not-allowed');
        if (selectedContainer) {
            return { state: 'selected', element: selectedContainer };
        }

        return null;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isPaused = false;
        this.isStopped = false;
        this.notifyProgress();
        this.log('Automation STARTED');
        try {
            await this.processQueue();
        } catch (error) {
            this.error('Fatal error in processQueue', error);
        } finally {
            this.isRunning = false;
            if (!this.isStopped) this.notifyComplete();
            this.log('Automation FINISHED');
        }
    }

    pause() { if (this.isRunning) { this.isPaused = true; this.notifyPause(); this.log('PAUSED'); } }
    resume() { if (this.isRunning && this.isPaused) { this.isPaused = false; this.notifyResume(); this.log('RESUMED'); } }
    stop() { this.isRunning = false; this.isPaused = false; this.isStopped = true; this.notifyStop(); this.log('STOPPED'); }

    async processQueue() {
        while (this.currentIndex < this.queue.length) {
            if (!this.isRunning) break;
            while (this.isPaused) await this.sleep(500);

            const entry = this.queue[this.currentIndex];
            this.log(`Processing #${this.currentIndex + 1}: Speaker=${entry.speaker}`);

            if (entry.text.length > 5000) {
                this.log('Skipping text > 5000 chars');
                const outputInfo = this.buildExpectedOutputInfo(entry);
                
                const skippedEntry = {
                    ...entry,
                    scriptName: this.scriptName,
                    mode: this.mode,
                    speakerIndex: Number(entry.speakerIndex || 1),
                    downloadIndex: Number(entry.downloadIndex || entry.speakerIndex || 1),
                    fullFileName: outputInfo.fullFileName,
                    folderName: outputInfo.folderName
                };
                
                this.skippedEntries.push(skippedEntry);
                chrome.runtime.sendMessage({
                    action: 'saveSkippedEntries',
                    entries: this.skippedEntries,
                    mode: this.mode
                }).catch(() => {});
                
                entry.status = 'skipped_manual';
                this.notifyProgress();
                this.currentIndex++;
                continue;
            }

            try {
                entry.status = 'processing';
                this.notifyProgress();

                await this.processEntry(entry);

                entry.status = 'completed';
                this.notifyProgress();
                this.currentIndex++;
                await this.sleep(1000);
            } catch (error) {
                this.error(`Failed processing entry #${this.currentIndex}`, error);
                entry.attempt++;
                if (entry.attempt < 2 && this.isRunning) {
                    this.log('Retrying...');
                    await this.sleep(2000);
                    continue;
                }
                entry.status = 'error';
                entry.error = error.message;
                this.currentIndex++;
            }
        }
    }

    async processEntry(entry) {
        // Проверяем флаг остановки перед каждой операцией
        if (!this.isRunning) {
            this.log('STOP requested, aborting processEntry');
            return;
        }
        
        if (entry.voiceId) {
            this.log(`Switching voice to: ${entry.voiceId}`);
            try {
                await this.switchVoice(entry.voiceId);
            }
            catch (e) {
                // Если голос не найден - пропускаем эту реплику
                if (String(e.message || '').toLowerCase().includes('not found')) {
                    this.log(`Voice "${entry.voiceId}" not found, skipping entry`);
                    entry.status = 'skipped_voice_not_found';
                    this.notifyProgress();
                    return; // Выходим из processEntry, не обрабатываем эту реплику
                } else {
                    this.error('Voice switch FAILED', e);
                    throw new Error(`Voice switch failed: ${e.message}`);
                }
            }
        }

        if (!this.isRunning) {
            this.log('STOP requested, aborting after voice switch');
            return;
        }

        if (entry.language) {
            this.log(`Checking language: ${entry.language}`);
            await this.ensureLanguage(entry.language);
        }

        if (!this.isRunning) {
            this.log('STOP requested, aborting after language check');
            return;
        }

        const textarea = await this.waitForElement('[data-slate-editor="true"]', 5000);
        const targetEl = textarea || await this.waitForElement(this.selectors.textarea, 5000);

        if (!targetEl) throw new Error('Textarea (Slate editor) not found');

        // === ГЛАВНОЕ: Вставка текста (Замена всего старого на новое) ===
        await this.insertText(targetEl, entry.text);

        this.log('Waiting for React to validate input...');
        await this.sleep(1000); 

        if (!this.isRunning) {
            this.log('STOP requested, aborting before generate');
            return;
        }

        // Проверка активности кнопки
        let generateBtn = await this.findGenerateButton();

        if (!generateBtn || generateBtn.disabled || generateBtn.classList.contains('opacity-60')) {
            throw new Error('Generate button not active');
        }

        const btnText = generateBtn.textContent.trim().toLowerCase();
        if (btnText === 'generating') {
            await this.waitForButtonState(['regenerate']);
        }

        const captureInstallResult = await this.callBridge('ensureAudioCaptureInstalled');
        if (!captureInstallResult || !captureInstallResult.ok) {
            throw new Error(`Audio capture install failed: ${captureInstallResult && captureInstallResult.reason ? captureInstallResult.reason : 'unknown reason'}`);
        }
        this.log(captureInstallResult.alreadyInstalled ? 'Audio capture installed (already active)' : 'Audio capture installed');

        const captureResetResult = await this.callBridge('resetAudioCaptureSession');
        if (!captureResetResult || !captureResetResult.ok) {
            throw new Error(`Audio capture reset failed: ${captureResetResult && captureResetResult.reason ? captureResetResult.reason : 'unknown reason'}`);
        }
        this.log('Audio capture session reset');

        generateBtn.click();
        this.log('Clicked Generate');

        if (!this.isRunning) {
            this.log('STOP requested, aborting after generate click');
            return;
        }

        // Ждем кнопку скачивания
        this.log('Waiting for download button...');
        const downloadBtn = await this.waitForNewDownloadButton();
        if (!downloadBtn) throw new Error('Download button not found (timeout)');

        if (!this.isRunning) {
            this.log('STOP requested, aborting before download');
            return;
        }

        const fileNameBase = entry.originalTag || entry.speaker || 'dictor';
        const captureResult = await this.getCapturedAudioData(12000);
        this.log(`Audio captured via ${captureResult.source || 'unknown'} (${captureResult.size || 0} bytes)`);

        const downloadRes = await chrome.runtime.sendMessage({
            action: "downloadAudioData",
            dataUrl: captureResult.dataUrl,
            voiceName: fileNameBase,
            scriptName: entry.scriptName || null,
            forceIndex: entry.downloadIndex || entry.speakerIndex || null,
            speakerName: entry.speaker || null,
            downloadLayout: entry.downloadLayout || null
        });
        if (!downloadRes || !downloadRes.success) {
            throw new Error(`Audio download failed: ${downloadRes && downloadRes.reason ? downloadRes.reason : 'unknown reason'}`);
        }
        this.log(`Download started (id: ${downloadRes.downloadId || 'n/a'})`);
        this.log(`Download confirmed (index: ${downloadRes.fileNumber || 'n/a'})`);

          await this.sleep(1500);
          // Очистка в конце, чтобы подготовить почву (но insertText тоже очистит)
        await this.clearText();
    }

    // ============================================
    // MAIN WORLD BRIDGE
    // Content script живёт в isolated world и не видит __reactFiber$.
    // Все операции с Slate state идут через background.js -> chrome.scripting.executeScript с world:'MAIN'.
    // ============================================

    async callBridge(action, ...args) {
        // Шлём только имя метода (строку) и аргументы.
        // Сами функции определены в background.js — Chrome не сериализует функции через sendMessage.
        const response = await chrome.runtime.sendMessage({
            action: 'executeInMainWorld',
            method: action,
            args
        });

        if (!response || !response.success) {
            this.error('Bridge call failed: ' + (response && response.reason || 'unknown'));
            return null;
        }
        return response.result;
    }

    // --- ОЧИСТКА: просто выставляем selection на всё (замена произойдёт при следующей вставке) ---
    async clearText() {
        this.log('🧹 Preparing editor for next insert...');
        const ok = await this.callBridge('selectAll');
        if (ok) {
            this.log('   ✨ Selection set to full range.');
        } else {
            this.log('   ⚠️ selectAll returned false (editor empty or not found).');
        }
    }

    // --- ВСТАВКА через main world bridge ---
    async insertText(el, text) {
        this.log(`🚀 Slate Insert (Length: ${text.length})...`);
        const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

        const result = await this.callBridge('insertText', text);
        if (!result || !result.ok) {
            throw new Error('insertText via bridge failed: ' + (result && result.reason || 'unknown'));
        }
        this.log('✅ beforeinput dispatched via main world bridge');

        // Ожидание обновления state
        const waitTime = text.length > 500 ? 1500 : 800;
        this.log(`   ⏳ Waiting ${waitTime}ms for Slate...`);
        await this.sleep(waitTime);

        // Проверяем state
        let slateText = await this.callBridge('getText');
        if (normalizeText(slateText) === normalizeText(text)) {
            this.log(`✅ Slate state confirmed: "${slateText.slice(0, 50)}${slateText.length > 50 ? '...' : ''}"`);
        } else {
            this.log('⚠️ Slate state mismatch, пробуем paste fallback...');
            const freshEl = document.querySelector('[data-slate-editor="true"]');
            if (freshEl) {
                const dataTransfer = new DataTransfer();
                dataTransfer.setData('text/plain', text);
                freshEl.dispatchEvent(new ClipboardEvent('paste', {
                    bubbles: true, cancelable: true, clipboardData: dataTransfer, view: window
                }));
                await this.sleep(waitTime);
            }
            slateText = await this.callBridge('getText');
            if (normalizeText(slateText) !== normalizeText(text)) {
                throw new Error(`Editor text mismatch after insert. Expected ${text.length} chars, got ${(slateText || '').length}`);
            }
        }

        await this.sleep(300);
    }

    // --- Остальные методы без изменений ---
    
    async switchVoice(targetId) {
        // 1. ОПТИМИЗАЦИЯ: Сначала проверяем внутреннее состояние
        if (this.currentVoiceId === targetId) {
            this.log(`Voice "${targetId}" internal state matches, skipping switch`);
            return;
        }

        // 2. Проверяем реальный DOM (в т.ч. блок с copy-иконкой в h4)
        if (await this.isTargetVoiceAlreadyActive(targetId)) {
            this.log(`DOM Check: Voice "${targetId}" is already active on page.`);
            this.currentVoiceId = targetId;
            return;
        }

        this.log('1. Clicking voice selector...');

        let switchBtn = null;
        let attempts = 0;
        while(!switchBtn && attempts < 10) {
            switchBtn = this.getVoiceSelectorButton();
            if (!switchBtn) {
                 const xpathResult = document.evaluate(this.selectors.switchVoiceBtnXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                switchBtn = xpathResult.singleNodeValue;
            }
            if(!switchBtn) { await this.sleep(500); attempts++; }
        }

        if (!switchBtn) throw new Error('Could not find Voice Selector button');
        switchBtn.click();
        await this.sleep(1500);
        let modalOpened = true;

        try {
            const targetTabs = targetId.startsWith('moss_audio_') ? ['My Voices'] : ['My Voices', 'Library'];
            let applied = false;

            for (const targetTab of targetTabs) {
                let tabButton = this.getVoiceTabButton(targetTab);
                if (!tabButton) {
                    const legacyTabId = targetTab === 'My Voices' ? 'MyVoices' : targetTab;
                    const tabXPath = `//div[@role="tab" and @id[contains(., "${legacyTabId}")]]`;
                    tabButton = this.getElementByXPath(tabXPath);
                }

                if (tabButton && !tabButton.classList.contains('ant-tabs-tab-active') && tabButton.getAttribute('aria-selected') !== 'true') {
                    this.log(`Switching to ${targetTab} tab...`);
                    tabButton.click();
                    await this.sleep(1000);
                }

                const input = await this.waitForElement(this.selectors.searchVoiceInput, 5000);
                if (!input) continue;

                this.setNativeInputValue(input, '');
                await this.sleep(200);
                this.setNativeInputValue(input, targetId);
                await this.sleep(1800);

                const cards = this.findVoiceResultCards();
                const normalizedTarget = this.normalizeVoiceLabel(targetId);
                let targetCard = cards.find((card) => {
                    const text = this.normalizeVoiceLabel(card.innerText || card.textContent || '');
                    return text.includes(normalizedTarget) || this.voiceLabelsMatch(text, targetId);
                });
                if (!targetCard) {
                    targetCard = cards.find((card) => !!this.getVoiceActionState(card));
                }
                if (!targetCard && cards.length === 1) targetCard = cards[0];
                if (!targetCard && cards.length > 0) targetCard = cards[0];
                if (!targetCard) continue;

                targetCard.click();
                await this.sleep(200);

                let actionState = this.getVoiceActionState(targetCard);
                if (!actionState) {
                    actionState = this.getVoiceActionState(document.querySelector('.ant-modal-root .ant-modal-content, .ant-modal-content, .ant-modal') || document);
                }
                if (!actionState) continue;
                this.log(`[VoiceSwitch] action=${actionState.state} via ${targetTab}`);

                if (actionState.state === 'selected') {
                    this.log('Voice already selected in search result.');
                    this.currentVoiceId = targetId;
                    applied = true;
                    break;
                }

                if (actionState.state === 'use') {
                    this.log('[VoiceSwitch] clicking Use');
                    actionState.element.click();
                    await this.sleep(1000);
                    this.currentVoiceId = targetId;
                    applied = true;
                    break;
                }
            }

            if (!applied) throw new Error(`Voice ID "${targetId}" not found`);
        } finally {
            if (modalOpened) {
                this.closeVoiceModal();
            }
        }
    }

    async ensureLanguage(targetLang) {
        const getCurrentLanguageText = () => {
            const currentValEl = document.querySelector(this.selectors.languageCurrentValue);
            return currentValEl ? currentValEl.innerText.trim() : '';
        };

        const trigger = document.querySelector(this.selectors.languageDropdownTrigger);
        if (!trigger) throw new Error('Language selector not found');

        const currentText = getCurrentLanguageText();

        if (currentText === targetLang) return;

        const chooseLanguageOption = async () => {
            trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            trigger.click();
            await this.sleep(1000);

            const optionXPath = this.selectors.languageOptionXPath(targetLang);
            let option = this.getElementByXPath(optionXPath);

            if (!option) {
                const dropdowns = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list-holder');
                const listHolder = dropdowns[dropdowns.length - 1];
                if (listHolder) {
                    for (let i = 0; i < 10; i++) {
                        listHolder.scrollTop += 200;
                        await this.sleep(200);
                        option = this.getElementByXPath(optionXPath);
                        if (option) break;
                    }
                }
            }

            if (!option) {
                trigger.click();
                return false;
            }

            option.scrollIntoView({ block: 'center' });
            await this.sleep(200);
            option.click();
            await this.sleep(800);
            return getCurrentLanguageText() === targetLang;
        };

        for (let attempt = 0; attempt < 2; attempt++) {
            const applied = await chooseLanguageOption();
            if (applied) return;
            await this.sleep(400);
        }

        throw new Error(`Language "${targetLang}" was not applied`);
    }

    getElementByXPath(xpath) {
        return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }

    // Проверка на ошибки UI (тосты, сообщения об ошибках)
    checkForUiErrors() {
        // Селекторы для разных типов ошибок Minimax
        const errorSelectors = [
            '.ant-message-error',
            '.Toastify__toast--error',
            '.ant-notification-notice-error',
            '[class*="error"]',
            '[class*="Error"]'
        ];
        
        for (const selector of errorSelectors) {
            const errorEl = document.querySelector(selector);
            if (errorEl && errorEl.textContent) {
                const text = errorEl.textContent.trim();
                // Фильтруем ложные срабатывания
                if (text.length > 0 && text.length < 500) {
                    return text;
                }
            }
        }
        return null;
    }

    async waitForNewDownloadButton() {
        return new Promise((resolve, reject) => {
            const maxWait = 120000;
            const startTime = Date.now();
            
            const check = () => {
                // 1. Проверка на ошибки UI
                const uiError = this.checkForUiErrors();
                if (uiError) {
                    this.log(`UI Error detected: ${uiError}`);
                    return { error: uiError };
                }

                // 2. Поиск кнопки скачивания
                const paths = document.querySelectorAll('path[d^="M12.3984 13.6006H3.59844"]');
                if (paths.length > 0) {
                    const btn = paths[paths.length - 1].closest('div.cursor-pointer');
                    if (btn && !btn.classList.contains('opacity-40')) {
                        return { btn };
                    }
                }
                return null;
            };
            
            const interval = setInterval(() => {
                if (!this.isRunning) {
                    clearInterval(interval);
                    reject(new Error('Stopped'));
                    return;
                }

                const result = check();
                
                if (result) {
                    if (result.error) {
                        clearInterval(interval);
                        reject(new Error(`UI Error: ${result.error}`));
                        return;
                    }
                    if (result.btn) {
                        clearInterval(interval);
                        resolve(result.btn);
                        return;
                    }
                }

                if (Date.now() - startTime > maxWait) {
                    clearInterval(interval);
                    reject(new Error('Timeout waiting for download button'));
                }
            }, 1000);
        });
    }

    async getCapturedAudioData(timeout = 10000) {
        const result = await this.callBridge('consumeCapturedAudio', timeout);
        if (!result || !result.ok) {
            throw new Error(result && result.reason ? result.reason : 'Audio capture failed');
        }
        if (result.src) {
            this.log(`Audio source candidate found: ${String(result.src).slice(0, 120)}`);
        }
        if (typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:audio/')) {
            return result;
        }
        throw new Error('Audio blob conversion failed');
    }

    async findGenerateButton() {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(btn => {
            const text = btn.textContent.toLowerCase();
            return (text.includes('generate') || text.includes('create') || text.includes('regenerate')) && !btn.closest('.nav-list'); 
        });
    }

    async waitForButtonState(states) {
        let attempts = 0;
        while(attempts < 200) {
            const btn = await this.findGenerateButton();
            if (btn && states.some(s => btn.textContent.trim().toLowerCase().includes(s))) return btn;
            await this.sleep(300);
            attempts++;
        }
        return null;
    }

    async waitForElement(sel, timeout=5000) {
        const start = Date.now();
        while(Date.now() - start < timeout) {
            const el = document.querySelector(sel);
            if(el) return el;
            await this.sleep(100);
        }
        return null;
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    notifyProgress() {
        chrome.runtime.sendMessage({ action: 'automationProgress', currentIndex: this.currentIndex, queue: this.queue }).catch(()=>{});
        chrome.runtime.sendMessage({
            action: 'updateAutomationProgress',
            progress: {
                currentIndex: this.currentIndex,
                total: this.queue.length,
                isRunning: this.isRunning,
                isPaused: this.isPaused,
                completedIds: this.queue
                    .slice(0, this.currentIndex)
                    .filter(e => e.status === 'completed')
                    .map(e => e.id)
            }
        }).catch(()=>{});
    }
    notifyComplete() {
        chrome.runtime.sendMessage({ action: 'automationComplete', completed: this.currentIndex }).catch(()=>{});
        chrome.runtime.sendMessage({
            action: 'updateAutomationProgress',
            progress: { isRunning: false, isPaused: false, currentIndex: this.currentIndex, total: this.queue.length }
        }).catch(()=>{});
    }
    notifyPause() { chrome.runtime.sendMessage({ action: 'automationPaused' }).catch(()=>{}); this.updateState(); }
    notifyResume() { chrome.runtime.sendMessage({ action: 'automationResumed' }).catch(()=>{}); this.updateState(); }
    notifyStop() { chrome.runtime.sendMessage({ action: 'automationStopped' }).catch(()=>{}); chrome.runtime.sendMessage({ action: 'clearAutomationState' }).catch(()=>{}); }
    notifyError(msg) { chrome.runtime.sendMessage({ action: 'automationError', error: msg }).catch(()=>{}); }

    updateState() {
        chrome.runtime.sendMessage({
            action: 'updateAutomationProgress',
            progress: {
                currentIndex: this.currentIndex,
                total: this.queue.length,
                isRunning: this.isRunning,
                isPaused: this.isPaused
            }
        }).catch(()=>{});
    }
}
