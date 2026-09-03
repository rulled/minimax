#!/usr/bin/env node
// minimax-ws-capture.js (v2) — in-page WS/fetch hook + CDP metadata puller.
//
// Архитектура v2: хуки ставятся ВНУТРИ страницы (MAIN world) через Runtime.evaluate,
// поэтому гигантские аудио-кадры (~7-14 МБ hex) больше не проходят через CDP-сокет.
// CDP используется только для: инъекции хука + периодического выкачивания МЕТАДАННЫХ
// (маленькие JSON) из window.__mmDump.
//
// БЕЗОПАСНОСТЬ (playbook):
//  - WS/query URL: только host + path + ИМЕНА параметров (значения token/op_ticket не пишутся).
//  - Аудио: в метаданных — только длина + первые 24 hex-символа + последние 16.
//  - Полные hex-чанки stash-атся в памяти страницы (лимит 2 МБ hex/чанк, кольцо 60 шт),
//    выгружаются по требованию: node minimax-ws-capture.js --fetch <seq>
//  - HTTP-тела download_url/details/history_list: маскируются query-значения в url-полях.
//
// Использование:
//   node minimax-ws-capture.js              # инъекция + поллинг метаданных -> .chrome-debug-profile/ws_capture2.jsonl
//   node minimax-ws-capture.js --status     # показать счётчики хука
//   node minimax-ws-capture.js --fetch <seq># выкачать stash-нутый hex-чанк целиком (последовательность из метаданных)

'use strict';
const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://127.0.0.1:9223';
const OUT_DIR = path.join(__dirname, '.chrome-debug-profile');
const OUT = path.join(OUT_DIR, 'ws_capture2.jsonl');
const SITE_RE = /minimax\.io| hailuo/i;

// ---------------- CDP helpers ----------------
async function getTargets() {
  const res = await fetch(CDP_HTTP + '/json/list');
  return res.json();
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => {
          const mid = ++id;
          pending.set(mid, { res2, rej2 });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      on(event, handler) { ws.addEventListener('message', (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.method === event) handler(msg.params);
      }); },
      close() { ws.close(); },
    }));
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej2(new Error(msg.error.message)); else res2(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP ws error')));
  });
}

