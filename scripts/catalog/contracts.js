import { createHash } from 'node:crypto';
import {
  normalizeAuthorName,
  normalizeDisplayText,
  normalizeGenre,
  normalizeIsbn13,
  normalizeStableKey,
  normalizeTitle,
} from './normalize.js';

export const CATALOG_ARTIFACT_VERSION = 2;
export const CATALOG_RESOLVER_VERSION = 2;

export class CatalogContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogContractError';
    this.code = code;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function object(value, name) {
  if (!plainObject(value)) fail('malformed_value', `${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('unexpected_field', `${name} contains unexpected field ${key}`);
}

function requiredText(value, name) {
  try { return normalizeDisplayText(value, name); }
  catch { fail('malformed_value', `${name} must be a non-empty string`); }
}

function normalizedIsbn(value, name = 'preferredIsbn13') {
  try { return normalizeIsbn13(value); }
  catch { fail('invalid_isbn', `${name} must be a valid ISBN-13`); }
}

export function validateSourceEntry(value) {
  const entry = object(value, 'Source entry');
  exactKeys(entry, ['key', 'title', 'author', 'preferredIsbn13'], 'Source entry');
  const rawKey = requiredText(entry.key, 'key');
  const key = normalizeStableKey(rawKey);
  if (!key || rawKey !== key) fail('invalid_key', 'key must be a stable lowercase kebab-case string');
  const title = requiredText(entry.title, 'title');
  const author = requiredText(entry.author, 'author');
  const normalized = { key, title, author };
  if (own(entry, 'preferredIsbn13')) normalized.preferredIsbn13 = normalizedIsbn(entry.preferredIsbn13);
  return normalized;
}

export function sourceFingerprint(value) {
  const entry = validateSourceEntry(value);
  const meaningful = {
    key: entry.key,
    title: normalizeTitle(entry.title),
    author: normalizeAuthorName(entry.author),
    preferredIsbn13: entry.preferredIsbn13 ?? null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(meaningful)).digest('hex')}`;
}

function duplicateGroups(values, field) {
  const groups = new Map();
  values.forEach((value, index) => {
    if (value === undefined) return;
    const indexes = groups.get(value) ?? [];
    indexes.push(index);
    groups.set(value, indexes);
  });
  return [...groups].filter(([, indexes]) => indexes.length > 1).map(([value, indexes]) => ({ [field]: value, indexes }));
}

export function detectSourceDuplicates(entries) {
  if (!Array.isArray(entries)) fail('malformed_value', 'Source manifest must be an array');
  const normalized = entries.map(validateSourceEntry);
  return {
    keys: duplicateGroups(normalized.map(entry => entry.key), 'key'),
    preferredIsbn13: duplicateGroups(normalized.map(entry => entry.preferredIsbn13), 'isbn'),
    works: duplicateGroups(normalized.map(entry => `${normalizeTitle(entry.title)}\u0000${normalizeAuthorName(entry.author)}`), 'work'),
  };
}

export function validateSourceManifest(entries) {
  if (!Array.isArray(entries)) fail('malformed_value', 'Source manifest must be an array');
  const normalized = entries.map(validateSourceEntry);
  const duplicates = detectSourceDuplicates(normalized);
  if (duplicates.keys.length) fail('duplicate_key', `Duplicate source key ${duplicates.keys[0].key}`);
  if (duplicates.preferredIsbn13.length) fail('duplicate_isbn', `Duplicate preferred ISBN ${duplicates.preferredIsbn13[0].isbn}`);
  if (duplicates.works.length) fail('duplicate_work', 'Duplicate normalized work');
  return normalized;
}

function validateFingerprint(value) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail('invalid_fingerprint', 'sourceFingerprint must be a SHA-256 fingerprint');
  return value;
}

function validateVersion(value, name) {
  if (value !== CATALOG_RESOLVER_VERSION) fail('invalid_version', `${name} must equal ${CATALOG_RESOLVER_VERSION}`);
  return value;
}

function validateMetadata(value) {
  const metadata = object(value, 'Resolved metadata');
  exactKeys(metadata, ['title', 'author', 'isbn', 'publicationYear', 'description', 'coverImageUrl', 'genres'], 'Resolved metadata');
  const title = requiredText(metadata.title, 'metadata.title');
  const author = requiredText(metadata.author, 'metadata.author');
  const isbn = normalizedIsbn(metadata.isbn, 'metadata.isbn');
  if (metadata.publicationYear !== null && (!Number.isInteger(metadata.publicationYear) || metadata.publicationYear < 1000 || metadata.publicationYear > new Date().getFullYear() + 1)) fail('invalid_metadata', 'metadata.publicationYear must be a valid year or null');
  for (const field of ['description', 'coverImageUrl']) if (metadata[field] !== null && (typeof metadata[field] !== 'string' || !metadata[field].trim())) fail('invalid_metadata', `metadata.${field} must be a non-empty string or null`);
  if (metadata.coverImageUrl !== null) {
    try { if (new URL(metadata.coverImageUrl).protocol !== 'https:') throw new Error(); }
    catch { fail('invalid_metadata', 'metadata.coverImageUrl must be an HTTPS URL or null'); }
  }
  if (!Array.isArray(metadata.genres)) fail('invalid_metadata', 'metadata.genres must be an array');
  const genres = metadata.genres.map(normalizeGenre);
  if (new Set(genres.map(genre => genre.slug)).size !== genres.length) fail('invalid_metadata', 'metadata.genres contains duplicate slugs');
  return { title, author, isbn, publicationYear: metadata.publicationYear, description: metadata.description, coverImageUrl: metadata.coverImageUrl, genres };
}

