const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildT2aAsyncFrame,
  computeStateSignature,
  decodeHexAudio,
  findMpegFrameOffset,
  containsRiffWavBlock,
  isMp3Head,
  isValidMp3,
  buildAudioDataUrl
} = require('../direct_transport');

// ---------- buildT2aAsyncFrame ----------

test('buildT2aAsyncFrame produces the expected top-level shape', () => {
  const frame = buildT2aAsyncFrame({
    model: 'speech-2.8-hd',
    text: 'hello',
    voiceSetting: { speed: 1, vol: 1, pitch: 0, voiceId: '435308685594837' },
    audioSetting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    effects: { deepen_lighten: 0, spacious_echo: false },
    erWeights: [],
    language: 'Polish',
    msgId: '11111111-2222-3333-4444-555555555555'
  });
  assert.deepEqual(Object.keys(frame).sort(), ['msg_id', 'payload']);
  assert.equal(frame.msg_id, '11111111-2222-3333-4444-555555555555');
  const payload = frame.payload;
  assert.deepEqual(Object.keys(payload).sort(),
    ['audio_setting', 'effects', 'er_weights', 'language_boost', 'model', 'stream', 'text', 'voice_setting']);
  assert.equal(payload.stream, true);
  assert.equal(payload.language_boost, 'Polish');
  assert.equal(payload.voice_setting.voice_id, '435308685594837');
});

test('buildT2aAsyncFrame effects fields are always present and typed', () => {
  const frame = buildT2aAsyncFrame({
    effects: { spacious_echo: true, robotic: 0 },
    msgId: 'x'
  });
  const e = frame.payload.effects;
  assert.equal(e.deepen_lighten, 0);
  assert.equal(e.stronger_softer, 0);
  assert.equal(e.nasal_crisp, 0);
  assert.equal(e.spacious_echo, true);
  assert.equal(e.lofi_telephone, false);
  assert.equal(e.robotic, false);
  assert.equal(e.auditorium_echo, false);
});

test('buildT2aAsyncFrame stream defaults to true and can be disabled', () => {
  assert.equal(buildT2aAsyncFrame({ msgId: 'a' }).payload.stream, true);
  assert.equal(buildT2aAsyncFrame({ msgId: 'a', stream: false }).payload.stream, false);
});

// ---------- computeStateSignature ----------

test('computeStateSignature is stable for identical inputs', () => {
  const args = {
    model: 'speech-2.8-hd',
    voiceSetting: { speed: 1, vol: 1, pitch: 0, voiceId: 'v1' },
    audioSetting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    effects: { deepen_lighten: 0 },
    erWeights: [],
    language: 'Polish'
  };
  assert.equal(computeStateSignature(args), computeStateSignature(args));
});

test('computeStateSignature serializes undefined effects identically (no || null divergence)', () => {
  // Regression for the divergence that caused minimax_direct_settings_changed:
  // ready-state used `effects: effects || null`, transport used bare `effects`.
  // JSON.stringify omits undefined values, so both must produce the SAME string
  // (neither should inject a null). Verify the undefined-effects signature equals
  // a signature built without an effects field at all, AND differs from one that
  // explicitly sets effects: null.
  const withUndefinedEffects = computeStateSignature({
    model: 'm', voiceSetting: { voiceId: 'v' }, audioSetting: {},
    effects: undefined, erWeights: [], language: ''
  });
  // bare effects (undefined) omits the key — transport functions do the same
  const withNullEffects = computeStateSignature({
    model: 'm', voiceSetting: { voiceId: 'v' }, audioSetting: {},
    effects: null, erWeights: [], language: ''
  });
  assert.notEqual(withUndefinedEffects, withNullEffects,
    'undefined effects and null effects must NOT match — that was the original bug');
  // The transport functions now use bare `effects: p.effects`, so when effects
  // is undefined the key is omitted in both ready-state and transport signatures.
  assert.ok(!withUndefinedEffects.includes('"effects":null'),
    'undefined-effects signature must not contain a null effects value');
});

test('computeStateSignature changes when voiceId changes', () => {
  const base = {
    model: 'm', voiceSetting: { voiceId: 'v1' }, audioSetting: {},
    effects: {}, erWeights: [], language: ''
  };
  const alt = { ...base, voiceSetting: { voiceId: 'v2' } };
  assert.notEqual(computeStateSignature(base), computeStateSignature(alt));
});

