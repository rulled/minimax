'use strict';

// Pure helpers for the MiniMax direct WebSocket transport.
// Tested by tests/direct_transport.test.js.
//
// IMPORTANT: background.js injects equivalent logic into the page's MAIN world
// via chrome.scripting.executeScript({ func }). MAIN-world functions cannot
// require() this module, so background.js keeps an inline copy. When you change
// logic here, update the inline copy in background.js (search for the markers
// // SYNC:hexDecode and // SYNC:buildFrame) and re-run tests.

/**
 * Build the T2aAsync frame submitted over the WebSocket.
 * Matches the native MiniMax manager contract (module 9122 / 78544).
 *
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.text
 * @param {object} params.voiceSetting  { speed, vol, pitch, voiceId }
 * @param {object} params.audioSetting  { sample_rate, bitrate, format, channel }
 * @param {object} params.effects       { deepen_lighten, stronger_softer, ... }
 * @param {number[]|undefined} params.erWeights
 * @param {string} params.language      language_boost value
 * @param {string} params.msgId         v4 UUID
 * @param {boolean} [params.stream=true]
 * @returns {object} frame
 */
function buildT2aAsyncFrame(params) {
  const p = params || {};
  const settings = p.voiceSetting || {};
  const audio = p.audioSetting || {};
  const effects = p.effects || {};
  return {
    payload: {
      model: String(p.model || ''),
      text: String(p.text || ''),
      voice_setting: {
        speed: Number(settings.speed),
        vol: Number(settings.vol),
        pitch: Number(settings.pitch),
        voice_id: String(settings.voiceId || '')
      },
      audio_setting: {
        sample_rate: audio.sample_rate,
        bitrate: audio.bitrate,
        format: audio.format,
        channel: audio.channel
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
      er_weights: Array.isArray(p.erWeights) ? p.erWeights : [],
      language_boost: String(p.language || ''),
      stream: p.stream !== false
    },
    msg_id: String(p.msgId || '')
  };
}

/**
 * Deterministic signature of the settings that must be stable between the
 * ready-state probe and the actual frame submission. Both background.js paths
 * (getDirectTtsReadyState vs submitDirectLongText/generateDirectAudio) MUST
 * build this with identical field set and value types, otherwise the transport
 * functions return minimax_direct_settings_changed and never send.
 *
 * NOTE: `effects` is serialized as-is (no `|| null`), matching the transport
 * functions. See commit that fixed this divergence.
 *
 * @param {object} params
 * @param {string} params.model
 * @param {object} params.voiceSetting
 * @param {object} params.audioSetting
 * @param {object} params.effects
 * @param {number[]|undefined} params.erWeights
 * @param {string} params.language
 * @returns {string} JSON signature
 */
function computeStateSignature(params) {
  const p = params || {};
  const settings = p.voiceSetting || {};
  const audio = p.audioSetting || {};
  return JSON.stringify({
    model: String(p.model || ''),
    voiceSetting: {
      speed: settings.speed,
      vol: settings.vol,
      pitch: settings.pitch,
      voiceId: String(settings.voiceId || '')
    },
    audioSetting: {
      sampleRate: audio.sample_rate,
      bitrate: audio.bitrate,
      format: audio.format,
      channel: audio.channel
    },
    effects: p.effects,
    erWeights: Array.isArray(p.erWeights) ? p.erWeights : [],
    language: String(p.language || '')
  });
}

// Shared lookup table for hex char -> nibble value (0..15), 255 = invalid.
const HEX_NIBBLE = (function () {
  const t = new Uint8Array(128).fill(255);
  const hex = '0123456789abcdefABCDEF';
  for (let i = 0; i < hex.length; i += 1) {
    t[hex.charCodeAt(i)] = i < 16 ? i : i - 6;
  }
  return t;
})();

/**
 * Decode a hex string into a Uint8Array, validating every character.
 * Replaces the O(n) regex + parseInt-per-byte path that used to scan a
 * multi-MB string twice.
 *
 * @param {string} hex
 * @returns {{ok:boolean, bytes?:Uint8Array, reason?:string}}
 */
function decodeHexAudio(hex) {
  if (!hex || typeof hex !== 'string') {
    return { ok: false, reason: 'minimax_direct_audio_invalid' };
  }
  if (hex.length % 2 !== 0) {
    return { ok: false, reason: 'minimax_direct_audio_invalid' };
  }
  const byteLen = hex.length / 2;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i += 1) {
    const hi = HEX_NIBBLE[hex.charCodeAt(i * 2)];
    const lo = HEX_NIBBLE[hex.charCodeAt(i * 2 + 1)];
    if (hi > 15 || lo > 15) {
      return { ok: false, reason: 'minimax_direct_audio_invalid' };
    }
    bytes[i] = (hi << 4) | lo;
  }
  return { ok: true, bytes };
}

/**
 * Locate the first MPEG audio frame, skipping an ID3v2 tag if present.
 * @param {Uint8Array} bytes
 * @returns {number} offset of the first MPEG frame sync
 */
function findMpegFrameOffset(bytes) {
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const id3Size = ((bytes[6] & 0x7f) << 21)
      | ((bytes[7] & 0x7f) << 14)
      | ((bytes[8] & 0x7f) << 7)
      | (bytes[9] & 0x7f);
    return 10 + id3Size;
  }
  return 0;
}

/**
 * Validate that the decoded bytes look like a real MP3:
 * - at least 1024 bytes
 * - an MPEG frame sync (0xFFEx) at the computed offset
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isValidMp3(bytes) {
  if (bytes.length < 1024) return false;
  const offset = findMpegFrameOffset(bytes);
  return offset + 1 < bytes.length
    && bytes[offset] === 0xff
    && (bytes[offset + 1] & 0xe0) === 0xe0;
}

/**
 * Build a data:audio/mpeg;base64 URL from raw bytes, chunked to avoid
 * String.fromCharCode.apply stack limits on large payloads.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function buildAudioDataUrl(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000)));
  }
  // btoa is available in browsers and Node 16+. In Node tests we polyfill.
  const encoder = (typeof btoa === 'function')
    ? btoa
    : (s) => Buffer.from(s, 'binary').toString('base64');
  return 'data:audio/mpeg;base64,' + encoder(chunks.join(''));
}

module.exports = {
  buildT2aAsyncFrame,
  computeStateSignature,
  decodeHexAudio,
  findMpegFrameOffset,
  isValidMp3,
  buildAudioDataUrl,
  HEX_NIBBLE
};
