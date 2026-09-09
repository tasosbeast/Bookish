import { resolve } from 'node:path';
import { readSnapshotIndexMetadata } from './catalog/snapshot-index.js';

function parseArguments(args) {
  const options = { index: null, json: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--index') {
      const value = args[++index];
      if (!value) throw new Error('--index requires a value');
      options.index = resolve(value);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.index) throw new Error('--index is required');
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const metadata = await readSnapshotIndexMetadata(options.index);
  if (options.json) console.log(JSON.stringify(metadata));
  else console.log([
    `source: ${metadata.sourceName}`,
    `snapshot: ${metadata.snapshotId}`,
    `records: ${metadata.recordCount}`,
    `rejected: ${metadata.statistics.rejected}`,
    `duplicate ISBN groups: ${metadata.statistics.duplicateIsbnGroups}`,
    `conflicting ISBN groups: ${metadata.statistics.conflictingDuplicateIsbnGroups}`,
    `index version: ${metadata.indexVersion}`,
    `canonical contract version: ${metadata.canonicalContractVersion}`,
  ].join('\n'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
