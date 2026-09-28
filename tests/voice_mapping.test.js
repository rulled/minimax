// Контракт подбора голосов в voice_mapping.js.
// Запуск: node --test tests/voice_mapping.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('../voice_mapping.js');

const voice = (voiceName) => ({ voiceId: voiceName, voiceName, voiceStatus: 2 });

const PROJECT_VOICES = [
  voice('mp seleba 70742038'),
  voice('mp dic 70742038'),
  voice('mp doc Ramon Cugat'),
  voice('mp doc José Manuel Ribera Casado'),
  voice('mp doc Alberto Sanagustín'),
  voice('mp doc Mario Alonso Puig'),
  voice('mp doc Pedro Cavadas'),
  voice('mp doc Antonio de Lacy'),
];

test('язык не обязателен в имени голоса: роль ищется без него', () => {
  const res = vm.resolveVoice('Доктор Antonio de Lacy(70742038)', 'ES', PROJECT_VOICES);
  assert.equal(res.status, 'ok');
  assert.equal(res.voice.voiceName, 'mp doc Antonio de Lacy');
});

test('имя доктора в теге разводит шесть докторов по своим голосам', () => {
  const speakers = [
    ['Доктор Antonio de Lacy(70742038)', 'mp doc Antonio de Lacy'],
    ['Доктор Pedro Cavadas(70742038)', 'mp doc Pedro Cavadas'],
    ['Доктор Mario Alonso Puig(70742038)', 'mp doc Mario Alonso Puig'],
    ['Доктор Alberto Sanagustín(70742038)', 'mp doc Alberto Sanagustín'],
    ['Доктор José Manuel Ribera Casado(70742038)', 'mp doc José Manuel Ribera Casado'],
    ['Доктор Ramon Cugat(70742038)', 'mp doc Ramon Cugat'],
  ];
  for (const [speaker, expected] of speakers) {
    const res = vm.resolveVoice(speaker, 'ES', PROJECT_VOICES);
    assert.equal(res.status, 'ok', `${speaker} → ok`);
    assert.equal(res.voice.voiceName, expected, `${speaker} → ${expected}`);
  }
});

test('тег без имени в докторах даёт всех кандидатов (обратная совместимость)', () => {
  const res = vm.resolveVoice('Доктор(70742038)', 'ES', PROJECT_VOICES);
  assert.equal(res.status, 'ambiguous');
  assert.equal(res.candidates.length, 6);
});

test('ведущий — та же семья, что диктор/репортёр', () => {
  const res = vm.resolveVoice('Ведущий(70742038)', 'ES', PROJECT_VOICES);
  assert.equal(res.status, 'ok');
  assert.equal(res.voice.voiceName, 'mp dic 70742038');
  assert.equal(vm.resolveVoice('Ведущая(70742038)', 'ES', PROJECT_VOICES).status, 'ok');
});

test('селеба находится по латинскому написанию seleba', () => {
  const res = vm.resolveVoice('Селеба(70742038)', 'ES', PROJECT_VOICES);
  assert.equal(res.status, 'ok');
  assert.equal(res.voice.voiceName, 'mp seleba 70742038');
});

test('язык работает как уточнение, когда голосов несколько', () => {
  const voices = [voice('mp es doc Pedro Cavadas'), voice('mp en doc Pedro Cavadas')];
  const res = vm.resolveVoice('Доктор Pedro Cavadas(70742038)', 'ES', voices);
  assert.equal(res.status, 'ok');
  assert.equal(res.voice.voiceName, 'mp es doc Pedro Cavadas');
});

test('код карточки разводит одинаковые роли одного пака', () => {
  const voices = [voice('mp dic 70742038'), voice('mp dic 70799999')];
  const res = vm.resolveVoice('Ведущий(70742038)', 'ES', voices);
  assert.equal(res.status, 'ok');
  assert.equal(res.voice.voiceName, 'mp dic 70742038');
});

test('отзывы: пол и номер обязательны', () => {
  const voices = [voice('mp отзыв женщина 1'), voice('mp отзыв мужчина 1')];
  assert.equal(vm.resolveVoice('Отзыв 1 женщина(ES)', 'ES', voices).voice.voiceName, 'mp отзыв женщина 1');
  assert.equal(vm.resolveVoice('Отзыв 1 мужчина(ES)', 'ES', voices).voice.voiceName, 'mp отзыв мужчина 1');
  assert.equal(vm.resolveVoice('Отзыв 2 женщина(ES)', 'ES', voices).status, 'missing');
});

test('украинские отзывы: чоловік/жінка распознаются как отзывы', () => {
  const voices = [voice('mp отзыв чоловік 1'), voice('mp отзыв жінка 1'), voice('mp отзыв мужчина 3')];
  assert.equal(vm.getRole('Отзыв 1 чоловік(UK)').type, 'testimonial');
  assert.equal(vm.resolveVoice('Отзыв 1 чоловік(UK)', 'UK', voices).voice.voiceName, 'mp отзыв чоловік 1');
  assert.equal(vm.resolveVoice('Отзыв 1 жінка(UK)', 'UK', voices).voice.voiceName, 'mp отзыв жінка 1');
  // русское написание тоже подходит: голос «мужчина 3» закрывает «Отзыв 3 чоловік»
  assert.equal(vm.resolveVoice('Отзыв 3 чоловік(UK)', 'UK', voices).voice.voiceName, 'mp отзыв мужчина 3');
});

test('отзывы без номера в имени голоса не подходят, если номер задан', () => {
  const voices = [voice('mp отзыв женщина')];
  assert.equal(vm.resolveVoice('Отзыв 1 женщина(ES)', 'ES', voices).status, 'missing');
});

test('голоса не в статусе 2 не участвуют в подборе', () => {
  const voices = [{ voiceId: 'x', voiceName: 'mp doc Pedro Cavadas', voiceStatus: 1 }];
  assert.equal(vm.resolveVoice('Доктор Pedro Cavadas(70742038)', 'ES', voices).status, 'missing');
});

test('нужен префикс mp', () => {
  const voices = [voice('doc Pedro Cavadas')];
  assert.equal(vm.resolveVoice('Доктор Pedro Cavadas(70742038)', 'ES', voices).status, 'missing');
});

test('обрезанное имя в голосе всё равно разводит докторов (Lac ↔ Lacy)', () => {
  const voices = [voice('mp doc Antonio de Lac'), voice('mp doc Ramon Cugat')];
  const res = vm.resolveVoice('Доктор Antonio de Lacy(70742038)', 'ES', voices);
  assert.equal(res.status, 'ok');
  assert.equal(res.voice.voiceName, 'mp doc Antonio de Lac');
});

test('склеенное имя в голосе всё равно разводит докторов (MustafaEraslan)', () => {
  const voices = [voice('mp doc MustafaEraslan 70808361'), voice('mp doc Feridun Kunak 70808361')];
  const res = vm.resolveVoice('Доктор Mustafa Eraslan(70808361)', 'TR', voices);
  assert.equal(res.status, 'ok');
  assert.equal(res.voice.voiceName, 'mp doc MustafaEraslan 70808361');
});

test('терпимость к имени не склеивает разных докторов', () => {
  const voices = [voice('mp doc Ramon Cugat'), voice('mp doc Pedro Cavadas')];
  const res = vm.resolveVoice('Доктор Antonio de Lacy(70742038)', 'ES', voices);
  assert.equal(res.status, 'ambiguous');
  assert.equal(res.candidates.length, 2);
});
