import 'dotenv/config';
import { assertOutputDirectoryWritable } from './catalog/atomic-write.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createImportPrismaClient,
  importCatalogWorks,
  importResolvedCatalog,
  loadWorksImportSources,
  parseCatalogWorksImportArgs,
  validateImportArtifact,
} from './catalog/import.js';

function worksImportRequested(args) {
  return args.some(argument => (
    argument === '--report'
    || argument === '--enriched'
    || argument === '--output'
    || argument === '--limit'
    || argument === '--batch-size'
    || argument === '--allow-unchecked-language'
    || argument === '--fail-fast'
  ));
}

async function runWorksImport(args) {
  const options = parseCatalogWorksImportArgs(args);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await assertOutputDirectoryWritable(options.output, { label: 'Import output' });
  const sources = await loadWorksImportSources(options.report, options.enriched);
  const db = createImportPrismaClient(databaseUrl, { apply: options.apply });
  try {
    const { summary } = await importCatalogWorks({
      db,
      reportRows: sources.reportRows,
      artifact: sources.artifact,
      join: sources.join,
      apply: options.apply,
      allowUncheckedLanguage: options.allowUncheckedLanguage,
      failFast: options.failFast,
      limit: options.limit,
      batchSize: options.batchSize,
      outputPath: options.output,
    });
    if (!options.apply && summary.languageCheckError) {
      console.error(`languageCheckDigest is invalid: ${summary.languageCheckError}. Re-run catalog:language-check.`);
    }
    console.log(JSON.stringify(summary));
    if (summary.failed) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

async function runResolvedImport(args) {
  const options = { artifact: resolve('scripts/catalog-resolved.json'), apply: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.apply !== null) throw new Error('Choose exactly one mode: --dry-run or --apply');
      options.apply = argument === '--apply';
    } else if (argument === '--artifact') {
      const value = args[index + 1];
      if (!value) throw new Error('--artifact requires a path');
      options.artifact = resolve(value);
      index += 1;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (options.apply === null) throw new Error('Choose exactly one mode: --dry-run or --apply');

  const artifact = validateImportArtifact(JSON.parse(await readFile(options.artifact, 'utf8')));
  const db = (await import('../src/lib/prisma.js')).prisma;
  try {
    const summary = await importResolvedCatalog(db, artifact, { apply: options.apply, report: console.error });
    console.log(`${options.apply ? 'Applied' : 'Dry run (would change)'}: ${JSON.stringify(summary)}`);
    if (summary.failed) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

const args = process.argv.slice(2);
try {
  if (worksImportRequested(args)) await runWorksImport(args);
  else await runResolvedImport(args);
} catch (error) {
  const message = error?.message ?? String(error);
  console.error(worksImportRequested(args) ? message : `Catalog import could not complete: ${message}`);
  process.exitCode = 1;
}
