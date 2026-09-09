import { resolve } from 'node:path';
import { buildSnapshotIndex } from './catalog/snapshot-index.js';
import { readNdjsonSnapshot } from './catalog/snapshot-reader.js';

function parseArguments(args) {
  const options = { input: null, output: resolve('scripts/catalog-cache/canonical-snapshot-index'), sourceName: null, snapshotId: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--input', '--output', '--source-name', '--snapshot-id'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = key === 'input' || key === 'output' ? resolve(value) : value;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.input || !options.sourceName || !options.snapshotId) throw new Error('--input, --source-name and --snapshot-id are required');
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(await buildSnapshotIndex({
    records: readNdjsonSnapshot(options.input),
    outputPath: options.output,
    sourceName: options.sourceName,
    snapshotId: options.snapshotId,
  })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
