// Контракт границ блоков озвучки в parser.js.
// Запуск: node --test tests/parser.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown } = require('../parser.js');

const blocks = (md) => parseMarkdown(md).map(entry => [entry.speaker, entry.text]);

test('двоеточие и индекс не обязательны: все варианты заголовка дают один блок', () => {
  const variants = [
    ['**Диктор**', 'Диктор'],
    ['**Диктор:**', 'Диктор'],
    ['**Диктор**:', 'Диктор'],
    ['**Диктор 1**', 'Диктор 1'],
    ['**Диктор 1:**', 'Диктор 1'],
    ['\\*\\*Диктор\\*\\*', 'Диктор']
  ];
  for (const [header, rawTag] of variants) {
    const parsed = parseMarkdown(`${header}\n\nРеплика.`);
    assert.equal(parsed.length, 1, `${header} → один блок`);
    assert.equal(parsed[0].speaker, 'Диктор', `${header} → спикер "Диктор"`);
    assert.equal(parsed[0].text, 'Реплика.', `${header} → текст блока`);
    // originalTag — сырой тег без markdown/двоеточий: он идёт в имя файла.
    assert.equal(parsed[0].originalTag, rawTag, `${header} → originalTag`);
  }
});

test('идентификатор пака в заголовке сохраняется как часть спикера', () => {
  const [entry] = parseMarkdown('**ДИКТОР(70739835) 7:** голос пака');
  assert.equal(entry.speaker, 'ДИКТОР(70739835)');
  assert.equal(entry.originalTag, 'ДИКТОР(70739835) 7');
  assert.equal(entry.text, 'голос пака');
});

test('нумерация не влияет ни на спикера, ни на порядок блоков', () => {
  const numbered = '**Диктор 1**\n\nA\n\n**Доктор 1**\n\nB\n\n**Диктор 2**\n\nC';
  const plain = '**Диктор**\n\nA\n\n**Доктор**\n\nB\n\n**Диктор**\n\nC';
  assert.deepEqual(blocks(numbered), [['Диктор', 'A'], ['Доктор', 'B'], ['Диктор', 'C']]);
  assert.deepEqual(blocks(numbered), blocks(plain));
});

test('жирный фрагмент внутри абзаца не режет блок', () => {
  assert.deepEqual(blocks('**Диктор**\n\nНачало **важно** конец.'), [['Диктор', 'Начало **важно** конец.']]);
});

test('длинная жирная строка остаётся текстом, а не спикером', () => {
  const long = '**' + 'очень длинная выделенная мысль '.repeat(4).trim() + '**';
  const parsed = parseMarkdown(`**Диктор**\n\n${long}`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, long);
});

test('абзацы одного блока разделяются переводом строки, пустые строки схлопываются', () => {
  assert.deepEqual(blocks('**Диктор**\n\nПервый абзац.\n\nВторой абзац.'), [['Диктор', 'Первый абзац.\nВторой абзац.']]);
});

test('метаданные и download_index привязаны к блоку', () => {
  const parsed = parseMarkdown('<!-- language_code: ES -->\n<!-- download_index: 7 -->\n\n**Диктор**\n\nA\n\n**Диктор**\n\nB');
  assert.deepEqual(parsed.map(e => [e.languageCode, e.downloadIndex, e.text]),
    [['ES', 7, 'A'], ['ES', null, 'B']]);
});

test('экранированная пунктуация разэкранируется', () => {
  assert.equal(parseMarkdown('**Диктор**\n\n120 sobre 80\\. ¡Gracias\\!')[0].text, '120 sobre 80. ¡Gracias!');
});

test('файл без заголовков не даёт блоков', () => {
  assert.deepEqual(parseMarkdown('текст без единого заголовка'), []);
});
