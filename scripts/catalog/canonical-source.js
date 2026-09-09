import {
  CatalogContractError,
  CANONICAL_SOURCE_CONTRACT_VERSION,
  validateSourceEntry,
} from './contracts.js';
import { normalizeDisplayText, normalizeIsbn13 } from './normalize.js';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function object(value, name) {
  if (!plainObject(value)) fail('malformed_canonical_value', `${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('unexpected_canonical_field', `${name} contains unexpected field ${key}`);
}

function requiredText(value, name) {
  try { return normalizeDisplayText(value, name); }
  catch { fail('malformed_canonical_value', `${name} must be a non-empty string`); }
}

function optionalText(value, name) {
  if (value === undefined || value === null) return null;
  return requiredText(value, name);
}

function optionalYear(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1000 || value > new Date().getFullYear() + 1) fail('invalid_canonical_year', 'publicationYear must be a valid year or null');
  return value;
}

function validateCover(value) {
  if (value === undefined || value === null) return null;
  const cover = object(value, 'cover');
  exactKeys(cover, ['url', 'reference'], 'cover');
  if (!own(cover, 'url') && !own(cover, 'reference')) fail('invalid_canonical_cover', 'cover requires a URL or reference');
  const url = own(cover, 'url') ? optionalText(cover.url, 'cover.url') : null;
  if (url !== null) {
    try { if (new URL(url).protocol !== 'https:') throw new Error(); }
    catch { fail('invalid_canonical_cover', 'cover.url must be an HTTPS URL or null'); }
  }
  const reference = own(cover, 'reference') ? optionalText(cover.reference, 'cover.reference') : null;
  if (url === null && reference === null) fail('invalid_canonical_cover', 'cover requires a URL or reference');
  return { url, reference };
}

function validateStringArray(value, name, { required = false } = {}) {
  if ((value === undefined || value === null) && !required) return [];
  if (!Array.isArray(value)) fail('malformed_canonical_value', `${name} must be an array`);
  const normalized = value.map(item => requiredText(item, name));
  if (required && !normalized.length) fail('malformed_canonical_value', `${name} must not be empty`);
  if (new Set(normalized).size !== normalized.length) fail('malformed_canonical_value', `${name} must not contain duplicates`);
  return normalized;
}

function validateSourceIdentifiers(value) {
  if (value === undefined || value === null) return {};
  const identifiers = object(value, 'sourceIdentifiers');
  for (const [name, identifier] of Object.entries(identifiers)) {
    requiredText(name, 'sourceIdentifiers key');
    requiredText(identifier, `sourceIdentifiers.${name}`);
  }
  return { ...identifiers };
}

export function validateCanonicalCandidate(value) {
  const candidate = object(value, 'Canonical candidate');
  exactKeys(candidate, [
    'recordId', 'snapshotId', 'sourceName', 'isbn13', 'title', 'subtitle', 'authors', 'language', 'publisher',
    'publicationDate', 'publicationYear', 'format', 'cover', 'description', 'subjects', 'sourceIdentifiers',
  ], 'Canonical candidate');
  let isbn13;
  try { isbn13 = normalizeIsbn13(candidate.isbn13); }
  catch { fail('invalid_canonical_isbn', 'isbn13 must be a valid ISBN-13'); }
  return {
    recordId: requiredText(candidate.recordId, 'recordId'),
    snapshotId: requiredText(candidate.snapshotId, 'snapshotId'),
    sourceName: requiredText(candidate.sourceName, 'sourceName'),
    isbn13,
    title: requiredText(candidate.title, 'title'),
    subtitle: optionalText(candidate.subtitle, 'subtitle'),
    authors: validateStringArray(candidate.authors, 'authors', { required: true }),
    language: optionalText(candidate.language, 'language'),
    publisher: optionalText(candidate.publisher, 'publisher'),
    publicationDate: optionalText(candidate.publicationDate, 'publicationDate'),
    publicationYear: optionalYear(candidate.publicationYear),
    format: optionalText(candidate.format, 'format'),
    cover: validateCover(candidate.cover),
    description: optionalText(candidate.description, 'description'),
    subjects: validateStringArray(candidate.subjects, 'subjects'),
    sourceIdentifiers: validateSourceIdentifiers(candidate.sourceIdentifiers),
  };
}

export function validateCanonicalSourceAdapter(value) {
  const adapter = object(value, 'Canonical source adapter');
  exactKeys(adapter, ['sourceName', 'getCandidates'], 'Canonical source adapter');
  const sourceName = requiredText(adapter.sourceName, 'sourceName');
  if (typeof adapter.getCandidates !== 'function') fail('invalid_canonical_adapter', 'getCandidates must be a function');
  return { sourceName, getCandidates: adapter.getCandidates };
}

export async function getCanonicalCandidates(adapterValue, sourceValue) {
  const adapter = validateCanonicalSourceAdapter(adapterValue);
  const source = validateSourceEntry(sourceValue);
  const candidates = await adapter.getCandidates(source);
  if (!Array.isArray(candidates)) fail('invalid_canonical_adapter_result', 'getCandidates must return an array');
  return candidates.map(candidate => {
    const normalized = validateCanonicalCandidate(candidate);
    if (normalized.sourceName !== adapter.sourceName) fail('canonical_source_mismatch', 'Candidate sourceName must match its adapter');
    return normalized;
  });
}

export function evaluateCanonicalIdentity(sourceValue, candidateValue) {
  const source = validateSourceEntry(sourceValue);
  const candidate = validateCanonicalCandidate(candidateValue);
  if (source.pinnedIsbn13 && candidate.isbn13 !== source.pinnedIsbn13) {
    return { status: 'needs_review', code: 'pinned_isbn_mismatch', expectedIsbn13: source.pinnedIsbn13, candidateIsbn13: candidate.isbn13 };
  }
  if (source.preferredIsbn13 && !source.allowAlternateIsbn && candidate.isbn13 !== source.preferredIsbn13) {
    return { status: 'needs_review', code: 'preferred_isbn_mismatch', expectedIsbn13: source.preferredIsbn13, candidateIsbn13: candidate.isbn13 };
  }
  return { status: 'eligible', code: null, expectedIsbn13: source.pinnedIsbn13 ?? source.preferredIsbn13 ?? null, candidateIsbn13: candidate.isbn13 };
}

export function canonicalFieldProvenance(candidateValue, sourceField, { enrichmentSource = null } = {}) {
  const candidate = validateCanonicalCandidate(candidateValue);
  return {
    sourceName: candidate.sourceName,
    snapshotId: candidate.snapshotId,
    recordId: candidate.recordId,
    sourceField: requiredText(sourceField, 'sourceField'),
    enrichmentSource: enrichmentSource === null ? null : requiredText(enrichmentSource, 'enrichmentSource'),
  };
}

export function validateCanonicalFieldProvenance(value) {
  const provenance = object(value, 'Canonical field provenance');
  exactKeys(provenance, ['sourceName', 'snapshotId', 'recordId', 'sourceField', 'enrichmentSource'], 'Canonical field provenance');
  return {
    sourceName: requiredText(provenance.sourceName, 'sourceName'),
    snapshotId: requiredText(provenance.snapshotId, 'snapshotId'),
    recordId: requiredText(provenance.recordId, 'recordId'),
    sourceField: requiredText(provenance.sourceField, 'sourceField'),
    enrichmentSource: provenance.enrichmentSource === null ? null : requiredText(provenance.enrichmentSource, 'enrichmentSource'),
  };
}

export function validateOptionalEnrichment(value) {
  const enrichment = object(value, 'Optional enrichment');
  exactKeys(enrichment, ['sourceName', 'cover', 'description', 'subjects'], 'Optional enrichment');
  return {
    sourceName: requiredText(enrichment.sourceName, 'sourceName'),
    cover: validateCover(enrichment.cover),
    description: optionalText(enrichment.description, 'description'),
    subjects: validateStringArray(enrichment.subjects, 'subjects'),
  };
}

export function mergeOptionalEnrichment(candidateValue, enrichmentValue = null) {
  const candidate = validateCanonicalCandidate(candidateValue);
  const enrichment = enrichmentValue === null ? null : validateOptionalEnrichment(enrichmentValue);
  const description = candidate.description ?? enrichment?.description ?? null;
  const cover = candidate.cover ?? enrichment?.cover ?? null;
  const subjects = candidate.subjects.length ? candidate.subjects : enrichment?.subjects ?? [];
  const provenance = (field, enriched) => canonicalFieldProvenance(candidate, field, {
    enrichmentSource: enriched ? enrichment.sourceName : null,
  });
  return {
    metadata: {
      isbn: candidate.isbn13,
      title: candidate.title,
      author: candidate.authors.join(', '),
      publicationYear: candidate.publicationYear,
      description,
      coverImageUrl: cover?.url ?? null,
      subjects,
    },
    provenance: {
      isbn: provenance('isbn13', false),
      title: provenance('title', false),
      author: provenance('authors', false),
      publicationYear: candidate.publicationYear === null ? null : provenance('publicationYear', false),
      description: description === null ? null : provenance(candidate.description === null ? 'enrichment.description' : 'description', candidate.description === null),
      coverImageUrl: cover?.url == null ? null : provenance(candidate.cover === null ? 'enrichment.cover' : 'cover', candidate.cover === null),
      subjects: subjects.length ? provenance(candidate.subjects.length ? 'subjects' : 'enrichment.subjects', !candidate.subjects.length) : null,
    },
  };
}

export { CANONICAL_SOURCE_CONTRACT_VERSION };
