const CDP_BASE_URL = 'http://127.0.0.1:9223';
const fs = require('node:fs');

async function getTargets() {
  return fetch(`${CDP_BASE_URL}/json/list`).then((response) => response.json());
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  return new Promise((resolve, reject) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();

      if (message.error) {
        reject(new Error(message.error.message));
        return;
      }

      if (message.result?.exceptionDetails) {
        const details = message.result.exceptionDetails;
        reject(new Error(details.exception?.description || details.text));
        return;
      }

      resolve(message.result?.result?.value);
    };

    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
  });
}

async function setFileInputFiles(target, expression, filePath) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return new Promise((resolve, reject) => {
    let objectId = '';
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) {
        objectId = message.result?.result?.objectId || '';
        if (!objectId) {
          socket.close();
          reject(new Error('Video file input not found'));
          return;
        }
        socket.send(JSON.stringify({
          id: 2,
          method: 'DOM.setFileInputFiles',
          params: { objectId, files: [filePath] },
        }));
        return;
      }
      if (message.id !== 2) return;
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(true);
    };
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: false },
    }));
  });
}

function summarizeJson(value, path = '', summary = { keys: [], flags: {} }) {
  if (Array.isArray(value)) {
    value.slice(0, 1).forEach((item) => summarizeJson(item, `${path}[]`, summary));
    return summary;
  }
  if (!value || typeof value !== 'object') return summary;

  Object.entries(value).forEach(([key, item]) => {
    const itemPath = path ? `${path}.${key}` : key;
    summary.keys.push(itemPath);
    if (/water.?mark|entitlement|subscription|premium|vip|plan/i.test(key)) {
      summary.flags[itemPath] = typeof item === 'string' ? `<string:${item.length}>` : item;
    }
    summarizeJson(item, itemPath, summary);
  });
  return summary;
}

function summarizeJsonText(text) {
  try {
    const value = JSON.parse(text);
    const summary = summarizeJson(value);
    if (Array.isArray(value?.data)) {
      summary.dataCount = value.data.length;
      summary.firstDataKeys = value.data[0] && typeof value.data[0] === 'object'
        ? Object.keys(value.data[0])
        : [];
    }
    if (typeof value?.status_code === 'string' || typeof value?.status_msg === 'string') {
      summary.status = {
        code: value.status_code || '',
        message: value.status_msg || '',
      };
    }
    return summary;
  } catch (_) {
    return { keys: [], flags: {}, nonJson: true };
  }
}

async function captureDownloadApi(target, durationMs, onReady = null) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  const records = [];
  const requestIds = new Set();
  const bodyRequestIds = new Map();
  let commandId = 1;
  const send = (method, params = {}) => {
    const id = commandId++;
    socket.send(JSON.stringify({ id, method, params }));
    return id;
  };
  const getTargetRequest = (url) => {
    const rawUrl = String(url || '');
    if (rawUrl.includes('/dw-server/work/get_batch_download_url')) {
      return { kind: 'batch-download-api', path: '/dw-server/work/get_batch_download_url', queryKeys: [] };
    }
    try {
      const parsed = new URL(rawUrl);
      if (/^dreamface-resource\.oss-[^.]+\.aliyuncs\.com$/i.test(parsed.hostname)) {
        return {
          kind: 'signed-media-url',
          path: parsed.pathname,
          queryKeys: [...parsed.searchParams.keys()].sort(),
        };
      }
    } catch (_) {}
    return null;
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const targetRequest = getTargetRequest(message.params?.request?.url);
    if (message.method === 'Network.requestWillBeSent' && targetRequest) {
      const request = message.params.request;
      requestIds.add(message.params.requestId);
      records.push({
        requestId: message.params.requestId,
        ...targetRequest,
        method: request.method,
        request: summarizeJsonText(request.postData || ''),
        response: null,
      });
      return;
    }
    if (message.method === 'Network.responseReceived' && requestIds.has(message.params?.requestId)) {
      const record = records.find((item) => item.requestId === message.params.requestId);
      if (record?.kind !== 'batch-download-api') return;
      const bodyCommandId = send('Network.getResponseBody', { requestId: message.params.requestId });
      bodyRequestIds.set(bodyCommandId, message.params.requestId);
      return;
    }
    if (bodyRequestIds.has(message.id) && message.result?.body !== undefined) {
      const record = records.find((item) => item.requestId === bodyRequestIds.get(message.id));
      if (record) record.response = summarizeJsonText(message.result.body);
    }
  };

  send('Network.enable');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (onReady) await onReady();
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  socket.close();
  return records.map(({ requestId, ...record }) => record);
}

async function captureAvatarSubmit(target, onReady) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  const records = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method !== 'Network.requestWillBeSent') return;
    const request = message.params?.request;
    if (!String(request?.url || '').includes('/dw-server/task/v2/submit')) return;
    records.push({ method: request.method, payload: summarizeJsonText(request.postData || '') });
  };

  socket.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await onReady();
  await new Promise((resolve) => setTimeout(resolve, 15000));
  socket.close();
  return records;
}

