import { resolve } from 'node:path';
import { runOpenLibraryBulkSmoke } from './catalog/bulk-smoke.js';

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArguments(args) {
  const options = { authorsPath: null, editionsPath: null, workingDirectory: null, snapshotId: null, sortChunkSize: undefined };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--authors', '--editions', '--workdir', '--snapshot-id', '--chunk-size'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--authors') options.authorsPath = resolve(value);
      if (argument === '--editions') options.editionsPath = resolve(value);
      if (argument === '--workdir') options.workingDirectory = resolve(value);
      if (argument === '--snapshot-id') options.snapshotId = value;
      if (argument === '--chunk-size') options.sortChunkSize = parseInteger(value, argument);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.authorsPath || !options.editionsPath || !options.workingDirectory || !options.snapshotId) throw new Error('--authors, --editions, --workdir and --snapshot-id are required');
  return options;
}

try {
  console.log(JSON.stringify(await runOpenLibraryBulkSmoke(parseArguments(process.argv.slice(2)))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
