/**
 * Parser для извлечения реплик из markdown-текста.
 *
 * ФОРМУЛА ДЕЛЕНИЯ ТЕКСТА НА БЛОКИ ОЗВУЧКИ
 * ---------------------------------------
 * 1 блок = 1 реплика = заголовок спикера + весь текст до следующего заголовка
 * (пустые строки внутри блока схлопываются, абзацы разделяются `\n`).
 *
 * Граница блока — единственный обязательный селектор: markdown-выделение
 * `**Спикер**` (две `*` с каждой стороны) отдельной строкой. Всё остальное в
 * заголовке опционально и на границу не влияет:
 *
 *   **Диктор**              базовый вариант: без индекса и без двоеточия
 *   **Диктор:**             двоеточие внутри жирного
 *   **Диктор**:             двоеточие сразу после жирного
 *   **Диктор 1**            индекс отделён пробелом
 *   **Диктор 1:**           индекс + двоеточие
 *   **ДИКТОР(70739835) 1:** индекс + идентификатор пака (голоса)
 *   **Диктор**: текст       инлайн-текст в той же строке (двоеточие обязательно)
 *
 * Индекс в заголовке — необязательная метка. Он НИКОГДА не участвует в
 * маппинге голосов (отбрасывается в normalizeSpeakerName, поэтому `**Диктор**`,
 * `**Диктор 1**` и `**Диктор 7**` — один и тот же спикер) и НИКОГДА не задаёт
 * порядок: порядок блоков = порядок строк в файле, он же становится
 * download_index для нарезки озвучки.
 *
 * Двоеточие обязательно только тогда, когда в строке после заголовка идёт
 * текст: так жирный фрагмент внутри абзаца не превращается в нового спикера.
 */

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\\-/g, '-')
    .replace(/\\\./g, '.')
    .replace(/\\!/g, '!')
    .replace(/\\\?/g, '?')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .trim();
}

function parseMetadataComment(line) {
  const match = String(line || '').trim().match(/^<!--\s*([a-zA-Z0-9_ -]+?)\s*:\s*(.*?)\s*-->$/);
  if (!match) return null;
  return {
    key: match[1].trim().toLowerCase().replace(/\s+/g, '_'),
    value: match[2].trim()
  };
}

// УЛУЧШЕННАЯ ФУНКЦИЯ - извлекает "Отзыв N пол" из сложных тегов
function normalizeSpeakerName(rawName) {
  // 1. Убираем markdown символы (звездочки, слеши, двоеточия по краям)
  let name = rawName.replace(/^[\\*]+|[\\*:]+$/g, '').trim();

  // 2. НОВАЯ ЛОГИКА: Ищем паттерн "Отзыв N пол" в конце строки
  // Примеры:
  // "Диабет_Реп+Док - Отзыв 1 женщина" → "Отзыв 1 женщина"
  // "Зрение_Реп+Док-короткий - Отзыв 4 мужчина" → "Отзыв 4 мужчина"
  const reviewPattern = /[–\-]\s*(?:Отзыв|отзыв|Review|review)\s+(\d+)\s+(женщина|мужчина|woman|man|female|male)$/i;
  const reviewMatch = name.match(reviewPattern);
  
  if (reviewMatch) {
    const number = reviewMatch[1];
    const gender = reviewMatch[2].toLowerCase();
    
    // Нормализуем пол на русский
    let normalizedGender = gender;
    if (gender === 'woman' || gender === 'female') normalizedGender = 'женщина';
    if (gender === 'man' || gender === 'male') normalizedGender = 'мужчина';
    
    return `Отзыв ${number} ${normalizedGender}`;
  }

  // 3. Старая логика: Убираем цифры в конце строки, если перед ними есть пробел
  // Работает для "Laura Ingraham 1" -> "Laura Ingraham"
  // Работает для "Sam Altman 5" -> "Sam Altman"
  // Работает для "Dictor 1" -> "Dictor"
  // Работает для "ДИКТОР(70739835) 1" -> "ДИКТОР(70739835)"
  return name.replace(/\s+\d+$/, '');
}

// Жирный заголовок целиком: `**Спикер**`, `**Спикер:**`, `**Спикер**:`,
// `**Спикер**: текст`. `\\?` допускает экранированные звёздочки
// (`\*\*Спикер\*\*`) в уже сохранённых файлах.
const SPEAKER_HEADER_RE = /^\\?\*\\?\*(.+?)\\?\*\\?\*\s*(:?)\s*(.*)$/;
// Заголовок — короткая метка спикера, а не абзац: длинная «жирная» строка
// спикером не считается и остаётся текстом текущего блока.
const MAX_SPEAKER_HEADER_LENGTH = 80;

