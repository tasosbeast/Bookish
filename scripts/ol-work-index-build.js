import { resolve } from 'node:path';
import { buildOpenLibraryWorkIndex } from './catalog/open-library-works.js';

function parseArguments(args) {
  const options = {
    works: null,
    ratings: null,
    readingLog: null,
    output: resolve('scripts/catalog-cache/open-library-works'),
    snapshotId: null,
    batchSize: undefined,
    progressInterval: undefined,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--works', '--ratings', '--reading-log', '--output', '--snapshot-id', '--batch-size', '--progress-interval'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--snapshot-id') {
        options.snapshotId = value;
      } else if (argument === '--batch-size') {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('--batch-size must be a positive integer');
        options.batchSize = parsed;
      } else if (argument === '--progress-interval') {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('--progress-interval must be a positive integer');
        options.progressInterval = parsed;
      } else {
        const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        options[key] = resolve(value);
      }
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!options.works || !options.ratings || !options.readingLog || !options.snapshotId) {
    throw new Error('--works, --ratings, --reading-log, and --snapshot-id are required');
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const onProgress = (statistics, phase) => {
    const stage = phase === 'validating' ? 'validating | ' : '';
    process.stderr.write(`[progress] ${stage}works ${statistics.works.input} | ratings ${statistics.ratings.input} | reading-log ${statistics.readingLog.input}\n`);
  };
  const result = await buildOpenLibraryWorkIndex({
    worksPath: options.works,
    ratingsPath: options.ratings,
    readingLogPath: options.readingLog,
    outputPath: options.output,
    snapshotId: options.snapshotId,
    batchSize: options.batchSize,
    progressInterval: options.progressInterval,
    onProgress,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
