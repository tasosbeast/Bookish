import { validateSourceEntry } from './contracts.js';
import { normalizeAuthorName, normalizeTitle } from './normalize.js';

const TITLE_STOP_WORDS = new Set(['a', 'an', 'and', 'of', 'or', 'the']);
const DISALLOWED_VARIANTS = [
  ['study_guide', /\bstudy\s+guides?\b/],
  ['summary', /\b(?:summary|summaries)\b/],
  ['companion', /\bcompanions?\b/],
  ['graphic_adaptation', /\bgraphic\s+(?:adaptations?|novels?)\b|\bcomic\s+adaptations?\b/],
  ['collection', /\b(?:omnibus|complete\s+collection|collected\s+works|box(?:ed)?\s+set)\b/],
];

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

function tokens(value) {
  return normalizeTitle(value).split(' ').filter(token => token && !TITLE_STOP_WORDS.has(token));
}

function sourceTitleVariants(value) {
  const full = normalizeTitle(value);
  const separator = value.search(/[:：]/);
  const base = separator > 0 ? normalizeTitle(value.slice(0, separator)) : '';
  return [...new Set([full, base].filter(Boolean))];
}

function setMetrics(sourceTokens, candidateTokens) {
  const source = new Set(sourceTokens);
  const candidate = new Set(candidateTokens);
  const overlap = [...source].filter(token => candidate.has(token)).length;
  return {
    overlap,
    recall: source.size ? overlap / source.size : 0,
    precision: candidate.size ? overlap / candidate.size : 0,
    jaccard: source.size + candidate.size - overlap ? overlap / (source.size + candidate.size - overlap) : 0,
  };
}

function foldedDisplay(value) {
  return text(value)?.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() ?? '';
}

export function disallowedVariant(sourceTitle, candidate) {
  const source = foldedDisplay(sourceTitle);
  const candidateText = foldedDisplay([candidate?.title, candidate?.subtitle].filter(Boolean).join(' '));
  for (const [code, pattern] of DISALLOWED_VARIANTS) {
    if (pattern.test(candidateText) && !pattern.test(source)) return code;
  }
  return null;
}

export function matchTitle(sourceTitle, candidateTitle) {
  const sourceVariants = sourceTitleVariants(sourceTitle);
  const normalizedCandidate = normalizeTitle(candidateTitle);
  if (!sourceVariants.length || !normalizedCandidate) {
    return { eligible: false, score: 0, kind: 'missing', source: sourceVariants[0] ?? '', candidate: normalizedCandidate, metrics: null };
  }
  if (normalizedCandidate === sourceVariants[0]) {
    return { eligible: true, score: 100, kind: 'exact', source: sourceVariants[0], candidate: normalizedCandidate, metrics: { overlap: tokens(sourceTitle).length, recall: 1, precision: 1, jaccard: 1 } };
  }
  if (sourceVariants.slice(1).includes(normalizedCandidate)) {
    return { eligible: true, score: 96, kind: 'source_subtitle_omitted', source: sourceVariants[0], candidate: normalizedCandidate, metrics: null };
  }

  const sourceTokens = tokens(sourceVariants[0]);
  const candidateTokens = tokens(normalizedCandidate);
  const metrics = setMetrics(sourceTokens, candidateTokens);
  if (sourceTokens.length === candidateTokens.length && metrics.overlap === sourceTokens.length) {
    return { eligible: true, score: 92, kind: 'token_exact', source: sourceVariants[0], candidate: normalizedCandidate, metrics };
  }

  const generic = sourceTokens.length === 1 || sourceVariants[0].length <= 5;
  const strong = !generic && metrics.overlap >= 2 && metrics.recall >= 0.8 && metrics.precision >= 0.75 && metrics.jaccard >= 0.65;
  return {
    eligible: strong,
    score: strong ? Math.round(80 + metrics.jaccard * 10) : Math.round(metrics.jaccard * 79),
    kind: strong ? 'strong_tokens' : generic ? 'generic_title_requires_exact' : 'weak_tokens',
    source: sourceVariants[0],
    candidate: normalizedCandidate,
    metrics,
  };
}

function authorTokens(value) {
  return normalizeAuthorName(value).split(' ').filter(Boolean);
}

function sameOrInitial(left, right) {
  return left === right || left.length === 1 && right.startsWith(left) || right.length === 1 && left.startsWith(right);
}

export function matchAuthor(sourceAuthor, candidateAuthors) {
  const source = normalizeAuthorName(sourceAuthor);
  const primary = Array.isArray(candidateAuthors) ? candidateAuthors[0] : candidateAuthors;
  const candidate = normalizeAuthorName(primary);
  if (!source || !candidate) return { eligible: false, score: 0, kind: 'missing', source, candidate };
  if (source === candidate) return { eligible: true, score: 100, kind: 'exact', source, candidate };

  const sourceParts = authorTokens(source);
  const candidateParts = authorTokens(candidate);
  const sourceFirst = sourceParts[0];
  const candidateFirst = candidateParts[0];
  const sameSurname = sourceParts.at(-1) === candidateParts.at(-1);
  const strong = sameSurname && Boolean(sourceFirst && candidateFirst && sameOrInitial(sourceFirst, candidateFirst));
  return { eligible: strong, score: strong ? 90 : 0, kind: strong ? 'strong_name' : 'mismatch', source, candidate };
}

export function matchWork(sourceValue, candidate) {
  const source = validateSourceEntry(sourceValue);
  const titleMatch = matchTitle(source.title, candidate?.title);
  const authorMatch = matchAuthor(source.author, candidate?.authors);
  const variant = disallowedVariant(source.title, candidate);
  const reasons = [];
  if (variant) reasons.push(`rejected_${variant}`);
  reasons.push(`title_${titleMatch.kind}`, `author_${authorMatch.kind}`);
  const eligible = !variant && titleMatch.eligible && authorMatch.eligible;
  return {
    eligible,
    score: eligible ? Math.round(titleMatch.score * 0.7 + authorMatch.score * 0.3) : 0,
    titleMatch,
    authorMatch,
    reasons,
  };
}