// Строка — граница блока? → { rawSpeaker, inlineText } либо null.
function matchSpeakerHeader(line) {
  const match = String(line || '').match(SPEAKER_HEADER_RE);
  if (!match) return null;

  const colonAfterBold = match[2] === ':';
  const inlineText = match[3].trim();
  let rawSpeaker = match[1].trim();

  // `**Диктор:**` — двоеточие попадает внутрь жирного захвата.
  const colonInsideBold = /:\s*$/.test(rawSpeaker);
  if (colonInsideBold) rawSpeaker = rawSpeaker.replace(/:\s*$/, '').trim();

  if (!rawSpeaker || rawSpeaker.length > MAX_SPEAKER_HEADER_LENGTH) return null;
  // Без двоеточия заголовок должен занимать строку целиком, иначе это жирный
  // фрагмент внутри абзаца.
  if (!colonAfterBold && !colonInsideBold && inlineText) return null;

  return { rawSpeaker, inlineText };
}

function parseMarkdown(markdownText) {
  if (!markdownText || typeof markdownText !== 'string') {
    throw new Error('Некорректный входной текст');
  }

  const lines = markdownText.split(/\r\n|\r|\n/);
  const entries = [];
  let currentEntry = null;
  const currentContext = {
    languageCode: '',
    minimaxLanguage: '',
    niche: '',
    packId: '',
    sourceTag: '',
    downloadIndex: null
  };

  function finalizeCurrentEntry() {
    if (!currentEntry || !currentEntry.text.trim()) return;
    entries.push({
      ...currentEntry,
      text: cleanText(currentEntry.text)
    });
    currentEntry = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const metadata = parseMetadataComment(line);
    if (metadata) {
      finalizeCurrentEntry();

      if (metadata.key === 'language_code' || metadata.key === 'target_language_code') {
        currentContext.languageCode = metadata.value.toUpperCase();
      } else if (metadata.key === 'minimax_language') {
        currentContext.minimaxLanguage = metadata.value;
      } else if (metadata.key === 'niche') {
        currentContext.niche = metadata.value;
      } else if (metadata.key === 'pack_id') {
        currentContext.packId = metadata.value;
      } else if (metadata.key === 'source_tag') {
        currentContext.sourceTag = metadata.value;
      } else if (metadata.key === 'download_index') {
        const downloadIndex = Number(metadata.value);
        currentContext.downloadIndex = Number.isInteger(downloadIndex) && downloadIndex > 0
          ? downloadIndex
          : null;
      }
      continue;
    }

    const header = matchSpeakerHeader(line);

    if (header) {
      finalizeCurrentEntry();

      const { rawSpeaker, inlineText } = header;
      const finalSpeaker = normalizeSpeakerName(rawSpeaker);

      currentEntry = {
        id: `${finalSpeaker.replace(/\s+/g, '_')}-${i}`,
        speaker: finalSpeaker,
        originalTag: rawSpeaker, // Сохраняем полный оригинальный тег
        languageCode: currentContext.languageCode || '',
        minimaxLanguage: currentContext.minimaxLanguage || '',
        niche: currentContext.niche || '',
        packId: currentContext.packId || '',
        sourceTag: currentContext.sourceTag || '',
        downloadIndex: currentContext.downloadIndex,
        text: inlineText,
        preview: ''
      };
      currentContext.downloadIndex = null;
    } else if (currentEntry) {
      currentEntry.text += (currentEntry.text ? '\n' : '') + line;
    }
  }

  finalizeCurrentEntry();

  // Генерация превью
  entries.forEach(entry => {
    const lines = entry.text.split('\n').map(l => l.trim()).filter(l => l);
	const firstLine = lines.length > 0 ? lines[0] : '';

    if (firstLine.length > 60) {
      const chars = Array.from(firstLine);
      entry.preview = (chars.length > 60 ? chars.slice(0, 60).join('') : firstLine) + '...';
    } else {
      entry.preview = firstLine;
    }
  });

  return entries;
}

function filterBySpeaker(entries, speakerType) {
  if (!Array.isArray(entries)) throw new Error('Entries должен быть массивом');
  if (speakerType === 'all') return entries;
  return entries.filter(entry => entry.speaker === speakerType);
}

function getStatistics(entries) {
  if (!Array.isArray(entries)) throw new Error('Entries должен быть массивом');
  const stats = {};
  entries.forEach(entry => {
    const name = entry.speaker;
    if (!stats[name]) stats[name] = 0;
    stats[name]++;
  });
  return stats;
}

function validateEntries(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return { valid: false, errors: ['Некорректный формат'] };
  if (entries.length === 0) return { valid: false, errors: ['Пустой файл'] };

  entries.forEach((entry, index) => {
    if (!entry.speaker) errors.push(`Запись ${index}: нет спикера`);
    if (!entry.text || entry.text.trim().length === 0) errors.push(`Запись ${index}: пустой текст`);
  });

  return { valid: errors.length === 0, errors };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseMarkdown,
    filterBySpeaker,
    getStatistics,
    validateEntries,
    cleanText
  };
}
