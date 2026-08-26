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

  function getRole(speaker) {
    const speakerTokens = tokens(speaker);
    if (speakerTokens.some((token) => ['doc', 'doctor', 'доктор'].includes(token))) {
      return { type: 'primary', alternatives: [['doc'], ['doctor'], ['доктор']] };
    }
    if (speakerTokens.some((token) => ['dic', 'dictor', 'диктор', 'репортер', 'reporter'].includes(token))) {
      return { type: 'primary', alternatives: [['dic'], ['dictor'], ['диктор'], ['репортер'], ['reporter']] };
    }

    const number = speakerTokens.find((token) => /^\d+$/.test(token)) || '';
    const gender = speakerTokens.find((token) => /^(?:муж(?:чина)?|жен(?:щина)?)$/u.test(token)) || '';
    if (number && gender) {
      const normalizedGender = /^муж/u.test(gender) ? 'мужчина' : 'женщина';
      return {
        type: 'testimonial',
        alternatives: [
          ['отзыв', normalizedGender, number],
          [normalizedGender, number]
        ]
      };
    }

    return { type: 'generic', alternatives: [speakerTokens] };
  }

  function findCandidates(speaker, languageCode, voices, prefix = 'mp', projectAliases = {}) {
    const role = getRole(speaker);
    const projectId = getProjectId(speaker, projectAliases);
    const baseTokens = tokens(prefix);
    if (role.type === 'primary') {
      if (projectId) baseTokens.push(...tokens(projectId));
      else if (languageCode) baseTokens.push(...tokens(languageCode));
      else return [];
    } else if (languageCode) {
      baseTokens.push(...tokens(languageCode));
    }

    const normalizedVoices = (Array.isArray(voices) ? voices : [])
      .filter((voice) => Number(voice?.voiceStatus) === 2)
      .map((voice) => ({
      voice,
      tokenSet: new Set(tokens(voice?.voiceName))
      }));
    for (const alternative of role.alternatives) {
      if (!alternative.length) continue;
      const required = [...baseTokens, ...alternative].map(normalize);
      const matches = normalizedVoices
        .filter(({ tokenSet }) => required.every((token) => tokenSet.has(token)))
        .map(({ voice }) => voice);
      if (matches.length > 0) return matches;
    }
    return [];
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
