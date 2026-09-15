import { validateSourceEntry, validateSourceManifest } from './contracts.js';
import { mapGenres } from '../catalog.js';
import { evaluateEdition, selectEdition } from './score-editions.js';

export const PILOT_PLAN_VERSION = 1;

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

export function isExactGregorianDay(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function classifyPublicationDatePrecision(publicationDateStr, publicationYear) {
  if (isExactGregorianDay(publicationDateStr)) return 'exact_day';
  if ((typeof publicationDateStr === 'string' && publicationDateStr.trim().length > 0) || Number.isInteger(publicationYear)) {
    return 'year_or_partial';
  }
  return 'unknown';
}

export function pilotDisqualificationReason(candidate) {
  const format = text(candidate?.format)?.toLowerCase() ?? '';
  const title = [candidate?.title, candidate?.subtitle].map(text).filter(Boolean).join(' ').toLowerCase();

  // 1. Audio / Audiobook / Sound Recording
  if (/\b(?:audiobook|audio\s*cd|sound\s+recording|compact\s+disc|cassette|audio\s+cassette|mp3(?:\s*cd)?|spoken\s+word)\b/.test(format)
      || /\b(?:audiobook|audio\s*cd|sound\s+recording|audio\s+cassette|spoken\s+word)\b/.test(title)) {
    return 'audiobook';
  }

  // 2. Ebook / Electronic / Digital edition
  if (/\b(?:ebook|e-book|electronic|digital|kindle|epub|pdf|mobi|online\s+resource|nook)\b/.test(format)
      || /\b(?:ebook|e-book|electronic\s+resource|kindle\s+edition)\b/.test(title)) {
    return 'ebook';
  }

  // 3. Large Print
  if (/\b(?:large\s+print|giant\s+print|lp)\b/.test(format)
      || /\b(?:large\s+print|giant\s+print)\b/.test(title)) {
    return 'large_print';
  }

  // 4. Boxed Set / Multi-book Pack
  if (/\b(?:boxed\s+set|box\s+set|slipcase|pack|bundle|boxset)\b/.test(format)
      || /\b(?:boxed\s+set|box\s+set|boxset|\d+\s+books?\s+set|\d+\s+volumes?\s+set|collection\s+set)\b/.test(title)) {
    return 'boxed_set';
  }

  // 5. Calendar
  if (/\bcalendar\b/.test(format) || /\bcalendar\b/.test(title)) {
    return 'calendar';
  }

  // 6. Journal / Diary / Notebook
  if (/\b(?:journal|diary|blank\s+book|notebook|dayplanner|agenda)\b/.test(format)
      || /\b(?:blank\s+journal|ruled\s+journal|lined\s+journal|day\s+planner|guided\s+journal)\b/.test(title)) {
    return 'journal';
  }

  // 7. Cards / Deck / Tarot
  if (/\b(?:cards?|flashcards?|deck|tarot|playing\s+cards)\b/.test(format)
      || /\b(?:card\s+deck|tarot\s+deck|flash\s*cards?|playing\s+cards)\b/.test(title)) {
    return 'cards';
  }

  // 8. Puzzle / Game / Toy / Non-book merchandise
  if (/\b(?:puzzle|game|board\s+game|toy|doll|kit|poster|stationery|merchandise|accessory)\b/.test(format)
      || /\b(?:jigsaw\s+puzzle|board\s+game|coloring\s+poster|plush\s+toy)\b/.test(title)) {
    return 'non_book';
  }

  return null;
}

export function adaptCanonicalCandidateForScoring(canonicalCandidate) {
  const coverImageUrls = [];
  if (canonicalCandidate.cover?.url) {
    coverImageUrls.push(canonicalCandidate.cover.url);
  } else if (canonicalCandidate.cover?.reference) {
    coverImageUrls.push(canonicalCandidate.cover.reference);
  }

  return {
    isbn13: [canonicalCandidate.isbn13],
    title: canonicalCandidate.title,
    subtitle: canonicalCandidate.subtitle,
    authors: canonicalCandidate.authors,
    languages: canonicalCandidate.language ? [canonicalCandidate.language] : [],
    publishers: canonicalCandidate.publisher ? [canonicalCandidate.publisher] : [],
    formats: canonicalCandidate.format ? [canonicalCandidate.format] : [],
    descriptions: canonicalCandidate.description ? [canonicalCandidate.description] : [],
    publicationYears: canonicalCandidate.publicationYear ? [canonicalCandidate.publicationYear] : [],
    coverImageUrls,
    providerIds: {
      recordId: canonicalCandidate.recordId,
      editionId: canonicalCandidate.sourceIdentifiers?.openLibraryEdition ?? canonicalCandidate.recordId,
      workId: canonicalCandidate.sourceIdentifiers?.openLibraryWorks ?? null,
    },
    _canonical: canonicalCandidate,
  };
}

export async function evaluateSourceEntry(adapter, rawSource) {
  const source = validateSourceEntry(rawSource);
  const canonicalCandidates = await adapter.getCandidates(source);

  if (!canonicalCandidates.length) {
    return {
      key: source.key,
      status: 'no_match',
      reason: 'no_candidates_found',
      candidateCount: 0,
      requested: {
        key: source.key,
        title: source.title,
        author: source.author,
      },
      selection: null,
      quality: null,
      evaluations: [],
    };
  }

  const evaluations = [];
  const eligibleAdaptedCandidates = [];

  for (const canonical of canonicalCandidates) {
    const disqualifier = pilotDisqualificationReason(canonical);
    if (disqualifier) {
      evaluations.push({
        candidate: canonical,
        eligible: false,
        score: 0,
        isbn: canonical.isbn13,
        preferredIsbnMatch: false,
        reasons: [`rejected_${disqualifier}`],
      });
      continue;
    }

    const adapted = adaptCanonicalCandidateForScoring(canonical);
    const evalResult = evaluateEdition(source, adapted);
    evaluations.push({
      candidate: canonical,
      eligible: evalResult.eligible,
      score: evalResult.score,
      isbn: evalResult.isbn,
      preferredIsbnMatch: evalResult.preferredIsbnMatch,
      reasons: evalResult.reasons,
    });

    if (evalResult.eligible) {
      eligibleAdaptedCandidates.push(adapted);
    }
  }

  if (!eligibleAdaptedCandidates.length) {
    return {
      key: source.key,
      status: 'no_match',
      reason: 'no_eligible_editions',
      candidateCount: canonicalCandidates.length,
      requested: {
        key: source.key,
        title: source.title,
        author: source.author,
      },
      selection: null,
      quality: null,
      evaluations,
    };
  }

  const selectionResult = selectEdition(source, eligibleAdaptedCandidates);

  if (selectionResult.status === 'selected') {
    const winningIsbn = selectionResult.isbn;
    if (source.pinnedIsbn13 && winningIsbn !== source.pinnedIsbn13) {
      return {
        key: source.key,
        status: 'needs_review',
        reason: 'pinned_isbn_mismatch',
        candidateCount: canonicalCandidates.length,
        requested: {
          key: source.key,
          title: source.title,
          author: source.author,
        },
        selection: null,
        quality: null,
        evaluations,
      };
    }
    if (source.preferredIsbn13 && !source.allowAlternateIsbn && winningIsbn !== source.preferredIsbn13) {
      return {
        key: source.key,
        status: 'needs_review',
        reason: 'preferred_isbn_mismatch',
        candidateCount: canonicalCandidates.length,
        requested: {
          key: source.key,
          title: source.title,
          author: source.author,
        },
        selection: null,
        quality: null,
        evaluations,
      };
    }

    const canonical = selectionResult.selected._canonical;
    const mappedGenres = mapGenres(canonical.subjects).map(g => g.slug);
    const datePrecision = classifyPublicationDatePrecision(canonical.publicationDate, canonical.publicationYear);

    const openLibraryWorks = canonical.sourceIdentifiers?.openLibraryWorks
      ? canonical.sourceIdentifiers.openLibraryWorks.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    return {
      key: source.key,
      status: 'selected',
      reason: selectionResult.reason,
      candidateCount: canonicalCandidates.length,
      requested: {
        key: source.key,
        title: source.title,
        author: source.author,
      },
      selection: {
        key: source.key,
        requestedTitle: source.title,
        requestedAuthor: source.author,
        isbn13: canonical.isbn13,
        recordId: canonical.recordId,
        openLibraryEdition: canonical.sourceIdentifiers?.openLibraryEdition ?? canonical.recordId,
        openLibraryWorks: openLibraryWorks.length ? openLibraryWorks : null,
        title: canonical.title,
        subtitle: canonical.subtitle ?? null,
        authors: canonical.authors,
        language: canonical.language ?? null,
        publisher: canonical.publisher ?? null,
        format: canonical.format ?? null,
        publicationYear: canonical.publicationYear ?? null,
        publicationDate: canonical.publicationDate ?? null,
        score: selectionResult.score,
        reasons: selectionResult.reasons,
        candidateCount: canonicalCandidates.length,
      },
      quality: {
        hasCover: Boolean(canonical.cover?.url || canonical.cover?.reference),
        hasPublisher: Boolean(canonical.publisher),
        hasMappedGenre: mappedGenres.length > 0,
        mappedGenres,
        publicationDatePrecision: datePrecision,
      },
      evaluations,
    };
  }

  if (selectionResult.status === 'needs_review') {
    return {
      key: source.key,
      status: 'needs_review',
      reason: selectionResult.reason,
      candidateCount: canonicalCandidates.length,
      requested: {
        key: source.key,
        title: source.title,
        author: source.author,
      },
      selection: null,
      quality: null,
      evaluations,
    };
  }

  return {
    key: source.key,
    status: 'no_match',
    reason: selectionResult.reason,
    candidateCount: canonicalCandidates.length,
    requested: {
      key: source.key,
      title: source.title,
      author: source.author,
    },
    selection: null,
    quality: null,
    evaluations,
  };
}

export function generatePilotSummary(entries) {
  const summary = {
    requestedWorks: entries.length,
    selected: 0,
    needsReview: 0,
    noMatch: 0,
    candidateCount: 0,
    rejectedByReason: {},
    selectedQuality: {
      withCover: 0,
      withoutCover: 0,
      withPublisher: 0,
      withoutPublisher: 0,
      withMappedGenre: 0,
      withoutMappedGenre: 0,
      exactPublicationDate: 0,
      yearOrPartialPublicationDate: 0,
      unknownPublicationDate: 0,
    },
    selectionConfidence: {
      minScore: null,
      medianScore: null,
      maxScore: null,
      lowConfidenceCount: 0,
    },
  };

  const scores = [];

  for (const entry of entries) {
    summary.candidateCount += entry.candidateCount;

    if (entry.status === 'selected') {
      summary.selected += 1;
      const q = entry.quality;
      if (q.hasCover) summary.selectedQuality.withCover += 1;
      else summary.selectedQuality.withoutCover += 1;

      if (q.hasPublisher) summary.selectedQuality.withPublisher += 1;
      else summary.selectedQuality.withoutPublisher += 1;

      if (q.hasMappedGenre) summary.selectedQuality.withMappedGenre += 1;
      else summary.selectedQuality.withoutMappedGenre += 1;

      if (q.publicationDatePrecision === 'exact_day') {
        summary.selectedQuality.exactPublicationDate += 1;
      } else if (q.publicationDatePrecision === 'year_or_partial') {
        summary.selectedQuality.yearOrPartialPublicationDate += 1;
      } else {
        summary.selectedQuality.unknownPublicationDate += 1;
      }

      scores.push(entry.selection.score);
      if (entry.selection.score < 65) {
        summary.selectionConfidence.lowConfidenceCount += 1;
      }
    } else if (entry.status === 'needs_review') {
      summary.needsReview += 1;
      summary.selectionConfidence.lowConfidenceCount += 1;
    } else {
      summary.noMatch += 1;
    }

    for (const ev of entry.evaluations ?? []) {
      if (!ev.eligible) {
        for (const r of ev.reasons ?? []) {
          summary.rejectedByReason[r] = (summary.rejectedByReason[r] ?? 0) + 1;
        }
      }
    }
  }

  if (scores.length > 0) {
    scores.sort((a, b) => a - b);
    summary.selectionConfidence.minScore = scores[0];
    summary.selectionConfidence.maxScore = scores[scores.length - 1];
    const mid = Math.floor(scores.length / 2);
    summary.selectionConfidence.medianScore = scores.length % 2 === 1
      ? scores[mid]
      : (scores[mid - 1] + scores[mid]) / 2;
  }

  return summary;
}

export async function planCatalogPilot({ sources, adapter }) {
  const sourceEntries = validateSourceManifest(sources);
  const entries = [];
  for (const source of sourceEntries) {
    const result = await evaluateSourceEntry(adapter, source);
    const { evaluations, ...entry } = result;
    entry._evaluations = evaluations;
    entries.push(entry);
  }

  const summary = generatePilotSummary(entries.map(e => ({ ...e, evaluations: e._evaluations })));
  const cleanEntries = entries.map(({ _evaluations, ...e }) => e);

  return {
    planVersion: PILOT_PLAN_VERSION,
    summary,
    entries: cleanEntries,
  };
}