// ---------------- in-page hook source ----------------
const HOOK_SRC = String.raw`
(function() {
  if (window.__mmDump) return 'already';
  var D = window.__mmDump = { seq: 0, frames: [], events: [], http: [], audio: [] };
  function rec(arr, obj) { obj._seq = ++D.seq; obj._ts = Date.now(); arr.push(obj); if (arr.length > 600) arr.splice(0, arr.length - 600); }
  function sanitizeUrl(u) {
    try { var url = new URL(u, location.href); var qk = []; url.searchParams.forEach(function(v, k) { qk.push(k); }); return { host: url.host, path: url.pathname, qk: qk }; }
    catch (e) { return { raw: String(u).slice(0, 80) }; }
  }
  function maskQueryValues(s) { return String(s).replace(/([?&][A-Za-z0-9_.-]+=)[^&]*/g, '$1***'); }
  function isHex(s) { return /^[0-9a-fA-F]*$/.test(s); }

  // ---- WebSocket: prototype-level hooks (ловит любые ссылки на конструктор) ----
  var proto = WebSocket.prototype;
  var origAddEventListener = proto.addEventListener;
  proto.addEventListener = function(type, fn, opts) {
    if (type === 'message' && this && !this.__mmHooked) installOn(this);
    return origAddEventListener.call(this, type, fn, opts);
  };
  var onmsgDesc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  if (onmsgDesc && onmsgDesc.set) {
    Object.defineProperty(proto, 'onmessage', {
      set: function(fn) { if (!this.__mmHooked) installOn(this); return onmsgDesc.set.call(this, fn); },
      get: function() { return onmsgDesc.get.call(this); },
      configurable: true
    });
  }
  var origSend = proto.send;
  proto.send = function(data) {
    try {
      var j = typeof data === 'string' ? JSON.parse(data) : null;
      if (j && j.method !== 'Heartbeat') {
        rec(D.frames, { wsId: this.__mmWsId || 0, dir: 'sent', method: j.method || null,
          keys: Object.keys(j), payloadKeys: j.payload ? Object.keys(j.payload) : null,
          model: j.payload && j.payload.model, audioSetting: j.payload && j.payload.audio_setting || null,
          stream: j.payload ? j.payload.stream : undefined, msgId: j.msg_id || null,
          textLen: j.payload && typeof j.payload.text === 'string' ? j.payload.text.length : null,
          voiceId: j.payload && j.payload.voice_setting && j.payload.voice_setting.voice_id });
        if (!D.sentRaw) D.sentRaw = [];
        D.sentRaw.push({ _seq: D.seq, raw: String(data).length <= 4000 ? data : null, len: String(data).length });
        if (D.sentRaw.length > 20) D.sentRaw.shift();
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
  if (proto.dispatchEvent) {
    var origDispatch = proto.dispatchEvent;
    proto.dispatchEvent = function(ev) {
      if (window.__mmDump && ev && ev.type === 'message' && !this.__mmHooked && this instanceof WebSocket) installOn(this);
      return origDispatch.apply(this, arguments);
    };
  }
  function installOn(ws) {
    ws.__mmHooked = true;
    ws.__mmWsId = ++D.seq;
    var wsId = ws.__mmWsId;
    rec(D.events, { type: 'wsCtor', wsId, url: sanitizeUrl(ws.url) });
    origAddEventListener.call(ws, 'open', function() { rec(D.events, { type: 'wsOpen', wsId }); });
    origAddEventListener.call(ws, 'close', function(e) { rec(D.events, { type: 'wsClose', wsId, code: e.code }); });
    origAddEventListener.call(ws, 'error', function() { rec(D.events, { type: 'wsError', wsId }); });
    origAddEventListener.call(ws, 'message', function(ev) {
      var raw = typeof ev.data === 'string' ? ev.data : null;
      if (raw == null) { rec(D.frames, { wsId, dir: 'recv', binary: true, len: ev.data && ev.data.size || null }); return; }
      var j = null; try { j = JSON.parse(raw); } catch (e) {}
      if (!j) { rec(D.frames, { wsId, dir: 'recv', rawLen: raw.length, head: raw.slice(0, 32) }); return; }
      if (j.method === 'Heartbeat') return;
      var d = j.data || {};
      var r = { wsId, dir: 'recv', method: j.method || null, keys: Object.keys(j), dataKeys: Object.keys(d),
        status: d.status === undefined ? null : d.status,
        audioLen: typeof d.audio === 'string' ? d.audio.length : null,
        audioHead: typeof d.audio === 'string' ? d.audio.slice(0, 24) : null,
        audioTail: typeof d.audio === 'string' ? d.audio.slice(-16) : null,
        audioHexValid: typeof d.audio === 'string' ? isHex(d.audio) : null,
        traceId: typeof j.trace_id === 'string' ? j.trace_id : null,
        statusCode: j.base_resp && j.base_resp.status_code !== undefined ? j.base_resp.status_code : (j.statusInfo && j.statusInfo.code),
        restData: null, extraInfoKeys: d.extra_info && typeof d.extra_info === 'object' ? Object.keys(d.extra_info) : null };
      var copy = {}; for (var k in d) if (k !== 'audio' && k !== 'extra_info') copy[k] = d[k];
      try { var s = JSON.stringify(copy); r.restData = s.length > 300 ? s.slice(0, 300) : s; } catch (e) {}
      rec(D.frames, r);
      if (typeof d.audio === 'string' && d.audio.length) {
        var stash = { _seq: D.seq, wsId: wsId, status: r.status, len: d.audio.length, head: r.audioHead,
          hex: d.audio.length <= 2000000 && isHex(d.audio) ? d.audio : null, whyNot: d.audio.length > 2000000 ? 'too_big' : (isHex(d.audio) ? null : 'not_hex') };
        D.audio.push(stash);
        if (D.audio.length > 60) D.audio.shift();
      }
    });
  }

  // ---- fetch hook: download_url / history_list / details ----
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function() {
      var args = arguments;
      var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      return origFetch.apply(this, arguments).then(function(res) {
        try {
          if (/download_url|history_list|audio\/details/.test(url)) {
            var clone = res.clone();
            clone.json().then(function(body) {
              var slim = JSON.stringify(body);
              rec(D.http, { url: maskQueryValues(url), status: res.status, bodyLen: slim.length,
                body: slim.length <= 4000 ? JSON.parse(maskQueryInObject(JSON.parse(slim))) : null,
                bodyHead: slim.length > 4000 ? maskQueryValues(slim.slice(0, 300)) : null });
            }).catch(function() {});
          }
        } catch (e) {}
        return res;
      });
    };
  }
  function maskQueryInObject(o) {
    if (typeof o === 'string') return /https?:\/\//.test(o) ? maskQueryValues(o) : o;
    if (Array.isArray(o)) return o.map(maskQueryInObject);
    if (o && typeof o === 'object') { var r = {}; for (var k in o) r[k] = maskQueryInObject(o[k]); return r; }
    return o;
  }
  function maskQueryValues(s) { return String(s).replace(/([?&][A-Za-z0-9_.-]+=)[^&\s"']+/g, '$1***'); }
  return 'installed';
})()
`;

