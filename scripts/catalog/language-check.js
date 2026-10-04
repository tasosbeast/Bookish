import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { assertOutputDirectoryWritable, writeFileAtomic } from './atomic-write.js';
import { CatalogContractError } from './contracts.js';
import { validateEnrichedArtifact } from './enrich.js';
import { stableJson } from './external-sort.js';
import { readOpenLibraryBulkRecords } from './open-library-bulk.js';
import { SnapshotRecordError } from './snapshot-reader.js';

const LANGUAGE_KEY = /^\/languages\/[a-z0-9_]+$/;
const ENGLISH_LANGUAGE = '/languages/eng';
const DIGEST_HEX = /^[a-f0-9]{64}$/;

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_argument', `${name} is required`);
  return resolve(value);
}

async function assertReadable(path, label) {
  let stat;
  try {
    await fs.access(path, fsConstants.R_OK);
    stat = await fs.stat(path);
  } catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    fail('invalid_argument', `Unable to read ${label} ${path}: ${cause.message}`);
  }
  if (!stat.isFile()) fail('invalid_argument', `${label} must be a file: ${path}`);
  return stat;
}

function languageKey(value) {
  const raw = text(typeof value === 'string' ? value : value?.key);
  if (!raw) return null;
  const folded = raw.toLowerCase();
  const key = folded.startsWith('/languages/') ? folded : `/languages/${folded}`;
  return LANGUAGE_KEY.test(key) ? key : null;
}

