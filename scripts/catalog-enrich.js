import { resolve } from 'node:path';
import { enrichCatalogCandidates } from './catalog/enrich.js';

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArguments(args) {
  const options = {
    input: null,
    editions: null,
    authorsIndex: null,
    output: null,
    progressInterval: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--input' || argument === '--editions' || argument === '--authors-index' || argument === '--output' || argument === '--progress-interval') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--input') options.input = resolve(value);
      else if (argument === '--editions') options.editions = resolve(value);
      else if (argument === '--authors-index') options.authorsIndex = resolve(value);
      else if (argument === '--output') options.output = resolve(value);
      else options.progressInterval = positiveInteger(value, '--progress-interval');
      continue;
    }
    throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.input || !options.editions || !options.authorsIndex || !options.output) {
    throw new Error('--input, --editions, --authors-index, and --output are required');
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const onProgress = counts => {
    process.stderr.write(`[progress] rows ${counts.rowsScanned} | matchedEditions ${counts.matchedEditions} | worksWithIsbns ${counts.worksWithIsbns} | worksWithoutIsbns ${counts.worksWithoutIsbns} | worksWithAuthor ${counts.worksWithAuthor}\n`);
  };
  const { artifact: _artifact, ...summary } = await enrichCatalogCandidates({
    inputPath: options.input,
    editionsPath: options.editions,
    authorsIndexPath: options.authorsIndex,
    outputPath: options.output,
    progressInterval: options.progressInterval,
    onProgress,
  });
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
