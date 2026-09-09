import { validateSourceEntry } from './contracts.js';
import { matchAuthor, matchTitle, disallowedVariant } from './match.js';
import { normalizeIsbn13 } from './normalize.js';

export const MIN_EDITION_SCORE = 55;
export const MIN_WINNER_MARGIN = 8;

export const EDITION_SCORE_WEIGHTS = Object.freeze({
  preferredIsbn: 40,
  titleExact: 35,
  titleSubtitleOmitted: 32,
  titleTokenExact: 30,
  titleStrongTokens: 25,
  titleInheritedWork: 20,
  authorExact: 25,
  authorStrong: 20,
  authorInherited: 15,
  english: 10,
  tradeFormat: 8,
  cover: 5,
  description: 4,
  publicationYear: 3,
  libraryBinding: -12,
  largePrint: -8,
});

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const values = value => (Array.isArray(value) ? value : []).map(text).filter(Boolean);

function validIsbns(candidate) {
  const result = [];
  for (const value of Array.isArray(candidate?.isbn13) ? candidate.isbn13 : []) {
    try { result.push(normalizeIsbn13(value)); } catch { /* Invalid identifiers make no edition eligible. */ }
  }
  return [...new Set(result)].sort();
}

function isEnglish(value) {
  const language = value.toLowerCase().replace('_', '-');
  return language === 'en' || language === 'eng' || language === 'english' || language.startsWith('en-');
}

function formatFlags(candidate) {
  const format = values(candidate?.formats).join(' ').toLowerCase();
  const title = [candidate?.title, candidate?.subtitle].map(text).filter(Boolean).join(' ').toLowerCase();
  const trade = /\b(?:trade\s+paperback|paperback|hardcover|hardback)\b/.test(format);
  const audio = /\b(?:audio(?:book|\s+book|\s+cd)?|audible|mp3\s+cd|cassette)\b/.test(`${format} ${title}`);
  return {
    trade,
    audioOnly: audio && !trade,
    libraryBinding: /\b(?:library|school)\s+binding\b|\bturtleback\b/.test(format),
    largePrint: /\blarge\s+print\b/.test(format),
  };
}

function metadataCompleteness(candidate) {
  return [
    text(candidate?.title), values(candidate?.authors).length, values(candidate?.languages).length,
    values(candidate?.publishers).length, values(candidate?.formats).length, values(candidate?.coverImageUrls).length,
    values(candidate?.descriptions).length, validPublicationYears(candidate).length,
  ].filter(Boolean).length;
}

function validPublicationYears(candidate) {
  return (Array.isArray(candidate?.publicationYears) ? candidate.publicationYears : [])
    .filter(year => Number.isInteger(year) && year >= 1000 && year <= new Date().getFullYear() + 1);
}

function titleWeight(kind) {
  return {
    exact: EDITION_SCORE_WEIGHTS.titleExact,
    source_subtitle_omitted: EDITION_SCORE_WEIGHTS.titleSubtitleOmitted,
    token_exact: EDITION_SCORE_WEIGHTS.titleTokenExact,
    strong_tokens: EDITION_SCORE_WEIGHTS.titleStrongTokens,
  }[kind] ?? 0;
}

function rejected(candidate, reason, details = {}) {
  return {
    candidate,
    eligible: false,
    score: 0,
    isbn: null,
    preferredIsbnMatch: false,
    metadataCompleteness: metadataCompleteness(candidate),
    reasons: [`rejected_${reason}`],
    ...details,
  };
}

