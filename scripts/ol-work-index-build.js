import { resolve } from 'node:path';
import { buildOpenLibraryWorkIndex } from './catalog/open-library-works.js';

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(Math.floor(milliseconds / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return '0/s';
  if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(2)}M/s`;
  if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}k/s`;
  return `${Math.round(rate)}/s`;
}

function parseArguments(args) {
  const options = {
    works: null,
    ratings: null,
    readingLog: null,
    output: resolve('scripts/catalog-cache/open-library-works'),
    snapshotId: null,
    batchSize: undefined,
    progressInterval: undefined,
    cacheMb: undefined,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--works', '--ratings', '--reading-log', '--output', '--snapshot-id', '--batch-size', '--progress-interval', '--cache-mb'].includes(argument)) {
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
      } else if (argument === '--cache-mb') {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 64) throw new Error('--cache-mb must be an integer >= 64');
        options.cacheMb = parsed;
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
  const onProgress = (statistics, phase, details = {}) => {
    const phaseRows = details.phaseRows ?? 0;
    const elapsed = formatDuration(details.elapsedMs ?? 0);
    const rate = formatRate(details.rate ?? 0);
    process.stderr.write(`[progress] phase=${phase} rows=${phaseRows} rate=${rate} elapsed=${elapsed} | works ${statistics.works.input} | ratings ${statistics.ratings.input} | reading-log ${statistics.readingLog.input}\n`);
  };
  const result = await buildOpenLibraryWorkIndex({
    worksPath: options.works,
    ratingsPath: options.ratings,
    readingLogPath: options.readingLog,
    outputPath: options.output,
    snapshotId: options.snapshotId,
    batchSize: options.batchSize,
    progressInterval: options.progressInterval,
    cacheMb: options.cacheMb,
    onProgress,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
