import { resolve } from 'node:path';
import { buildOpenLibraryAuthorIndex } from './catalog/open-library-bulk.js';

function parseArguments(args) {
  const options = { input: null, output: resolve('scripts/catalog-cache/open-library-authors'), snapshotId: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--input', '--output', '--snapshot-id'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = key === 'snapshotId' ? value : resolve(value);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.input || !options.snapshotId) throw new Error('--input and --snapshot-id are required');
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(await buildOpenLibraryAuthorIndex({
    inputPath: options.input,
    outputPath: options.output,
    snapshotId: options.snapshotId,
  })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