export function evaluateEdition(sourceValue, candidate, { workMatch = null } = {}) {
  const source = validateSourceEntry(sourceValue);
  const isbns = validIsbns(candidate);
  if (!isbns.length) return rejected(candidate, 'missing_valid_isbn');

  const variant = disallowedVariant(source.title, candidate);
  if (variant) return rejected(candidate, variant, { isbn: isbns[0] });

  const formats = formatFlags(candidate);
  if (formats.audioOnly) return rejected(candidate, 'audio_only', { isbn: isbns[0] });

  const languages = values(candidate?.languages);
  if (languages.length && !languages.some(isEnglish)) return rejected(candidate, 'non_english', { isbn: isbns[0] });

  const titleMatch = matchTitle(source.title, candidate?.title);
  const inheritedWorkMatch = Boolean(workMatch?.eligible);
  if (!titleMatch.eligible && !(inheritedWorkMatch && !text(candidate?.title))) {
    return rejected(candidate, 'title_mismatch', { isbn: isbns[0], titleMatch });
  }

  const authors = values(candidate?.authors);
  const authorMatch = authors.length ? matchAuthor(source.author, authors) : null;
  if (authorMatch && !authorMatch.eligible) return rejected(candidate, 'author_mismatch', { isbn: isbns[0], titleMatch, authorMatch });

  const preferredIsbnMatch = Boolean(source.preferredIsbn13 && isbns.includes(source.preferredIsbn13));
  const isbn = preferredIsbnMatch ? source.preferredIsbn13 : isbns[0];
  const reasons = [];
  let score = 0;

  if (preferredIsbnMatch) { score += EDITION_SCORE_WEIGHTS.preferredIsbn; reasons.push('preferred_isbn'); }
  const titlePoints = titleMatch.eligible ? titleWeight(titleMatch.kind) : EDITION_SCORE_WEIGHTS.titleInheritedWork;
  score += titlePoints;
  reasons.push(`title_${titleMatch.eligible ? titleMatch.kind : 'inherited_work'}`);

  if (authorMatch?.kind === 'exact') { score += EDITION_SCORE_WEIGHTS.authorExact; reasons.push('author_exact'); }
  else if (authorMatch?.eligible) { score += EDITION_SCORE_WEIGHTS.authorStrong; reasons.push('author_strong'); }
  else if (inheritedWorkMatch) { score += EDITION_SCORE_WEIGHTS.authorInherited; reasons.push('author_inherited_work'); }
  else reasons.push('author_missing');

  if (languages.some(isEnglish)) { score += EDITION_SCORE_WEIGHTS.english; reasons.push('english'); }
  else reasons.push('language_unknown');
  if (formats.trade) { score += EDITION_SCORE_WEIGHTS.tradeFormat; reasons.push('trade_format'); }
  if (formats.libraryBinding) { score += EDITION_SCORE_WEIGHTS.libraryBinding; reasons.push('library_binding_penalty'); }
  if (formats.largePrint) { score += EDITION_SCORE_WEIGHTS.largePrint; reasons.push('large_print_penalty'); }
  if (values(candidate?.coverImageUrls).length) { score += EDITION_SCORE_WEIGHTS.cover; reasons.push('cover'); }
  if (values(candidate?.descriptions).length) { score += EDITION_SCORE_WEIGHTS.description; reasons.push('description'); }
  if (validPublicationYears(candidate).length) { score += EDITION_SCORE_WEIGHTS.publicationYear; reasons.push('publication_year'); }

  return {
    candidate,
    eligible: true,
    score,
    isbn,
    preferredIsbnMatch,
    metadataCompleteness: metadataCompleteness(candidate),
    titleMatch,
    authorMatch,
    reasons,
  };
}

function candidateIdentity(evaluation) {
  return JSON.stringify(evaluation.candidate?.providerIds ?? {});
}

function compareEvaluations(left, right) {
  return right.score - left.score
    || Number(right.preferredIsbnMatch) - Number(left.preferredIsbnMatch)
    || right.metadataCompleteness - left.metadataCompleteness
    || left.isbn.localeCompare(right.isbn)
    || candidateIdentity(left).localeCompare(candidateIdentity(right));
}

export function selectEdition(source, candidates, {
  workMatch = null,
  minimumScore = MIN_EDITION_SCORE,
  minimumMargin = MIN_WINNER_MARGIN,
} = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('Edition candidates must be an array');
  const evaluations = candidates.map(candidate => evaluateEdition(source, candidate, { workMatch }));
  const eligible = evaluations.filter(evaluation => evaluation.eligible).sort(compareEvaluations);
  if (!eligible.length) {
    return { status: 'no_match', reason: 'no_eligible_editions', selected: null, topCandidate: null, isbn: null, score: null, reasons: [], runnerUp: null, margin: null, evaluations };
  }

  const winner = eligible[0];
  const runnerUp = eligible[1] ?? null;
  const margin = runnerUp ? winner.score - runnerUp.score : null;
  if (winner.score < minimumScore) {
    return { status: 'needs_review', reason: 'below_minimum_score', selected: null, topCandidate: winner.candidate, isbn: winner.isbn, score: winner.score, reasons: winner.reasons, runnerUp, margin, evaluations };
  }
  if (runnerUp && margin < minimumMargin) {
    return { status: 'needs_review', reason: 'ambiguous_winner', selected: null, topCandidate: winner.candidate, isbn: winner.isbn, score: winner.score, reasons: winner.reasons, runnerUp, margin, evaluations };
  }
  return { status: 'selected', reason: 'clear_winner', selected: winner.candidate, topCandidate: winner.candidate, isbn: winner.isbn, score: winner.score, reasons: winner.reasons, runnerUp, margin, evaluations };
}