async function main() {
const targets = await getTargets();
const page = targets.find((target) => target.type === 'page' && /dreamfaceapp\.com/.test(target.url));
const popup = targets.find((target) => target.type === 'page' && target.url.includes('/popup.html'));
const serviceWorker = targets.find((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'));
const offscreen = targets.find((target) => target.type === 'background_page' && target.url.includes('offscreen.html'));
const extensionsPage = targets.find((target) => target.type === 'page' && target.url.startsWith('chrome://extensions'));
const extensionId = serviceWorker ? new URL(serviceWorker.url).host : '';

if (process.argv.includes('--capture-download-api')) {
  if (!page) throw new Error('DreamFace page not found');
  const optionIndex = process.argv.indexOf('--capture-download-api');
  const durationSeconds = Math.max(1, Number(process.argv[optionIndex + 1]) || 60);
  const records = await captureDownloadApi(page, durationSeconds * 1000);
  console.log(JSON.stringify({ records }, null, 2));
  process.exit(records.length > 0 ? 0 : 1);
}

if (process.argv.includes('--capture-extension-download-api')) {
  if (!page || !popup) throw new Error('DreamFace page and extension popup are required');
  const records = await captureDownloadApi(page, 30000, async () => {
    const clickResult = await evaluate(popup, `(() => {
      if (creationsBtn.disabled) return 'disabled';
      creationsBtn.click();
      return 'clicked';
    })()`);
    if (clickResult !== 'clicked') {
      throw new Error(`Extension download button was not clicked: ${clickResult}`);
    }
  });
  console.log(JSON.stringify({ records }, null, 2));
  process.exit(records.length > 0 ? 0 : 1);
}

if (process.argv.includes('--capture-download-url')) {
  if (!page || !popup) throw new Error('DreamFace page and extension popup are required');
  const optionIndex = process.argv.indexOf('--capture-download-url');
  const workId = String(process.argv[optionIndex + 1] || '').trim();
  if (!workId) throw new Error('Usage: --capture-download-url <workId>');
  let response = null;
  const records = await captureDownloadApi(page, 30000, async () => {
    response = await evaluate(popup, `(async () => {
      const tabs = await chrome.tabs.query({ url: ['https://dreamfaceapp.com/*', 'https://www.dreamfaceapp.com/*'] });
      const tab = tabs.find((item) => item.url?.includes('/creation'));
      if (!tab?.id) return { ok: false, error: 'DreamFace creations tab not found' };
      return chrome.tabs.sendMessage(tab.id, { action: 'getDownloadUrlByWorkId', workId: ${JSON.stringify(workId)} });
    })()`);
  });
  console.log(JSON.stringify({ response, records }, null, 2));
  process.exit(response?.ok ? 0 : 1);
}

if (process.argv.includes('--creation-controls')) {
  if (!page) throw new Error('DreamFace page not found');
  const controls = await evaluate(page, `JSON.stringify(
    Array.from(document.querySelectorAll('button, [role="button"]')).map((element) => ({
      text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim(),
      ariaLabel: element.getAttribute('aria-label') || '',
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    })).filter((item) => item.text || item.ariaLabel).slice(0, 150)
  )`);
  console.log(controls);
  process.exit(0);
}

if (process.argv.includes('--creation-page-text')) {
  if (!page) throw new Error('DreamFace page not found');
  const text = await evaluate(page, `document.body.innerText.slice(0, 12000)`);
  console.log(text);
  process.exit(0);
}

if (process.argv.includes('--capture-native-download-api')) {
  if (!page) throw new Error('DreamFace page not found');
  const optionIndex = process.argv.indexOf('--capture-native-download-api');
  const fileName = String(process.argv[optionIndex + 1] || '').trim();
  if (!fileName) throw new Error('Usage: --capture-native-download-api <fileName>');
  let action = null;
  const records = await captureDownloadApi(page, 30000, async () => {
    action = await evaluate(page, `(async () => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const findControl = (labels) => Array.from(document.querySelectorAll('button, div[class*="_select_btn_"], div[class*="_select_content_"]'))
        .find((element) => labels.includes(normalize(element.textContent)));
      const select = findControl(['выбрать', 'select']);
      if (!select) return { ok: false, error: 'select button not found' };
      select.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const list = document.querySelector('div[class*="_creationList_"]');
      const card = Array.from(list?.children || []).find((element) => element.textContent.includes(${JSON.stringify(fileName)}));
      if (!card) return { ok: false, error: 'creation card not found' };
      card.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const download = findControl(['скачать', 'download']);
      if (!download) return { ok: false, error: 'download button not found' };
      download.click();
      return { ok: true };
    })()`);
  });
  console.log(JSON.stringify({ action, records }, null, 2));
  process.exit(action?.ok ? 0 : 1);
}

if (process.argv.includes('--extensions')) {
  if (!extensionsPage) throw new Error('chrome://extensions target not found');
  const result = await evaluate(extensionsPage, `(() => {
    const manager = document.querySelector('extensions-manager');
    const list = manager?.shadowRoot?.querySelector('extensions-item-list');
    const items = list?.shadowRoot?.querySelectorAll('extensions-item') || [];
    return [...items].map((item) => item.data || {
      id: item.id,
      name: item.shadowRoot?.querySelector('#name')?.textContent || ''
    });
  })()`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (process.argv.includes('--extension-status')) {
  if (!extensionsPage) throw new Error('chrome://extensions target not found');
  const result = await evaluate(extensionsPage, `(() => {
    const manager = document.querySelector('extensions-manager');
    const list = manager?.shadowRoot?.querySelector('extensions-item-list');
    const item = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])]
       .find((entry) => entry.data?.id === ${JSON.stringify(extensionId)});
    const data = item?.data;
    return data ? {
      id: data.id,
      path: data.path,
      version: data.version,
      state: data.state,
      manifestErrors: data.manifestErrors,
      runtimeErrors: data.runtimeErrors,
      runtimeWarnings: data.runtimeWarnings,
      views: data.views?.map((view) => ({ type: view.type, url: view.url }))
    } : null;
  })()`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (process.argv.includes('--run-state')) {
  if (!popup) throw new Error('Popup context not found');
  const response = await evaluate(popup, `(async () => chrome.runtime.sendMessage({ action: 'engine.getRunState' }))()`);
  console.log(JSON.stringify(response, null, 2));
  process.exit(response?.ok ? 0 : 1);
}

if (process.argv.includes('--reset-run')) {
  if (!popup) throw new Error('Popup context not found');
  const response = await evaluate(popup, `(async () => chrome.runtime.sendMessage({ action: 'engine.resetRunState' }))()`);
  console.log(JSON.stringify(response, null, 2));
  process.exit(response?.ok ? 0 : 1);
}

if (process.argv.includes('--stop-run')) {
  if (!popup) throw new Error('Popup context not found');
  const response = await evaluate(popup, `(async () => chrome.runtime.sendMessage({ action: 'engine.stopRun' }))()`);
  console.log(JSON.stringify(response, null, 2));
  process.exit(response?.ok ? 0 : 1);
}

if (process.argv.includes('--set-state-marker')) {
  if (!popup) throw new Error('Popup context not found');
  const response = await evaluate(popup, `(async () => {
    const current = (await chrome.runtime.sendMessage({ action: 'engine.getRunState' }))?.state || {};
    const state = {
      ...current,
      phase: 'finished',
      runId: 'lifecycle-smoke-marker',
      statusText: 'lifecycle smoke marker',
      finishedAt: new Date().toISOString()
    };
    return chrome.runtime.sendMessage({ action: 'engine.persistRunState', state });
  })()`);
  console.log(JSON.stringify(response, null, 2));
  process.exit(response?.ok ? 0 : 1);
}

if (process.argv.includes('--set-download-plan')) {
  if (!popup) throw new Error('Popup context not found');
  const optionIndex = process.argv.indexOf('--set-download-plan');
  const workId = process.argv[optionIndex + 1];
  const fileName = process.argv[optionIndex + 2];
  const startedAt = process.argv[optionIndex + 3] || '2026-07-23T11:40:00.000Z';
  if (!workId || !fileName) throw new Error('Usage: --set-download-plan <workId> <fileName>');
  const response = await evaluate(popup, `(async () => {
    const current = (await chrome.runtime.sendMessage({ action: 'engine.getRunState' }))?.state || {};
    const task = {
      id: 'download-smoke-task',
      fileName: ${JSON.stringify(fileName)},
      workId: ${JSON.stringify(workId)},
      submissionStatus: 'submitted'
    };
    const state = {
      ...current,
      phase: 'finished',
      runId: 'download-smoke-' + Date.now(),
      startedAt: ${JSON.stringify(startedAt)},
      finishedAt: new Date().toISOString(),
      total: 1,
      current: 1,
      nextTaskIndex: 1,
      queuePlan: [task],
      downloadPlan: {
        expectedFileNames: [task.fileName],
        expectedWorkIds: [task.workId],
        lastStatus: 'ready',
        lastMessage: '',
        pendingFiles: [],
        downloadedCount: 0,
        matchedCount: 0,
        totalExpected: 1,
        checkedAt: '',
        checkedOnUrl: ''
      },
      statusText: 'download smoke ready'
    };
    return chrome.runtime.sendMessage({ action: 'engine.persistRunState', state });
  })()`);
  console.log(JSON.stringify(response, null, 2));
  process.exit(response?.ok ? 0 : 1);
}

if (process.argv.includes('--clear-face-memory')) {
  if (!popup) throw new Error('Popup context not found');
  await evaluate(popup, `(async () => chrome.storage.local.remove('dreamfaceMultiFaceMemory'))()`);
  console.log(JSON.stringify({ cleared: true }));
  process.exit(0);
}

if (process.argv.includes('--probe-video-index')) {
  if (!popup) throw new Error('Popup context not found');
  const optionIndex = process.argv.indexOf('--probe-video-index');
  const videoIndex = Number(process.argv[optionIndex + 1]);
  const response = await evaluate(popup, `(async () => {
    const tabs = await chrome.tabs.query({ url: ['https://dreamfaceapp.com/*', 'https://www.dreamfaceapp.com/*'] });
    const tab = tabs.find((item) => item.url?.includes('/avatar'));
    return tab?.id ? chrome.tabs.sendMessage(tab.id, { action: 'getVideoSourceUrlByIndex', videoIndex: ${videoIndex} }) : null;
  })()`);
  console.log(JSON.stringify(response ? {
    ok: response.ok,
    durationMs: response.durationMs,
    fingerprint: response.fingerprint,
    error: response.error
  } : null, null, 2));
  process.exit(response?.ok ? 0 : 1);
}

if (process.argv.includes('--ui-reload')) {
  if (!extensionsPage) throw new Error('chrome://extensions target not found');
  const clicked = await evaluate(extensionsPage, `(() => {
    const manager = document.querySelector('extensions-manager');
    const list = manager?.shadowRoot?.querySelector('extensions-item-list');
    const item = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])]
       .find((entry) => entry.data?.id === ${JSON.stringify(extensionId)});
    const button = item?.shadowRoot?.querySelector('#dev-reload-button');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  console.log(JSON.stringify({ clicked }));
  process.exit(clicked ? 0 : 1);
}

if (process.argv.includes('--reopen')) {
  const extensionTargets = targets.filter((target) => (
    target.url.includes('/popup.html') || target.url.includes('/offscreen.html')
  ));
  for (const target of extensionTargets) {
    await fetch(`${CDP_BASE_URL}/json/close/${target.id}`).catch(() => {});
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
   const popupUrl = encodeURIComponent('chrome-extension://${extensionId}/popup.html');
  await fetch(`${CDP_BASE_URL}/json/new?${popupUrl}`, { method: 'PUT' });
  const dreamFacePages = targets.filter((target) => target.type === 'page' && /dreamfaceapp\.com/.test(target.url));
  for (const dreamFacePage of dreamFacePages) {
    await evaluate(dreamFacePage, `location.reload(); true`).catch(() => {});
  }
  console.log(JSON.stringify({ reopened: true, pagesReloaded: dreamFacePages.length }));
  process.exit(0);
}

if (process.argv.includes('--reload-avatar')) {
  const currentTargets = await getTargets();
  const avatarPage = currentTargets.find((target) => target.type === 'page' && target.url.includes('/avatar'));
  if (!avatarPage) throw new Error('DreamFace avatar page not found');
  await evaluate(avatarPage, `location.reload(); true`).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log(JSON.stringify({ reloaded: true }));
  process.exit(0);
}

if (process.argv.includes('--confirm-first-face')) {
  const currentTargets = await getTargets();
  const avatarPage = currentTargets.find((target) => target.type === 'page' && target.url.includes('/avatar'));
  if (!avatarPage) throw new Error('DreamFace avatar page not found');
  const result = await evaluate(avatarPage, `(() => {
    const modal = [...document.querySelectorAll('[class*="_modal_"]')]
      .find((node) => node.querySelector('button[class*="_faceBox_"]'));
    if (!modal) return { ok: false, error: 'face modal not found' };
    const faces = [...modal.querySelectorAll('button[class*="_faceBox_"]')];
    faces.forEach((face, index) => {
      const selected = face.getAttribute('aria-pressed') === 'true';
      if ((index === 0) !== selected) face.click();
    });
    const confirm = modal.querySelector('button[class*="_confirmButton_"]');
    if (!confirm) return { ok: false, error: 'confirm button not found', faces: faces.length };
    confirm.click();
    return { ok: true, faces: faces.length, selected: 1 };
  })()`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result?.ok ? 0 : 1);
}

if (process.argv.includes('--reload')) {
  if (!offscreen) throw new Error('Offscreen extension context not found');
  await evaluate(offscreen, `chrome.runtime.reload(); true`).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const refreshedTargets = await getTargets();
  const staleExtensionTargets = refreshedTargets.filter((target) => (
    target.url.includes('/popup.html') || target.url.includes('/offscreen.html')
  ));
  for (const target of staleExtensionTargets) {
    await fetch(`${CDP_BASE_URL}/json/close/${target.id}`).catch(() => {});
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
   const popupUrl = encodeURIComponent('chrome-extension://${extensionId}/popup.html');
  await fetch(`${CDP_BASE_URL}/json/new?${popupUrl}`, { method: 'PUT' });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const refreshedPages = refreshedTargets.filter((target) => target.type === 'page' && /dreamfaceapp\.com/.test(target.url));
  for (const refreshedPage of refreshedPages) {
    await evaluate(refreshedPage, `location.reload(); true`).catch(() => {});
  }
  console.log(JSON.stringify({ reloaded: true, pagesReloaded: refreshedPages.length }));
  process.exit(0);
}

if (process.argv.includes('--smoke')) {
  if (!popup || !offscreen) throw new Error('Required extension contexts not found');
  const invalidUrlResult = await evaluate(popup, `(async () => {
    return chrome.runtime.sendMessage({
      action: 'dm.enqueue',
      payload: { items: [{ workId: 'smoke-invalid-url', url: 'https://example.com/video.mp4' }] }
    });
  })()`);
  await evaluate(popup, `(async () => {
    return chrome.runtime.sendMessage({
      action: 'dm.removeEntry',
      payload: { workId: 'smoke-invalid-url' }
    });
  })()`);
  const transferId = await evaluate(offscreen, `createPreLoopTransfer(new Uint8Array([0, 1, 2, 127, 128, 255]))`);
  const chunkResult = await evaluate(popup, `(async () => {
    return chrome.runtime.sendMessage({
      action: 'engine.getPreLoopChunk',
      payload: { transferId: '${transferId}', offset: 0, chunkSize: 1024 }
    });
  })()`);
  await evaluate(popup, `(async () => {
    return chrome.runtime.sendMessage({
      action: 'engine.releasePreLoopTransfer',
      payload: { transferId: '${transferId}' }
    });
  })()`);
  console.log(JSON.stringify({ invalidUrlResult, chunkResult }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--preloop-local')) {
  if (!popup || !offscreen || !page) throw new Error('Required contexts not found');
  await fetch(`${CDP_BASE_URL}/json/activate/${page.id}`);
  const source = await evaluate(popup, `(async () => {
    const tabs = await chrome.tabs.query({ url: ['https://dreamfaceapp.com/*', 'https://www.dreamfaceapp.com/*'] });
    const tab = tabs.find((item) => item.url?.includes('/avatar'));
    if (!tab?.id) throw new Error('DreamFace avatar tab not found');
    return chrome.tabs.sendMessage(tab.id, { action: 'getVideoSourceUrlByIndex', videoIndex: 0 });
  })()`);
  if (!source?.ok || !source.url || !source.durationMs) {
    throw new Error(source?.error || 'Video source or duration unavailable');
  }
  const result = await evaluate(offscreen, `(async () => handlePreLoopVideo({
    sourceUrl: ${JSON.stringify(source.url)},
    sourceMs: ${Number(source.durationMs)},
    targetMs: ${Number(source.durationMs) * 2}
  }))()`);
  let chunkResult = null;
  if (result?.ok && result.transferId) {
    chunkResult = await evaluate(popup, `(async () => chrome.runtime.sendMessage({
      action: 'engine.getPreLoopChunk',
      payload: { transferId: '${result.transferId}', offset: 0, chunkSize: 1024 }
    }))()`);
    await evaluate(popup, `(async () => chrome.runtime.sendMessage({
      action: 'engine.releasePreLoopTransfer',
      payload: { transferId: '${result.transferId}' }
    }))()`);
  }
  console.log(JSON.stringify({
    sourceMs: source.durationMs,
    result: result ? {
      ok: result.ok,
      bytes: result.bytes,
      repeats: result.repeats,
      mode: result.mode,
      finalMs: result.finalMs,
      error: result.error
    } : null,
    chunk: chunkResult ? {
      ok: chunkResult.ok,
      bytes: chunkResult.base64 ? Buffer.from(chunkResult.base64, 'base64').length : 0,
      totalBytes: chunkResult.totalBytes
    } : null
  }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--preloop-file')) {
  if (!offscreen) throw new Error('Offscreen context not found');
  const optionIndex = process.argv.indexOf('--preloop-file');
  const filePath = process.argv[optionIndex + 1];
  const sourceMs = Number(process.argv[optionIndex + 2]);
  const targetMs = Number(process.argv[optionIndex + 3]);
  const outputPath = process.argv[optionIndex + 4] || '';
  if (!filePath || !Number.isFinite(sourceMs) || !Number.isFinite(targetMs)) {
    throw new Error('Usage: --preloop-file <path> <sourceMs> <targetMs>');
  }
  const bytes = fs.readFileSync(filePath);
  await evaluate(offscreen, `globalThis.__preloopFixtureChunks = []; true`);
  const chunkSize = 512 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const base64 = bytes.subarray(offset, offset + chunkSize).toString('base64');
    await evaluate(offscreen, `globalThis.__preloopFixtureChunks.push(${JSON.stringify(base64)}); true`);
  }
  const result = await evaluate(offscreen, `(async () => {
    const chunks = globalThis.__preloopFixtureChunks.map((base64) => {
      const binary = atob(base64);
      const chunk = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) chunk[index] = binary.charCodeAt(index);
      return chunk;
    });
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const input = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
    delete globalThis.__preloopFixtureChunks;
    const output = await withFfmpegMutex(() => preLoopVideoMp4(input, ${targetMs}, ${sourceMs}));
    const transferId = ${Boolean(outputPath)} ? createPreLoopTransfer(output.bytes) : '';
    return { bytes: output.bytes.byteLength, repeats: output.repeats, mode: output.mode, finalMs: output.finalMs, transferId };
  })()`);
  if (outputPath && result.transferId) {
    const chunks = [];
    let offset = 0;
    while (true) {
      const chunk = await evaluate(popup, `(async () => chrome.runtime.sendMessage({
        action: 'engine.getPreLoopChunk',
        payload: { transferId: ${JSON.stringify(result.transferId)}, offset: ${offset}, chunkSize: 1024 * 1024 }
      }))()`);
      if (!chunk?.ok || !chunk.base64) throw new Error(chunk?.error || 'Failed to retrieve output chunk');
      chunks.push(Buffer.from(chunk.base64, 'base64'));
      if (chunk.done) break;
      offset = chunk.nextOffset;
    }
    fs.writeFileSync(outputPath, Buffer.concat(chunks));
    await evaluate(popup, `(async () => chrome.runtime.sendMessage({
      action: 'engine.releasePreLoopTransfer',
      payload: { transferId: ${JSON.stringify(result.transferId)} }
    }))()`);
  }
  console.log(JSON.stringify({ ...result, transferId: undefined, outputPath: outputPath || undefined }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--upload-video-file')) {
  if (!popup) throw new Error('Popup context not found');
  const optionIndex = process.argv.indexOf('--upload-video-file');
  const filePath = process.argv[optionIndex + 1];
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Video file not found');
  const currentTargets = await getTargets();
  const avatarPage = currentTargets.find((target) => target.type === 'page' && target.url.includes('/avatar'));
  if (!avatarPage) throw new Error('DreamFace avatar page not found');
  await setFileInputFiles(
    avatarPage,
    `document.querySelector('div[class*="_uploadCard_"] input[type="file"]')`,
    filePath
  );
  const deadline = Date.now() + 6 * 60 * 1000;
  let result = null;
  while (Date.now() < deadline) {
    result = await evaluate(popup, `(async () => {
      const tabs = await chrome.tabs.query({ url: ['https://dreamfaceapp.com/*', 'https://www.dreamfaceapp.com/*'] });
      const tab = tabs.find((item) => item.url?.includes('/avatar'));
      return tab?.id ? chrome.tabs.sendMessage(tab.id, { action: 'getLastAvatarAddDetail' }) : null;
    })()`);
    if (result?.detail) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result?.detail ? 0 : 1);
}

if (process.argv.includes('--run-popup-fixture')) {
  if (!popup) throw new Error('Popup context not found');
  const optionIndex = process.argv.indexOf('--run-popup-fixture');
  const audioPath = process.argv[optionIndex + 1];
  const selectionIndex = Number(process.argv[optionIndex + 2] || 1);
  if (!audioPath || !fs.existsSync(audioPath)) throw new Error('Audio file not found');
  const currentTargets = await getTargets();
  const avatarPage = currentTargets.find((target) => target.type === 'page' && target.url.includes('/avatar'));
  if (!avatarPage) throw new Error('DreamFace avatar page not found');
  await fetch(`${CDP_BASE_URL}/json/activate/${avatarPage.id}`);
  await evaluate(popup, `(() => {
    preLoopToggle.checked = true;
    preLoopToggle.dispatchEvent(new Event('change', { bubbles: true }));
    scanBtn.click();
    return true;
  })()`);
  const scanDeadline = Date.now() + 90 * 1000;
  let videoCount = 0;
  while (Date.now() < scanDeadline) {
    videoCount = await evaluate(popup, `foundVideos.length`);
    if (videoCount > selectionIndex) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (videoCount <= selectionIndex) throw new Error('Video scan did not find requested index');
  await evaluate(popup, `document.querySelector('.video-item[data-index="${selectionIndex}"]')?.click(); true`);
  await setFileInputFiles(
    popup,
    `document.querySelector('.file-input-container input[type="file"]')`,
    audioPath
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const startQueue = () => evaluate(popup, `(() => {
    if (startBtn.disabled) return false;
    startBtn.click();
    return true;
  })()`);
  let startResult = false;
  const records = process.argv.includes('--capture-avatar-submit')
    ? await captureAvatarSubmit(avatarPage, async () => {
        startResult = await startQueue();
      })
    : [];
  const started = process.argv.includes('--capture-avatar-submit') ? startResult : await startQueue();
  if (!started) throw new Error('Popup start button is disabled');
  console.log(JSON.stringify({ started: true, selectionIndex, audioPath, records }, null, 2));
  process.exit(0);
}

if (process.argv.includes('--popup-download-all')) {
  if (!popup) throw new Error('Popup context not found');
  const clickResult = await evaluate(popup, `(() => {
    if (creationsBtn.disabled) return 'disabled';
    creationsBtn.click();
    return 'clicked';
  })()`);
  if (clickResult !== 'clicked') throw new Error(`Download button was not clicked: ${clickResult}`);

  const deadline = Date.now() + 10 * 60 * 1000;
  let state = null;
  while (Date.now() < deadline) {
    state = await evaluate(popup, `(async () => (await chrome.runtime.sendMessage({ action: 'engine.getRunState' }))?.state)()`);
    const status = state?.downloadPlan?.lastStatus || 'idle';
    if (['success', 'error', 'pending'].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const downloads = await evaluate(popup, `(async () => chrome.runtime.sendMessage({ action: 'dm.getState' }))()`);
  console.log(JSON.stringify({
    downloadPlan: state?.downloadPlan || null,
    entries: downloads?.entries?.map((entry) => ({
      workId: entry.workId,
      status: entry.status,
      savedAs: entry.savedAs,
      error: entry.error,
      downloadId: entry.downloadId
    })) || []
  }, null, 2));
  process.exit(state?.downloadPlan?.lastStatus === 'success' ? 0 : 1);
}

if (process.argv.includes('--preloop-upload')) {
  if (!popup || !offscreen) throw new Error('Required contexts not found');
  const source = await evaluate(popup, `(async () => {
    const tabs = await chrome.tabs.query({ url: ['https://dreamfaceapp.com/*', 'https://www.dreamfaceapp.com/*'] });
    const tab = tabs.find((item) => item.url?.includes('/avatar'));
    if (!tab?.id) throw new Error('DreamFace avatar tab not found');
    const video = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoSourceUrlByIndex', videoIndex: 0 });
    return { tabId: tab.id, ...video };
  })()`);
  if (!source?.ok || !source.url || !source.durationMs) {
    throw new Error(source?.error || 'Video source or duration unavailable');
  }

  const result = await evaluate(offscreen, `(async () => handlePreLoopVideo({
    sourceUrl: ${JSON.stringify(source.url)},
    sourceMs: ${Number(source.durationMs)},
    targetMs: ${Number(source.durationMs) * 2}
  }))()`);
  if (!result?.ok || !result.transferId) {
    throw new Error(result?.error || 'Pre-loop processing failed');
  }

  const fileName = `preloop-smoke-${Date.now()}.mp4`;
  const upload = await evaluate(popup, `(async () => chrome.tabs.sendMessage(
    ${Number(source.tabId)},
    {
      action: 'uploadPreloopedVideo',
      transferId: ${JSON.stringify(result.transferId)},
      fileName: ${JSON.stringify(fileName)}
    }
  ))()`);
  const sourceAfter = await evaluate(popup, `(async () => chrome.tabs.sendMessage(
    ${Number(source.tabId)},
    { action: 'getVideoSourceUrlByIndex', videoIndex: 0 }
  ))()`);

  console.log(JSON.stringify({
    fileName,
    sourceMs: source.durationMs,
    processing: {
      bytes: result.bytes,
      repeats: result.repeats,
      mode: result.mode,
      finalMs: result.finalMs
    },
    upload,
    sourceChanged: Boolean(sourceAfter?.ok && sourceAfter.url && sourceAfter.url !== source.url),
    uploadedDurationMs: sourceAfter?.durationMs || 0
  }, null, 2));
  process.exit(upload?.ok ? 0 : 1);
}

if (process.argv.includes('--cleanup-marker-test')) {
  if (!popup) throw new Error('Popup context not found');
  const result = await evaluate(popup, `(async () => {
    const state = await chrome.runtime.sendMessage({ action: 'dm.getState' });
    const entries = (state?.entries || []).filter((entry) => (
      entry.audioFileName === 'dreamface-marker-smoke'
      || entry.savedAs === 'dreamface-marker-smoke.mp4'
    ));
    const removed = [];
    for (const entry of entries) {
      const response = await chrome.runtime.sendMessage({
        action: 'dm.removeEntry',
        payload: { workId: entry.workId }
      });
      if (response?.ok) removed.push(entry.workId);
    }
    return { found: entries.length, removed };
  })()`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result?.found === result?.removed?.length ? 0 : 1);
}

if (process.argv.includes('--remove-download-entry')) {
  if (!popup) throw new Error('Popup context not found');
  const optionIndex = process.argv.indexOf('--remove-download-entry');
  const workId = process.argv[optionIndex + 1];
  if (!workId) throw new Error('Usage: --remove-download-entry <workId>');
  const result = await evaluate(popup, `(async () => chrome.runtime.sendMessage({
    action: 'dm.removeEntry',
    payload: { workId: ${JSON.stringify(workId)} }
  }))()`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result?.ok ? 0 : 1);
}

if (process.argv.includes('--signed-url-retry-test')) {
  if (!popup) throw new Error('Popup context not found');
  const optionIndex = process.argv.indexOf('--signed-url-retry-test');
  const workId = process.argv[optionIndex + 1];
  if (!workId) throw new Error('Usage: --signed-url-retry-test <workId>');
  const setup = await evaluate(popup, `(async () => {
    const tabResponse = await chrome.runtime.sendMessage({ action: 'engine.ensureCreationsTab' });
    if (!tabResponse?.ok || !tabResponse.tab?.id) throw new Error(tabResponse?.error || 'Creations tab unavailable');
    const fresh = await chrome.tabs.sendMessage(tabResponse.tab.id, {
      action: 'getDownloadUrlByWorkId',
      workId: ${JSON.stringify(workId)}
    });
    if (!fresh?.ok || !fresh.url) throw new Error(fresh?.error || 'Fresh URL unavailable');
    const badUrl = new URL(fresh.url);
    if (badUrl.searchParams.has('Signature')) badUrl.searchParams.set('Signature', 'invalid');
    else if (badUrl.searchParams.has('x-oss-signature')) badUrl.searchParams.set('x-oss-signature', 'invalid');
    else badUrl.searchParams.set('Signature', 'invalid');
    const runState = (await chrome.runtime.sendMessage({ action: 'engine.getRunState' }))?.state;
    await chrome.runtime.sendMessage({ action: 'dm.removeEntry', payload: { workId: ${JSON.stringify(workId)} } });
    return chrome.runtime.sendMessage({
      action: 'dm.enqueue',
      payload: { items: [{
        workId: ${JSON.stringify(workId)},
        runId: runState?.runId || '',
        workName: 'signed-url-refresh-smoke',
        audioFileName: 'signed-url-refresh-smoke',
        url: badUrl.toString(),
        audioMs: 8000,
        videoMs: 4000,
        hasChapters: true
      }] }
    });
  })()`);
  let entry = null;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const state = await evaluate(popup, `(async () => chrome.runtime.sendMessage({ action: 'dm.getState' }))()`);
    entry = state?.entries?.find((candidate) => candidate.workId === workId) || null;
    if (entry && ['done', 'failed', 'interrupted', 'missing'].includes(entry.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log(JSON.stringify({ setup, entry: entry ? {
    status: entry.status,
    attempts: entry.attempts,
    error: entry.error,
    savedAs: entry.savedAs,
    downloadId: entry.downloadId
  } : null }, null, 2));
  process.exit(entry?.status === 'done' && entry?.attempts >= 1 ? 0 : 1);
}

if (process.argv.includes('--marker-download-test')) {
  if (!popup) throw new Error('Popup context not found');
  const creationsUrl = encodeURIComponent('https://www.dreamfaceapp.com/creation?type=Avatar+Video');
  await fetch(`${CDP_BASE_URL}/json/new?${creationsUrl}`, { method: 'PUT' });
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const currentTargets = await getTargets();
  const creationsPage = currentTargets.find((target) => (
    target.type === 'page' && /dreamfaceapp\.com\/(?:[a-z]{2}\/)?creation/.test(target.url)
  ));
  if (!creationsPage) throw new Error('Creations page not found');

  const item = await evaluate(creationsPage, `(async () => {
    function request(eventName, responseName, detail) {
      return new Promise((resolve, reject) => {
        const requestId = 'marker-smoke-' + Date.now() + '-' + Math.random();
        const timeoutId = setTimeout(() => reject(new Error(eventName + ' timeout')), 15000);
        const listener = (event) => {
          if (event.detail?.requestId !== requestId) return;
          clearTimeout(timeoutId);
          window.removeEventListener(responseName, listener);
          if (!event.detail.ok) reject(new Error(event.detail.error || eventName + ' failed'));
          else resolve(event.detail.body);
        };
        window.addEventListener(responseName, listener);
        window.dispatchEvent(new CustomEvent(eventName, { detail: { ...detail, requestId } }));
      });
    }

    const recent = await request(
      'DreamFaceRecentCreationsRequest',
      'DreamFaceRecentCreationsResponse',
      { page: 1, size: 30 }
    );
    const readyItem = (recent?.data?.list || []).find((entry) => Number(entry.web_work_status) === 200 && entry.id);
    if (!readyItem) throw new Error('No ready creation found');
    const urls = await request(
      'DreamFaceBatchDownloadUrlRequest',
      'DreamFaceBatchDownloadUrlResponse',
      { ids: [String(readyItem.id)] }
    );
    const download = (urls?.data || []).find((entry) => String(entry.id) === String(readyItem.id));
    if (!download?.url) throw new Error('Download URL not returned');
    return { id: String(readyItem.id), name: readyItem.work_name || String(readyItem.id), url: download.url };
  })()`);

  const enqueueResult = await evaluate(popup, `(async () => chrome.runtime.sendMessage({
    action: 'dm.enqueue',
    payload: { items: [{
      workId: ${JSON.stringify(item.id)},
      workName: 'dreamface-marker-smoke',
      audioFileName: 'dreamface-marker-smoke',
      url: ${JSON.stringify(item.url)},
      audioMs: 8000,
      videoMs: 4000,
      hasChapters: true
    }] }
  }))()`);

  let entry = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const state = await evaluate(popup, `(async () => chrome.runtime.sendMessage({ action: 'dm.getState' }))()`);
    entry = state?.entries?.find((candidate) => candidate.workId === item.id) || null;
    if (entry && ['done', 'failed', 'interrupted', 'missing'].includes(entry.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(JSON.stringify({
    source: { id: item.id, name: item.name },
    enqueueResult,
    result: entry ? {
      status: entry.status,
      error: entry.error,
      savedAs: entry.savedAs,
      bytes: entry.bytes,
      downloadId: entry.downloadId
    } : null
  }, null, 2));
  process.exit(entry?.status === 'done' ? 0 : 1);
}

if (process.argv.includes('--pagination-test')) {
  if (!popup) throw new Error('Popup context not found');
  let currentTargets = await getTargets();
  let creationsPage = currentTargets.find((target) => (
    target.type === 'page' && /dreamfaceapp\.com\/(?:[a-z]{2}\/)?creation/.test(target.url)
  ));
  if (!creationsPage) {
    const creationsUrl = encodeURIComponent('https://www.dreamfaceapp.com/creation?type=Avatar+Video');
    await fetch(`${CDP_BASE_URL}/json/new?${creationsUrl}`, { method: 'PUT' });
    await new Promise((resolve) => setTimeout(resolve, 10000));
    currentTargets = await getTargets();
    creationsPage = currentTargets.find((target) => (
      target.type === 'page' && /dreamfaceapp\.com\/(?:[a-z]{2}\/)?creation/.test(target.url)
    ));
  }
  if (!creationsPage) throw new Error('Creations page not found');

  const pageFour = await evaluate(creationsPage, `(async () => {
    const body = await new Promise((resolve, reject) => {
      const requestId = 'pagination-smoke-' + Date.now();
      const timeoutId = setTimeout(() => reject(new Error('recent creations timeout')), 15000);
      const listener = (event) => {
        if (event.detail?.requestId !== requestId) return;
        clearTimeout(timeoutId);
        window.removeEventListener('DreamFaceRecentCreationsResponse', listener);
        if (!event.detail.ok) reject(new Error(event.detail.error || 'recent creations failed'));
        else resolve(event.detail.body);
      };
      window.addEventListener('DreamFaceRecentCreationsResponse', listener);
      window.dispatchEvent(new CustomEvent('DreamFaceRecentCreationsRequest', {
        detail: { requestId, page: 4, size: 30 }
      }));
    });
    const list = Array.isArray(body?.data?.list) ? body.data.list : [];
    const item = list.find((entry) => entry?.id && entry?.work_name) || null;
    return { total: Number(body?.data?.count) || 0, pageItems: list.length, item };
  })()`);
  if (!pageFour?.item) throw new Error('Page 4 has no testable creation');

  const status = await evaluate(popup, `(async () => {
    const tabs = await chrome.tabs.query({ url: ['https://dreamfaceapp.com/*', 'https://www.dreamfaceapp.com/*'] });
    const tab = tabs.find((item) => item.url?.includes('/creation') || item.url?.includes('/user'));
    if (!tab?.id) throw new Error('DreamFace creations tab not found');
    return chrome.tabs.sendMessage(tab.id, {
      action: 'checkCreationsStatus',
      expectedFileNames: [${JSON.stringify(pageFour.item.work_name)}],
      expectedWorkIds: [${JSON.stringify(String(pageFour.item.id))}],
      startedAt: 0
    });
  })()`);

  console.log(JSON.stringify({
    total: pageFour.total,
    pageFourItems: pageFour.pageItems,
    target: { id: String(pageFour.item.id), name: pageFour.item.work_name },
    result: {
      status: status?.status,
      source: status?.source,
      matchedCount: status?.matchedCount,
      pending: status?.pending
    }
  }, null, 2));
  process.exit(status?.matchedCount === 1 ? 0 : 1);
}

const report = {
  targets: {
    page: Boolean(page),
    popup: Boolean(popup),
    serviceWorker: Boolean(serviceWorker),
    offscreen: Boolean(offscreen),
  },
};

if (process.argv.includes('--scan') && page && popup) {
  await fetch(`${CDP_BASE_URL}/json/activate/${page.id}`);
  await evaluate(popup, `document.getElementById('scanBtn')?.click(); true`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (popup) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  report.popup = JSON.parse(await evaluate(popup, `JSON.stringify({
    readyState: document.readyState,
    text: document.body.innerText.slice(0, 4000),
    startDisabled: document.getElementById('startBtn')?.disabled ?? null,
    scanDisabled: document.getElementById('scanBtn')?.disabled ?? null
  })`));
}

if (page) {
  report.page = JSON.parse(await evaluate(page, `JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    contentScriptMarker: document.documentElement.dataset.dmHoverInstalled || null
  })`));
}

if (serviceWorker) {
  report.storage = JSON.parse(await evaluate(serviceWorker, `(async () => {
    const data = await chrome.storage.local.get([
      'dreamfaceRunState',
      'dreamfaceDownloads',
      'dreamfaceSettings',
      'dmDebugLog'
    ]);
    const run = data.dreamfaceRunState || null;
    const downloads = data.dreamfaceDownloads?.byWorkId || {};
    return JSON.stringify({
      keysPresent: Object.keys(data),
      run: run ? {
        phase: run.phase,
        runId: run.runId,
        current: run.current,
        total: run.total,
        nextTaskIndex: run.nextTaskIndex,
        queueLength: Array.isArray(run.queuePlan) ? run.queuePlan.length : 0,
        recoverable: run.recoverable,
        interruptionReason: run.interruptionReason
      } : null,
      downloadCount: Object.keys(downloads).length,
      debugLogCount: Array.isArray(data.dmDebugLog) ? data.dmDebugLog.length : 0,
      settingsPresent: Boolean(data.dreamfaceSettings)
    });
  })()`));
}

if (offscreen) {
  report.offscreen = JSON.parse(await evaluate(offscreen, `JSON.stringify({
    phase: runState.phase,
    runId: runState.runId,
    current: runState.current,
    total: runState.total,
    nextTaskIndex: runState.nextTaskIndex,
    queueLength: Array.isArray(runState.queuePlan) ? runState.queuePlan.length : 0
  })`));

  if (!report.storage) {
    report.storage = JSON.parse(await evaluate(offscreen, `(async () => {
      const data = await chrome.storage.local.get([
        'dreamfaceRunState',
        'dreamfaceDownloads',
        'dreamfaceSettings',
        'dmDebugLog'
      ]);
      const run = data.dreamfaceRunState || null;
      const downloads = data.dreamfaceDownloads?.byWorkId || {};
      return JSON.stringify({
        keysPresent: Object.keys(data),
        run: run ? {
          phase: run.phase,
          runId: run.runId,
          current: run.current,
          total: run.total,
          nextTaskIndex: run.nextTaskIndex,
          queueLength: Array.isArray(run.queuePlan) ? run.queuePlan.length : 0,
          recoverable: run.recoverable,
          interruptionReason: run.interruptionReason
        } : null,
        downloadCount: Object.keys(downloads).length,
        debugLogCount: Array.isArray(data.dmDebugLog) ? data.dmDebugLog.length : 0,
        settingsPresent: Boolean(data.dreamfaceSettings)
      });
    })()`));
  }
}

console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
