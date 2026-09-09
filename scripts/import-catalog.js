import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importResolvedCatalog, validateImportArtifact } from './catalog/import.js';

let db;
try {
  const args = process.argv.slice(2);
  const options = { artifact: resolve('scripts/catalog-resolved.json'), apply: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.apply !== null) throw new Error('Choose exactly one mode: --dry-run or --apply');
      options.apply = argument === '--apply';
    } else if (argument === '--artifact') {
      const value = args[++index];
      if (!value) throw new Error('--artifact requires a path');
      options.artifact = resolve(value);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (options.apply === null) throw new Error('Choose exactly one mode: --dry-run or --apply');

  const artifact = validateImportArtifact(JSON.parse(await readFile(options.artifact, 'utf8')));
  db = (await import('../src/lib/prisma.js')).prisma;
  const summary = await importResolvedCatalog(db, artifact, { apply: options.apply, report: console.error });
  console.log(`${options.apply ? 'Applied' : 'Dry run (would change)'}: ${JSON.stringify(summary)}`);
  if (summary.failed) process.exitCode = 1;
} catch (error) {
  console.error(`Catalog import could not complete: ${error?.message ?? String(error)}`);
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