// ---------- decodeHexAudio ----------

test('decodeHexAudio rejects empty and odd-length input', () => {
  assert.equal(decodeHexAudio('').ok, false);
  assert.equal(decodeHexAudio('abc').ok, false);
  assert.equal(decodeHexAudio(null).ok, false);
});

test('decodeHexAudio rejects non-hex characters', () => {
  assert.equal(decodeHexAudio('zz').ok, false);
  assert.equal(decodeHexAudio('1g').ok, false);
});

test('decodeHexAudio decodes lowercase, uppercase, and mixed hex', () => {
  assert.deepEqual(Array.from(decodeHexAudio('0a').bytes), [10]);
  assert.deepEqual(Array.from(decodeHexAudio('0A').bytes), [10]);
  assert.deepEqual(Array.from(decodeHexAudio('ff').bytes), [255]);
  assert.deepEqual(Array.from(decodeHexAudio('FF').bytes), [255]);
  assert.deepEqual(Array.from(decodeHexAudio('fF').bytes), [255]);
  assert.deepEqual(Array.from(decodeHexAudio('00ff80').bytes), [0, 255, 128]);
});

test('decodeHexAudio handles large input without stack overflow', () => {
  const big = 'ab'.repeat(200000); // 200000 bytes
  const result = decodeHexAudio(big);
  assert.equal(result.ok, true);
  assert.equal(result.bytes.length, 200000);
  assert.equal(result.bytes[0], 0xab);
  assert.equal(result.bytes[199999], 0xab);
});

// ---------- MP3 validation ----------

test('isValidMp3 rejects undersized payloads', () => {
  assert.equal(isValidMp3(new Uint8Array(1023)), false);
});

test('isValidMp3 accepts a payload starting with an MPEG frame sync', () => {
  const bytes = new Uint8Array(1100);
  bytes[0] = 0xff;
  bytes[1] = 0xe0; // sync + MPEG version bits
  assert.equal(isValidMp3(bytes), true);
});

test('isValidMp3 skips ID3v2 tag and finds the frame after it', () => {
  const bytes = new Uint8Array(1100);
  // ID3v2 header: 'ID3' + version + flags + size (synchsafe)
  bytes[0] = 0x49; bytes[1] = 0x44; bytes[2] = 0x33; // 'ID3'
  bytes[3] = 0x03; bytes[4] = 0x00; // version 2.3
  bytes[5] = 0x00; // flags
  // synchsafe size = 10 -> place MPEG frame at offset 20
  bytes[6] = 0; bytes[7] = 0; bytes[8] = 0; bytes[9] = 0x0a;
  bytes[20] = 0xff; bytes[21] = 0xe3;
  assert.equal(findMpegFrameOffset(bytes), 20);
  assert.equal(isValidMp3(bytes), true);
});

test('isValidMp3 rejects a payload with no frame sync', () => {
  const bytes = new Uint8Array(1200).fill(0);
  assert.equal(isValidMp3(bytes), false);
});

// ---------- RIFF/WAV glue regression (corrupted downloads) ----------

test('containsRiffWavBlock detects a WAV glued onto the MP3 stream', () => {
  // Regression: status:1 MP3 chunks followed by the status:2 full-WAV frame
  // glued into one payload produced "MP3 + WAV" files that strict demuxers
  // reject. The status filter prevents the glue; this scan is the net.
  const bytes = new Uint8Array(2100);
  bytes[0] = 0x49; bytes[1] = 0x44; bytes[2] = 0x33; // 'ID3'
  bytes[20] = 0xff; bytes[21] = 0xe0; // MPEG frame sync
  bytes[2000] = 0x52; bytes[2001] = 0x49; bytes[2002] = 0x46; bytes[2003] = 0x46; // 'RIFF'
  assert.equal(containsRiffWavBlock(bytes), true);
});

test('containsRiffWavBlock passes a clean MP3 payload', () => {
  const bytes = new Uint8Array(2100);
  bytes[20] = 0xff; bytes[21] = 0xe0;
  assert.equal(containsRiffWavBlock(bytes), false);
});