function editionLanguageKeys(languages) {
  if (!Array.isArray(languages)) return [];
  const keys = [];
  for (const item of languages) {
    const key = languageKey(item);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function matchingWorkKeys(data, entries) {
  if (!Array.isArray(data?.works)) return [];
  const matched = [];
  for (const item of data.works) {
    const key = text(item?.key);
    if (!key || !entries.has(key) || matched.includes(key)) continue;
    matched.push(key);
  }
  return matched;
}

function compareWorkKey(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// The digest is an integrity check, not tamper-proofing: it covers the pinned snapshot,
// enriched input hash, keepUnknownLanguage flag, editions dump identity, and kept works.
export function languageCheckDigestForArtifact(artifact) {
  const editions = artifact?.languageCheckEditions;
  const works = (Array.isArray(artifact?.candidates) ? artifact.candidates : []).map(candidate => ({
    workKey: candidate?.workKey,
    languages: Array.isArray(candidate?.languages) ? [...candidate.languages].sort() : [],
  })).sort((left, right) => compareWorkKey(left.workKey, right.workKey));
  return createHash('sha256').update(stableJson({
    snapshotId: artifact?.snapshotId,
    enrichedInputSha256: artifact?.languageCheckEnrichedInputSha256,
    keepUnknownLanguage: artifact?.languageCheckKeepUnknownLanguage === true,
    editionsBasename: editions?.basename,
    editionsBytes: editions?.bytes,
    works,
  })).digest('hex');
}

export function enrichedArtifactForValidation(artifact) {
  if (!plainObject(artifact)) return artifact;
  const {
    languageCheckDigest: _digest,
    languageCheckEditions: _editions,
    languageCheckEnrichedInputSha256: _enrichedInputSha256,
    languageCheckKeepUnknownLanguage: _keepUnknownLanguage,
    ...rest
  } = artifact;
  return {
    ...rest,
    languageCheck: rest.languageCheck === 'passed' ? 'pending' : rest.languageCheck,
    candidates: Array.isArray(rest.candidates) ? rest.candidates.map(candidate => {
      if (!plainObject(candidate) || !Object.hasOwn(candidate, 'languages')) return candidate;
      const { languages: _languages, ...core } = candidate;
      return core;
    }) : rest.candidates,
  };
}

function assertLanguageList(languages) {
  if (!Array.isArray(languages)) fail('invalid_language_check', 'Language-checked candidate languages are malformed');
  const seen = new Set();
  for (let index = 0; index < languages.length; index += 1) {
    const key = languages[index];
    if (typeof key !== 'string' || !LANGUAGE_KEY.test(key) || seen.has(key) || (index > 0 && key <= languages[index - 1])) {
      fail('invalid_language_check', 'Language-checked candidate languages must be unique sorted /languages/ keys');
    }
    seen.add(key);
  }
  if (languages.length > 0 && !languages.includes(ENGLISH_LANGUAGE)) {
    fail('invalid_language_check', 'A kept work with language data must include /languages/eng');
  }
}

function assertEditionsIdentity(value) {
  if (!plainObject(value)) fail('invalid_language_check', 'Language check editions identity is malformed');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, 'basename') || !Object.hasOwn(value, 'bytes')) {
    fail('invalid_language_check', 'Language check editions identity is malformed');
  }
  if (typeof value.basename !== 'string' || !value.basename || value.basename.includes('/') || value.basename.includes('\\')) {
    fail('invalid_language_check', 'Language check editions basename is invalid');
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail('invalid_language_check', 'Language check editions size is invalid');
  }
}

export function validateLanguageCheckedArtifact(value, { snapshotId } = {}) {
  if (!plainObject(value)) fail('invalid_language_check', 'Language-checked artifact must be an object');
  if (value.languageCheck !== 'passed') fail('invalid_language_check', 'Language-checked artifact languageCheck must be passed');
  if (snapshotId !== undefined && value.snapshotId !== snapshotId) {
    fail('invalid_language_check', 'Language-checked artifact snapshotId does not match the input snapshot');
  }
  assertEditionsIdentity(value.languageCheckEditions);
  if (typeof value.languageCheckEnrichedInputSha256 !== 'string' || !DIGEST_HEX.test(value.languageCheckEnrichedInputSha256)) {
    fail('invalid_language_check', 'languageCheckEnrichedInputSha256 must be a sha256 hex digest');
  }
  if (typeof value.languageCheckKeepUnknownLanguage !== 'boolean') {
    fail('invalid_language_check', 'languageCheckKeepUnknownLanguage must be true or false');
  }
  if (typeof value.languageCheckDigest !== 'string' || !DIGEST_HEX.test(value.languageCheckDigest)) {
    fail('invalid_language_check', 'languageCheckDigest must be a sha256 hex digest');
  }
  if (!Array.isArray(value.candidates)) fail('invalid_language_check', 'Language-checked candidates must be an array');
  for (const candidate of value.candidates) {
    if (!plainObject(candidate)) fail('invalid_language_check', 'Language-checked candidate is malformed');
    assertLanguageList(candidate.languages);
  }
  if (value.languageCheckDigest !== languageCheckDigestForArtifact(value)) {
    fail('invalid_language_check', 'languageCheckDigest does not match the language-checked artifact');
  }
  validateEnrichedArtifact(enrichedArtifactForValidation(value), { snapshotId: value.snapshotId });
  return value;
}

export async function writeLanguageCheckedArtifactAtomically(outputPath, artifact, { snapshotId } = {}) {
  const serialized = `${stableJson(artifact)}\n`;
  await writeFileAtomic(outputPath, serialized, {
    mode: 0o600,
    validate: async content => {
      let parsed;
      try { parsed = JSON.parse(content); }
      catch { fail('invalid_language_check', 'Language-checked artifact is not valid JSON'); }
      validateLanguageCheckedArtifact(parsed, { snapshotId });
      if (stableJson(parsed) !== stableJson(artifact)) fail('invalid_language_check', 'Language-checked artifact did not round-trip');
    },
  });
}

async function readEnrichedInput(inputPath) {
  let raw;
  try {
    raw = await fs.readFile(inputPath, 'utf8');
  } catch (cause) {
    fail('invalid_enriched_artifact', `Unable to read enriched input ${inputPath}: ${cause.message}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(raw);
  } catch (cause) {
    fail('invalid_enriched_artifact', `Unable to read enriched input ${inputPath}: ${cause.message}`);
  }
  return {
    artifact: validateEnrichedArtifact(artifact),
    enrichedInputSha256: createHash('sha256').update(raw).digest('hex'),
  };
}

async function scanEditionLanguages(editionsPath, entries, counts) {
  for await (const record of readOpenLibraryBulkRecords(editionsPath)) {
    counts.rowsScanned += 1;
    if (!Number.isSafeInteger(counts.rowsScanned)) fail('invalid_language_check', 'rowsScanned exceeded a safe integer');
    if (record instanceof SnapshotRecordError) {
      counts.malformedRows += 1;
      continue;
    }
    if (record?.type !== '/type/edition' || !plainObject(record.data)) continue;
    const matched = matchingWorkKeys(record.data, entries);
    if (!matched.length) continue;
    counts.matchedEditions += 1;
    const keys = editionLanguageKeys(record.data.languages);
    for (const workKey of matched) {
      const languages = entries.get(workKey);
      for (const key of keys) languages.add(key);
    }
  }
}

function classifyCandidates(artifact, entries, { keepUnknownLanguage }) {
  const kept = [];
  const counts = {
    kept: 0,
    droppedNonEnglish: 0,
    droppedUnknownLanguage: 0,
    keptUnknownLanguage: 0,
  };
  for (const candidate of artifact.candidates) {
    const languages = [...entries.get(candidate.workKey)].sort();
    if (languages.includes(ENGLISH_LANGUAGE)) {
      kept.push({ ...candidate, languages });
      counts.kept += 1;
      continue;
    }
    if (languages.length === 0) {
      if (keepUnknownLanguage) {
        kept.push({ ...candidate, languages });
        counts.kept += 1;
        counts.keptUnknownLanguage += 1;
      } else {
        counts.droppedUnknownLanguage += 1;
      }
      continue;
    }
    counts.droppedNonEnglish += 1;
  }
  return { kept, counts };
}

export async function checkCatalogLanguages({
  inputPath,
  editionsPath,
  outputPath,
  snapshotId,
  keepUnknownLanguage = false,
} = {}) {
  if (typeof keepUnknownLanguage !== 'boolean') fail('invalid_argument', 'keepUnknownLanguage must be true or false');
  if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !snapshotId)) {
    fail('invalid_argument', 'snapshotId must be a non-empty string');
  }
  const input = requiredPath(inputPath, 'inputPath');
  const editions = requiredPath(editionsPath, 'editionsPath');
  const output = requiredPath(outputPath, 'outputPath');
  await assertReadable(input, 'enriched input');
  const editionStat = await assertReadable(editions, 'editions dump');
  await assertOutputDirectoryWritable(output, { label: 'Language-check output' });
  const { artifact, enrichedInputSha256 } = await readEnrichedInput(input);
  const pinnedSnapshotId = artifact.snapshotId;
  if (snapshotId !== undefined && snapshotId !== pinnedSnapshotId) {
    fail('snapshot_mismatch', `Language check snapshotId does not match the enriched artifact snapshot ${pinnedSnapshotId}`);
  }

  const entries = new Map(artifact.candidates.map(candidate => [candidate.workKey, new Set()]));
  const scanCounts = { rowsScanned: 0, matchedEditions: 0, malformedRows: 0 };
  await scanEditionLanguages(editions, entries, scanCounts);
  const classified = classifyCandidates(artifact, entries, { keepUnknownLanguage });
  const checked = {
    ...artifact,
    languageCheck: 'passed',
    languageCheckEditions: { basename: basename(editions), bytes: editionStat.size },
    languageCheckEnrichedInputSha256: enrichedInputSha256,
    languageCheckKeepUnknownLanguage: keepUnknownLanguage,
    counts: { ...artifact.counts, selected: classified.kept.length },
    candidates: classified.kept,
  };
  checked.languageCheckDigest = languageCheckDigestForArtifact(checked);
  validateLanguageCheckedArtifact(checked, { snapshotId: pinnedSnapshotId });
  await writeLanguageCheckedArtifactAtomically(output, checked, { snapshotId: pinnedSnapshotId });
  return {
    snapshotId: pinnedSnapshotId,
    outputPath: output,
    languageCheck: 'passed',
    languageCheckDigest: checked.languageCheckDigest,
    editionsBasename: checked.languageCheckEditions.basename,
    editionsBytes: checked.languageCheckEditions.bytes,
    rowsScanned: scanCounts.rowsScanned,
    matchedEditions: scanCounts.matchedEditions,
    malformedRows: scanCounts.malformedRows,
    kept: classified.counts.kept,
    droppedNonEnglish: classified.counts.droppedNonEnglish,
    droppedUnknownLanguage: classified.counts.droppedUnknownLanguage,
    keptUnknownLanguage: classified.counts.keptUnknownLanguage,
    droppedByReason: {
      non_english: classified.counts.droppedNonEnglish,
      unknown_language: classified.counts.droppedUnknownLanguage,
    },
    artifact: checked,
  };
}
