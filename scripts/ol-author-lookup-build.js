import { resolve } from 'node:path';
import { buildOpenLibraryAuthorLookup } from './catalog/open-library-bulk.js';

function parseArguments(args) {
  const options = { index: null, snapshotId: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--index', '--snapshot-id'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--index') options.index = resolve(value);
      else options.snapshotId = value;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.index || !options.snapshotId) throw new Error('--index and --snapshot-id are required');
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(await buildOpenLibraryAuthorLookup({ indexPath: options.index, snapshotId: options.snapshotId })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
