(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VoiceMappingResolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function normalize(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(value) {
    return normalize(value).match(/[\p{L}\p{N}]+/gu) || [];
  }

  function getProjectId(speaker, projectAliases = {}) {
    const match = String(speaker || '').toUpperCase().match(/\b(VSL[DL]-\d+)\b/);
    if (!match) return '';
    return projectAliases[match[1]] || match[1];
  }

  /* Семейства ролей. Язык здесь НЕ участвует: он объявлен шапкой файла
     (`<!-- language_code: ES -->`), дублировать его в имени голоса не нужно.
     alternatives перебираются по порядку — побеждает первый непустой набор. */
  const ROLE_FAMILIES = [
    { words: ['doc', 'doctor', 'доктор', 'врач'] },
    { words: ['dic', 'dictor', 'диктор', 'репортер', 'reporter', 'ведущий', 'ведущая', 'host'] },
    { words: ['селеба', 'селеб', 'seleba', 'celebrity', 'celebridad'] },
  ];

  /* Пол в метке отзыва: русские, украинские и английские слова.
     label — каноничная (русская) форма: имя голоса может быть названо
     и по-украински, и по-русски — подойдут оба варианта. */
  const GENDER_FORMS = [
    { re: /^(?:муж(?:чина)?|male|man)$/u, label: 'мужчина' },
    { re: /^(?:жен(?:щина)?|female|woman)$/u, label: 'женщина' },
    { re: /^чолов[іи]к$/u, label: 'мужчина' },
    { re: /^ж[іи]нка$/u, label: 'женщина' },
  ];

  function findGender(token) {
    return GENDER_FORMS.find((form) => form.re.test(token)) || null;
  }

  function getRole(speaker) {
    const speakerTokens = tokens(speaker);
    for (const family of ROLE_FAMILIES) {
      if (speakerTokens.some((token) => family.words.includes(token))) {
        return { type: 'primary', words: family.words, alternatives: family.words.map((word) => [word]) };
      }
    }

    const number = speakerTokens.find((token) => /^\d+$/.test(token)) || '';
    const genderToken = speakerTokens.find((token) => findGender(token)) || '';
    if (number && genderToken) {
      const form = findGender(genderToken);
      const forms = [...new Set([genderToken, form.label])];
      const alternatives = forms.flatMap((word) => [['отзыв', word, number], [word, number]]);
      return { type: 'testimonial', words: ['отзыв', ...forms], alternatives };
    }

    return { type: 'generic', words: [], alternatives: [speakerTokens] };
  }

  /* Имя в имени голоса может быть обрезано («Antonio de Lac» вместо «…de Lacy»,
     «Ribera Casa» вместо «…Casado») или склеено («MustafaEraslan») — сравниваем
     по равенству, по префиксу и по вхождению: короткий токен совпадает, если он
     длиной ≥3 и является началом другого токена или входит в него. */
  function tokenMatches(voiceTokens, needle) {
    if (voiceTokens.has(needle)) return true;
    if (needle.length < 3) return false;
    for (const token of voiceTokens) {
      if (token.length < 3) continue;
      if (token.startsWith(needle) || needle.startsWith(token) || token.includes(needle)) return true;
    }
    return false;
  }

  /* Сужаем найденный пул по «лишним» токенам тега: имя доктора
     (`Доктор Antonio de Lacy(70742038)`) должно оставить один голос, а не шесть.
     Фильтр применяется только если после него что-то осталось. */
  function narrow(matches, required) {
    if (!matches.length || !required.length) return matches;
    const next = matches.filter((voice) => {
      const tokenSet = new Set(tokens(voice?.voiceName));
      return required.every((token) => tokenMatches(tokenSet, token));
    });
    return next.length ? next : matches;
  }

  function findCandidates(speaker, languageCode, voices, prefix = 'mp', projectAliases = {}) {
    const role = getRole(speaker);
    const projectId = getProjectId(speaker, projectAliases);
    const speakerTokens = tokens(speaker);
    const baseTokens = tokens(prefix).map(normalize);

    const normalizedVoices = (Array.isArray(voices) ? voices : [])
      .filter((voice) => Number(voice?.voiceStatus) === 2);

    let matches = [];
    for (const alternative of role.alternatives) {
      if (!alternative.length) continue;
      const required = [...baseTokens, ...alternative].map(normalize);
      matches = normalizedVoices.filter((voice) => {
        const tokenSet = new Set(tokens(voice?.voiceName));
        return required.every((token) => tokenSet.has(token));
      });
      if (matches.length > 0) break;
    }
    if (!matches.length) return [];

    /* Порядок уточнений: имя из тега → код пака/карточки → язык.
       Язык идёт последним и только как уточнение между одинаковыми голосами. */
    const roleWords = new Set((role.words || []).flatMap((word) => tokens(word)));
    const nameTokens = [...new Set(speakerTokens.filter((token) => !/^\d+$/.test(token) && !roleWords.has(token)))];
    matches = narrow(matches, nameTokens);

    const idTokens = [...new Set(speakerTokens.filter((token) => /^\d+$/.test(token)))];
    matches = narrow(matches, projectId ? [...tokens(projectId), ...idTokens] : idTokens);

    if (languageCode) matches = narrow(matches, tokens(languageCode));

    return matches;
  }

  function resolveVoice(speaker, languageCode, voices, prefix = 'mp', projectAliases = {}) {
    const candidates = findCandidates(speaker, languageCode, voices, prefix, projectAliases);
    if (candidates.length === 1) return { status: 'ok', voice: candidates[0], candidates };
    if (candidates.length > 1) return { status: 'ambiguous', voice: null, candidates };
    return { status: 'missing', voice: null, candidates: [] };
  }

  function inspectPlan(plan, voices) {
    const liveVoices = Array.isArray(voices) ? voices : [];
    const byId = new Map(liveVoices.map((voice) => [String(voice?.voiceId || ''), voice]));
    const byName = new Map();
    liveVoices.forEach((voice) => {
      const name = normalize(voice?.voiceName);
      if (!name) return;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(voice);
    });

    const mappings = (Array.isArray(plan?.mappings) ? plan.mappings : []).map((mapping) => {
      const expectedId = String(mapping.voiceId || '');
      const expectedName = String(mapping.voiceName || '');
      if (!expectedId && !expectedName) return { ...mapping, status: 'missing', candidates: [] };

      if (expectedId) {
        const liveVoice = byId.get(expectedId);
        if (!liveVoice) return { ...mapping, status: 'stale', candidates: [] };
        if (Number(liveVoice.voiceStatus) !== 2) {
          return { ...mapping, status: 'unavailable', candidates: [liveVoice] };
        }
        return {
          ...mapping,
          status: 'ok',
          voiceId: String(liveVoice.voiceId || ''),
          voiceName: String(liveVoice.voiceName || ''),
          candidates: [liveVoice]
        };
      }

      const nameMatches = byName.get(normalize(expectedName)) || [];
      if (nameMatches.length > 1) return { ...mapping, status: 'ambiguous', candidates: nameMatches };
      if (nameMatches.length === 1 && Number(nameMatches[0].voiceStatus) === 2) {
        return {
          ...mapping,
          status: 'ok',
          voiceId: String(nameMatches[0].voiceId || ''),
          voiceName: String(nameMatches[0].voiceName || ''),
          candidates: nameMatches
        };
      }
      if (nameMatches.length === 1) return { ...mapping, status: 'unavailable', candidates: nameMatches };

      return { ...mapping, status: 'not_found', candidates: [] };
    });
    const count = (status) => mappings.filter((mapping) => mapping.status === status).length;
    return {
      valid: mappings.length > 0 && mappings.every((mapping) => mapping.status === 'ok'),
      totals: {
        files: Number(plan?.fileCount || 0),
        entries: mappings.reduce((sum, mapping) => sum + Number(mapping.entryCount || 0), 0),
        mappings: mappings.length,
        ok: count('ok'),
        missing: count('missing'),
        stale: count('stale'),
        unavailable: count('unavailable'),
        ambiguous: count('ambiguous'),
        notFound: count('not_found')
      },
      mappings
    };
  }

  return { normalize, tokens, getProjectId, getRole, findCandidates, resolveVoice, inspectPlan };
});
