import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildTargetedOpenLibraryArtifact } from './catalog/open-library-targeted.js';

function parseArguments(args) {
  const options = {
    source: null,
    input: null,
    authorIndex: null,
    output: null,
    snapshotId: null,
    batchSize: undefined,
    progressInterval: undefined,
    json: false,
  };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') {
      options.json = true;
    } else if (['--source', '--input', '--author-index', '--output', '--snapshot-id', '--batch-size', '--progress-interval'].includes(argument)) {
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

  if (!options.source || !options.input || !options.authorIndex || !options.output || !options.snapshotId) {
    throw new Error('--source, --input, --author-index, --output, and --snapshot-id are required');
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const sources = JSON.parse(await readFile(options.source, 'utf8'));

  const onProgress = (stats) => {
    const elapsedSec = (stats.elapsedMs / 1000).toFixed(1);
    const line = `[progress] rows scanned: ${stats.rowsScanned.toLocaleString()} | pending: ${stats.pendingEditions.toLocaleString()} | title hits: ${stats.rowsPassingTitlePrefilter.toLocaleString()} | ISBN hits: ${stats.rowsPassingIsbnPrefilter.toLocaleString()} | elapsed: ${elapsedSec}s\n`;
    if (options.json) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  };

  const result = await buildTargetedOpenLibraryArtifact({
    sources,
    inputPath: options.input,
    authorIndexPath: options.authorIndex,
    outputPath: options.output,
    snapshotId: options.snapshotId,
    batchSize: options.batchSize,
    progressInterval: options.progressInterval,
    onProgress,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log([
      `targeted artifact: ${result.outputPath}`,
      `snapshot id: ${result.snapshotId}`,
      `source manifest count: ${result.sourceManifestCount}`,
      `source manifest fingerprint: ${result.sourceManifestFingerprint}`,
      `rows scanned: ${result.statistics.rowsScanned}`,
      `malformed rows: ${result.statistics.malformedRows}`,
      `rejected rows: ${result.statistics.rejectedRows}`,
      `rows passing title prefilter: ${result.statistics.rowsPassingTitlePrefilter}`,
      `rows passing ISBN prefilter: ${result.statistics.rowsPassingIsbnPrefilter}`,
      `pending editions: ${result.statistics.pendingEditions}`,
      `distinct author keys needed: ${result.statistics.distinctAuthorKeysNeeded}`,
      `author shards scanned: ${result.statistics.authorShardsScanned}`,
      `author rows scanned: ${result.statistics.authorRowsScanned}`,
      `author keys resolved: ${result.statistics.authorKeysResolved}`,
      `author keys missing: ${result.statistics.authorKeysMissing}`,
      `author keys conflicted: ${result.statistics.authorKeysConflicted}`,
      `matched editions: ${result.statistics.matchedEditions}`,
      `canonical candidates: ${result.statistics.canonicalCandidates}`,
      `unique candidate associations: ${result.statistics.uniqueCandidateAssociations}`,
      `requested works with candidates: ${result.statistics.requestedWorksWithCandidates}`,
      `requested works without candidates: ${result.statistics.requestedWorksWithoutCandidates}`,
      `elapsed time: ${(result.statistics.elapsedMs / 1000).toFixed(2)}s`,
    ].join('\n'));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