// ---------------- main ----------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fetchMode = process.argv.includes('--fetch');
  const statusMode = process.argv.includes('--status');

  const targets = await getTargets();
  const page = targets.find(t => t.type === 'page' && /minimax\.io/.test(t.url));
  if (!page) { console.error('No minimax page target found'); process.exit(1); }
  const cdp = await connect(page.webSocketDebuggerUrl);

  if (fetchMode) {
    const seq = Number(process.argv[process.argv.indexOf('--fetch') + 1]);
    const expr = `(function(){ var a=window.__mmDump&&window.__mmDump.audio||[]; var c=a.find(x=>x._seq===${seq}); return c? (c.hex||('NOT_STASHED:'+c.whyNot+':'+c.len)) : 'not_found'; })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const val = r.result.value;
    if (val && !String(val).startsWith('NOT_STASHED') && val !== 'not_found') {
      const out = path.join(OUT_DIR, `chunk_${seq}.hex`);
      fs.writeFileSync(out, val);
      console.log(`wrote ${out}: ${val.length} hex chars (${val.length / 2} bytes)`);
      const buf = Buffer.from(val, 'hex');
      console.log('head:', buf.subarray(0, 16).toString('hex'));
    } else {
      console.log('result:', val);
    }
    cdp.close();
    return;
  }

  if (statusMode) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__mmDump ? {frames: __mmDump.frames.length, events: __mmDump.events.length, http: __mmDump.http.length, audio: __mmDump.audio.length, lastSeq: __mmDump.seq} : "not_installed")',
      returnByValue: true,
    });
    console.log(r.result.value);
    cdp.close();
    return;
  }

  // inject hook
  const inj = await cdp.send('Runtime.evaluate', { expression: HOOK_SRC, returnByValue: true });
  console.log('inject:', JSON.stringify(inj.result.value));

  // pull metadata loop
  console.log('polling __mmDump every 3s ->', OUT);
  let lastSeq = 0;
  let ticks = 0;
  setInterval(async () => {
    try {
      // Re-inject periodically: a page reload (F5) wipes the MAIN world and
      // the hooks with it. HOOK_SRC is idempotent ('already' if present).
      if (ticks % 5 === 0) {
        const inj = await cdp.send('Runtime.evaluate', { expression: HOOK_SRC, returnByValue: true });
        if (inj.result.value === 'installed') console.log('reinject after reload');
      }
      ticks += 1;
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){ var D=window.__mmDump; if(!D) return null;
          var all = D.frames.concat(D.events.map(e=>({frame:'event', ...e})), D.http.map(h=>({frame:'http', ...h})));
          return JSON.stringify(all.filter(x=>x._seq>${lastSeq} && !(x.method==='Heartbeat') && !(x.keys&&x.keys.length===3&&x.keys[0]==='method'))); })()`,
        returnByValue: true,
      });
      if (!r.result.value) return;
      const items = JSON.parse(r.result.value);
      for (const it of items) {
        fs.appendFileSync(OUT, JSON.stringify(it) + '\n');
        lastSeq = Math.max(lastSeq, it._seq);
      }
      if (items.length) console.log(new Date().toISOString(), `+${items.length} (total ${lastSeq})`);
    } catch (e) {
      console.error('pull error:', e.message);
    }
  }, 3000);
}

main().catch(e => { console.error(e); process.exit(1); });