function validateProviderIds(value) {
  const ids = object(value, 'providerIds');
  exactKeys(ids, ['openLibraryWork', 'openLibraryEdition', 'googleBooksVolume'], 'providerIds');
  for (const field of Object.keys(ids)) if (ids[field] !== null && (typeof ids[field] !== 'string' || !ids[field].trim())) fail('invalid_provider_ids', `providerIds.${field} must be a string or null`);
  return ids;
}

function validateProvenance(value) {
  const provenance = object(value, 'provenance');
  const fields = ['title', 'author', 'publicationYear', 'description', 'coverImageUrl', 'genres'];
  exactKeys(provenance, fields, 'provenance');
  for (const field of fields) if (provenance[field] !== null && (typeof provenance[field] !== 'string' || !provenance[field].trim())) fail('invalid_provenance', `provenance.${field} must be a string or null`);
  return provenance;
}

function validateSelection(value) {
  const selection = object(value, 'selection');
  exactKeys(selection, ['score', 'reasons'], 'selection');
  if (!Number.isFinite(selection.score)) fail('invalid_selection', 'selection.score must be finite');
  if (!Array.isArray(selection.reasons) || !selection.reasons.length || selection.reasons.some(reason => typeof reason !== 'string' || !reason.trim())) fail('invalid_selection', 'selection.reasons must be non-empty strings');
  return selection;
}

function validateDiagnostic(value) {
  const diagnostic = object(value, 'diagnostic');
  exactKeys(diagnostic, ['provider', 'stage', 'code', 'message', 'retryable', 'attempts'], 'diagnostic');
  for (const field of ['stage', 'code', 'message']) requiredText(diagnostic[field], `diagnostic.${field}`);
  if (diagnostic.provider !== null && (typeof diagnostic.provider !== 'string' || !diagnostic.provider.trim())) fail('invalid_diagnostic', 'diagnostic.provider must be a string or null');
  if (typeof diagnostic.retryable !== 'boolean' || !Number.isInteger(diagnostic.attempts) || diagnostic.attempts < 0) fail('invalid_diagnostic', 'diagnostic retryable and attempts are invalid');
  return diagnostic;
}

export function validateResolvedEntry(value) {
  const entry = object(value, 'Resolved artifact entry');
  const common = ['key', 'sourceFingerprint', 'resolverVersion', 'status', 'diagnostic'];
  if (!['resolved', 'needs_review', 'failed'].includes(entry.status)) fail('invalid_status', 'status must be resolved, needs_review, or failed');
  const resolvedFields = [...common, 'metadata', 'providerIds', 'provenance', 'selection'];
  exactKeys(entry, entry.status === 'resolved' ? resolvedFields : common, 'Resolved artifact entry');
  const key = validateSourceEntry({ key: entry.key, title: 'contract', author: 'contract' }).key;
  const sourceFingerprint = validateFingerprint(entry.sourceFingerprint);
  const resolverVersion = validateVersion(entry.resolverVersion, 'resolverVersion');
  if (entry.status !== 'resolved') return { key, sourceFingerprint, resolverVersion, status: entry.status, diagnostic: validateDiagnostic(entry.diagnostic) };
  if (entry.diagnostic !== null) fail('invalid_diagnostic', 'resolved entries must have a null diagnostic');
  return {
    key, sourceFingerprint, resolverVersion, status: 'resolved', metadata: validateMetadata(entry.metadata),
    providerIds: validateProviderIds(entry.providerIds), provenance: validateProvenance(entry.provenance), selection: validateSelection(entry.selection), diagnostic: null,
  };
}

export function validateResolvedArtifact(value) {
  const artifact = object(value, 'Resolved artifact');
  exactKeys(artifact, ['artifactVersion', 'resolverVersion', 'entries'], 'Resolved artifact');
  if (artifact.artifactVersion !== CATALOG_ARTIFACT_VERSION) fail('invalid_version', `artifactVersion must equal ${CATALOG_ARTIFACT_VERSION}`);
  validateVersion(artifact.resolverVersion, 'resolverVersion');
  if (!Array.isArray(artifact.entries)) fail('malformed_value', 'entries must be an array');
  const entries = artifact.entries.map(validateResolvedEntry);
  const keys = duplicateGroups(entries.map(entry => entry.key), 'key');
  if (keys.length) fail('duplicate_key', `Duplicate artifact key ${keys[0].key}`);
  return { artifactVersion: artifact.artifactVersion, resolverVersion: artifact.resolverVersion, entries };
}