test('containsRiffWavBlock handles tiny and empty payloads', () => {
  assert.equal(containsRiffWavBlock(new Uint8Array(0)), false);
  assert.equal(containsRiffWavBlock(new Uint8Array([0x52, 0x49, 0x46])), false);
  assert.equal(containsRiffWavBlock(new Uint8Array([0x52, 0x49, 0x46, 0x46])), true);
});

// ---------- first-chunk leak guard (isMp3Head) ----------

test('isMp3Head accepts an ID3v2 head', () => {
  // First status:1 chunk of a fresh generation starts with the ID3 tag.
  assert.equal(isMp3Head('4944330400000000'), true);
  assert.equal(isMp3Head('494433'), true);
});

test('isMp3Head accepts MPEG frame sync heads', () => {
  // Continuation chunks start with 0xFFFx sync words.
  assert.equal(isMp3Head('fffb9064'), true);
  assert.equal(isMp3Head('ffe39064'), true);
  assert.equal(isMp3Head('FFF39000'), true); // uppercase tolerated
});

test('isMp3Head rejects a leaked WAV tail and garbage', () => {
  // A tail of a foreign/aborted stream would start with RIFF.
  assert.equal(isMp3Head('52494646'), false);
  assert.equal(isMp3Head('00fffb90'), false);
  assert.equal(isMp3Head('zzff'), false);
});

test('isMp3Head rejects empty, short, and non-string input', () => {
  assert.equal(isMp3Head(''), false);
  assert.equal(isMp3Head('ff'), false);
  assert.equal(isMp3Head(null), false);
  assert.equal(isMp3Head(undefined), false);
  assert.equal(isMp3Head(42), false);
});

// ---------- buildAudioDataUrl ----------

test('buildAudioDataUrl produces a valid base64 data URL', () => {
  const bytes = new Uint8Array([0xff, 0xe0, 0x00, 0x01]);
  const url = buildAudioDataUrl(bytes);
  assert.ok(url.startsWith('data:audio/mpeg;base64,'));
  // decode the base64 back and verify the bytes round-trip
  const b64 = url.split(',')[1];
  const decoded = Buffer.from(b64, 'base64');
  assert.deepEqual(Array.from(decoded), Array.from(bytes));
});

test('buildAudioDataUrl handles large payloads in 32KB chunks', () => {
  const bytes = new Uint8Array(70000).fill(0xaa);
  const url = buildAudioDataUrl(bytes);
  assert.ok(url.startsWith('data:audio/mpeg;base64,'));
  // decode and verify length matches
  const b64 = url.split(',')[1];
  const decoded = Buffer.from(b64, 'base64');
  assert.equal(decoded.length, 70000);
  assert.equal(decoded[0], 0xaa);
});

// ---------- end-to-end decode of a synthetic MP3-like payload ----------

test('full decode pipeline: hex chunks -> valid MP3 -> data url', () => {
  // Build a payload: ID3 tag of size 10, then an MPEG frame sync, padded to >1024 bytes.
  const body = new Uint8Array(2000);
  body[0] = 0x49; body[1] = 0x44; body[2] = 0x33; // 'ID3'
  body[3] = 0x03; body[4] = 0x00; body[5] = 0x00;
  body[6] = 0; body[7] = 0; body[8] = 0; body[9] = 0x0a; // id3 size 10
  body[20] = 0xff; body[21] = 0xe0;
  // Convert to hex
  const hex = Array.from(body).map((b) => b.toString(16).padStart(2, '0')).join('');
  const decoded = decodeHexAudio(hex);
  assert.equal(decoded.ok, true);
  assert.equal(isValidMp3(decoded.bytes), true);
  const url = buildAudioDataUrl(decoded.bytes);
  assert.ok(url.startsWith('data:audio/mpeg;base64,'));
});

test('full decode pipeline rejects tampered hex', () => {
  const body = new Uint8Array(2000);
  body[20] = 0xff; body[21] = 0xe0;
  let hex = Array.from(body).map((b) => b.toString(16).padStart(2, '0')).join('');
  // inject a non-hex char in the middle
  hex = hex.slice(0, 500) + 'z' + hex.slice(501);
  const decoded = decodeHexAudio(hex);
  // now odd + invalid char
  assert.equal(decoded.ok, false);
});
