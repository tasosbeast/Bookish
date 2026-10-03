import { resolve } from 'node:path';
import { CATALOG_DISCOVER_MAX_LIMIT, discoverCatalogCandidates } from './catalog/discover.js';

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  if (name === '--limit' && parsed > CATALOG_DISCOVER_MAX_LIMIT) throw new Error(`--limit must be at most ${CATALOG_DISCOVER_MAX_LIMIT}`);
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parseArguments(args) {
  const options = {
    worksIndex: null,
    snapshotId: null,
    limit: null,
    output: resolve('scripts/catalog-cache/catalog-discover.json'),
    minRatings: undefined,
    minReaders: undefined,
    excludeKeys: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['--works-index', '--snapshot-id', '--limit', '--output', '--min-ratings', '--min-readers', '--exclude-keys'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--snapshot-id') options.snapshotId = value;
      else if (argument === '--limit') options.limit = positiveInteger(value, '--limit');
      else if (argument === '--min-ratings') options.minRatings = nonNegativeInteger(value, '--min-ratings');
      else if (argument === '--min-readers') options.minReaders = nonNegativeInteger(value, '--min-readers');
      else if (argument === '--works-index') options.worksIndex = resolve(value);
      else if (argument === '--exclude-keys') options.excludeKeys = resolve(value);
      else options.output = resolve(value);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!options.worksIndex || !options.snapshotId || options.limit === null) {
    throw new Error('--works-index, --snapshot-id, and --limit are required');
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await discoverCatalogCandidates({
    worksIndexPath: options.worksIndex,
    snapshotId: options.snapshotId,
    limit: options.limit,
    outputPath: options.output,
    minRatings: options.minRatings,
    minReaders: options.minReaders,
    excludeKeysPath: options.excludeKeys,
  });
  const { candidates: _candidates, ...summary } = result;
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
