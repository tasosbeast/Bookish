import { resolve } from 'node:path';
import { checkCatalogLanguages } from './catalog/language-check.js';

function parseArguments(args) {
  const options = {
    input: null,
    editions: null,
    output: null,
    snapshotId: undefined,
    keepUnknownLanguage: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--keep-unknown-language') {
      if (seen.has(argument)) throw new Error('--keep-unknown-language was provided more than once');
      seen.add(argument);
      options.keepUnknownLanguage = true;
      continue;
    }
    if (argument === '--input' || argument === '--editions' || argument === '--output' || argument === '--snapshot-id') {
      if (seen.has(argument)) throw new Error(`${argument} was provided more than once`);
      seen.add(argument);
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--input') options.input = resolve(value);
      else if (argument === '--editions') options.editions = resolve(value);
      else if (argument === '--output') options.output = resolve(value);
      else options.snapshotId = value;
      continue;
    }
    throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.input || !options.editions || !options.output) {
    throw new Error('--input, --editions, and --output are required');
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const { artifact: _artifact, ...summary } = await checkCatalogLanguages({
    inputPath: options.input,
    editionsPath: options.editions,
    outputPath: options.output,
    snapshotId: options.snapshotId,
    keepUnknownLanguage: options.keepUnknownLanguage,
  });
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
