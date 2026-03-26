/**
 * Parser для извлечения реплик из markdown-текста
 * Поддерживает как заголовки (**Speaker**:\nText), так и inline-стиль (**Speaker**: Text).
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
  return name.replace(/\s+\d+$/, '');
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
    sourceTag: ''
  };

  const headerRegex = /^(?:\\)?\*\*(?:\\)?\*?(.+?)(?:\\)?\*?(?:\\)?\*\*(?:\s*:)?(.*)$/;

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
      }
      continue;
    }

    const headerMatch = line.match(headerRegex);

    if (headerMatch) {
      finalizeCurrentEntry();

      let rawSpeaker = headerMatch[1].trim();
      let inlineText = headerMatch[2] ? headerMatch[2].trim() : '';
      let finalSpeaker = normalizeSpeakerName(rawSpeaker);

      currentEntry = {
        id: `${finalSpeaker.replace(/\s+/g, '_')}-${i}`,
        speaker: finalSpeaker,
        originalTag: rawSpeaker, // Сохраняем полный оригинальный тег
        languageCode: currentContext.languageCode || '',
        minimaxLanguage: currentContext.minimaxLanguage || '',
        niche: currentContext.niche || '',
        packId: currentContext.packId || '',
        sourceTag: currentContext.sourceTag || '',
        text: inlineText,
        preview: ''
      };
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
