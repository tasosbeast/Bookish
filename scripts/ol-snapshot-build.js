import { resolve } from 'node:path';
import { buildSnapshotIndex } from './catalog/snapshot-index.js';
import { createOpenLibraryAuthorLookup, readOpenLibraryEditionCandidates } from './catalog/open-library-bulk.js';

function parseArguments(args) {
  const options = { input: null, output: resolve('scripts/catalog-cache/open-library-index'), snapshotId: null, authorIndex: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--input', '--output', '--snapshot-id', '--author-index'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = key === 'snapshotId' ? value : resolve(value);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.input || !options.snapshotId || !options.authorIndex) throw new Error('--input, --snapshot-id and --author-index are required');
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const authorLookup = await createOpenLibraryAuthorLookup({ indexPath: options.authorIndex, snapshotId: options.snapshotId });
  console.log(JSON.stringify(await buildSnapshotIndex({
    records: readOpenLibraryEditionCandidates({ inputPath: options.input, snapshotId: options.snapshotId, authorLookup }),
    outputPath: options.output,
    sourceName: 'open-library-bulk',
    snapshotId: options.snapshotId,
  })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
