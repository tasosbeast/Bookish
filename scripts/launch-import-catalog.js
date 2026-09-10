import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importLaunchCatalog } from './catalog/launch-import.js';

let db;
try {
  const args = process.argv.slice(2);
  const options = { source: resolve('scripts/catalog-source.json'), apply: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.apply !== null) throw new Error('Choose exactly one mode: --dry-run or --apply');
      options.apply = argument === '--apply';
    } else if (argument === '--source') {
      const value = args[++index];
      if (!value) throw new Error('--source requires a path');
      options.source = resolve(value);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (options.apply === null) throw new Error('Choose exactly one mode: --dry-run or --apply');

  const source = JSON.parse(await readFile(options.source, 'utf8'));
  db = (await import('../src/lib/prisma.js')).prisma;
  const summary = await importLaunchCatalog(db, source, { apply: options.apply });
  console.log(`${options.apply ? 'Applied' : 'Dry run'}: ${JSON.stringify(summary)}`);
  if (summary.conflicts) process.exitCode = 1;
} catch (error) {
  console.error(`Launch catalog import could not complete: ${error?.message ?? String(error)}`);
  if (error?.details?.length) console.error(JSON.stringify(error.details));
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
