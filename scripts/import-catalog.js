import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { importCatalog, openLibrary, saveMetadata } from './catalog.js';

let db;
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run', '--smoke'].includes(arg)) || args.includes('--apply') && (args.includes('--dry-run') || args.includes('--smoke'))) throw new Error('Options: --dry-run OR --apply; --smoke resolves only the first ISBN without a database');
  const manifest = JSON.parse(await readFile(new URL('./catalog.json', import.meta.url), 'utf8'));
  const smoke = args.includes('--smoke');
  if (!smoke) db = (await import('../src/lib/prisma.js')).prisma;
  const apply = args.includes('--apply');
  const summary = await importCatalog(smoke ? manifest.slice(0, 1) : manifest, {
    resolve: openLibrary(), save: data => smoke ? 'unchanged' : saveMetadata(db, data, apply), report: console.log,
  });
  console.log(`${smoke ? 'Smoke (no writes)' : apply ? 'Applied' : 'Dry run (would change)'}: ${JSON.stringify(summary)}`);
  if (summary.failed) process.exitCode = 1;
} catch { console.error('Import could not complete. Check options, manifest and local database configuration.'); process.exitCode = 1; }
finally { await db?.$disconnect(); }
