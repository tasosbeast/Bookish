import {
  CATALOG_RESOLVER_VERSION,
  CatalogContractError,
  sourceFingerprint,
  validateResolvedArtifact,
  validateSourceManifest,
} from './contracts.js';

const categories = ['resolved', 'needs_review', 'failed', 'stale', 'missing'];

function issue(scope, error) {
  return {
    scope,
    code: error instanceof CatalogContractError ? error.code : 'invalid_contract',
    message: error?.message ?? String(error),
  };
}

function emptyEntries() {
  return Object.fromEntries(categories.map(category => [category, []]));
}

function emptySummary(total = 0) {
  return {
    total,
    resolved: 0,
    needs_review: 0,
    failed: 0,
    stale: 0,
    missing: 0,
    orphaned: 0,
    duplicateSourceIssues: [],
    duplicateResolvedIsbnIssues: [],
  };
}

function sourceDetails(source, status, extra = {}) {
  return { key: source.key, title: source.title, author: source.author, status, ...extra };
}

function diagnosticDetails(entry) {
  return entry.diagnostic
    ? { diagnostic: { code: entry.diagnostic.code, stage: entry.diagnostic.stage } }
    : {};
}

function sortByKey(entries) {
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

function artifactForStatus(artifact) {
  if (artifact === null || artifact === undefined) return { entries: [] };
  return validateResolvedArtifact(artifact);
}

export function createCatalogStatus({ sources, artifact = null } = {}) {
  const sourceResult = (() => {
    try { return { value: validateSourceManifest(sources), error: null }; }
    catch (error) { return { value: null, error }; }
  })();
  const artifactResult = (() => {
    try { return { value: artifactForStatus(artifact), error: null }; }
    catch (error) { return { value: null, error }; }
  })();
  const total = Array.isArray(sources) ? sources.length : 0;
  const summary = emptySummary(total);
  const entries = emptyEntries();
  const errors = [];

  if (sourceResult.error) {
    const sourceIssue = issue('source', sourceResult.error);
    errors.push(sourceIssue);
    if (sourceIssue.code.startsWith('duplicate_')) summary.duplicateSourceIssues.push(sourceIssue);
  }
  if (artifactResult.error) {
    const artifactIssue = issue('artifact', artifactResult.error);
    errors.push(artifactIssue);
    if (artifactIssue.code === 'duplicate_resolved_isbn') summary.duplicateResolvedIsbnIssues.push(artifactIssue);
  }
  if (errors.length) return { valid: false, summary, entries, orphaned: [], errors };

  const artifactByKey = new Map(artifactResult.value.entries.map(entry => [entry.key, entry]));
  const sourceKeys = new Set(sourceResult.value.map(source => source.key));
  for (const source of sourceResult.value) {
    const entry = artifactByKey.get(source.key);
    if (!entry) {
      entries.missing.push(sourceDetails(source, 'missing'));
      continue;
    }

    const fingerprintMatches = entry.sourceFingerprint === sourceFingerprint(source);
    const versionMatches = entry.resolverVersion === CATALOG_RESOLVER_VERSION;
    if (!fingerprintMatches || !versionMatches) {
      const staleReason = !fingerprintMatches && !versionMatches ? 'both'
        : !fingerprintMatches ? 'fingerprint_mismatch'
          : 'resolver_version_mismatch';
      entries.stale.push(sourceDetails(source, 'stale', { staleReason, ...diagnosticDetails(entry) }));
      continue;
    }

    entries[entry.status].push(sourceDetails(source, entry.status, diagnosticDetails(entry)));
  }

  const orphaned = artifactResult.value.entries
    .filter(entry => !sourceKeys.has(entry.key))
    .map(entry => ({ key: entry.key, status: entry.status, resolverVersion: entry.resolverVersion, ...diagnosticDetails(entry) }));
  for (const category of categories) {
    sortByKey(entries[category]);
    summary[category] = entries[category].length;
  }
  sortByKey(orphaned);
  summary.orphaned = orphaned.length;
  return { valid: true, summary, entries, orphaned, errors: [] };
}

export function isCatalogStatusStrictFailure(status) {
  if (!status.valid) return true;
  return ['needs_review', 'failed', 'stale', 'missing', 'orphaned'].some(category => status.summary[category] > 0);
}

function detailLine(entry) {
  const diagnostic = entry.diagnostic ? ` (${entry.diagnostic.code} at ${entry.diagnostic.stage})` : '';
  const stale = entry.staleReason ? ` (${entry.staleReason})` : '';
  const author = entry.author ? ` — ${entry.title} by ${entry.author}` : '';
  return `- ${entry.key}${author}${stale}${diagnostic}`;
}

export function formatCatalogStatus(status) {
  const lines = ['Catalog status'];
  for (const key of ['total', ...categories, 'orphaned']) lines.push(`${key}: ${status.summary[key]}`);
  if (!status.valid) {
    lines.push('Contract errors:');
    for (const error of status.errors) lines.push(`- ${error.scope}: ${error.code} — ${error.message}`);
    return lines.join('\n');
  }
  for (const category of ['needs_review', 'failed', 'stale', 'missing']) {
    if (!status.entries[category].length) continue;
    lines.push(`${category}:`);
    for (const entry of status.entries[category]) lines.push(detailLine(entry));
  }
  if (status.orphaned.length) {
    lines.push('orphaned:');
    for (const entry of status.orphaned) lines.push(detailLine(entry));
  }
  return lines.join('\n');
}
