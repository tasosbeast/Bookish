import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importCatalogCsv } from './catalog/csv-import.js';

let db;
try {
  const args = process.argv.slice(2);
  const options = { source: resolve('scripts/catalog-books.csv'), apply: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.apply !== null) throw new Error('Choose exactly one mode: --dry-run or --apply');
      options.apply = argument === '--apply';
    } else if (argument === '--source' || argument === '-s') {
      const value = args[++index];
      if (!value) throw new Error('--source requires a path');
      options.source = resolve(value);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }

  if (options.apply === null) {
    throw new Error('Choose exactly one mode: --dry-run or --apply');
  }

  const csvContent = await readFile(options.source, 'utf8');
  db = (await import('../src/lib/prisma.js')).prisma;

  const result = await importCatalogCsv(db, csvContent, { apply: options.apply });

  console.log(JSON.stringify(result.summary, null, 2));

  const hasIssues = result.summary.invalidRows > 0 ||
                    result.summary.duplicateIsbns > 0 ||
                    result.summary.duplicateWorks > 0 ||
                    result.summary.conflicts > 0;

  if (hasIssues) {
    if (result.details.invalidRows.length > 0) {
      console.error(`\nInvalid rows (${result.details.invalidRows.length}):`);
      for (const item of result.details.invalidRows.slice(0, 25)) {
        console.error(`  Line ${item.line}, Row ${item.row}: ${item.message}`);
      }
      if (result.details.invalidRows.length > 25) {
        console.error(`  ... and ${result.details.invalidRows.length - 25} more`);
      }
    }
    if (result.details.duplicateIsbns.length > 0) {
      console.error(`\nDuplicate ISBNs in CSV (${result.details.duplicateIsbns.length}):`);
      for (const item of result.details.duplicateIsbns.slice(0, 25)) {
        console.error(`  Line ${item.line}: ISBN ${item.isbn} (first seen on line ${item.firstSeenLine})`);
      }
      if (result.details.duplicateIsbns.length > 25) {
        console.error(`  ... and ${result.details.duplicateIsbns.length - 25} more`);
      }
    }
    if (result.details.duplicateWorks.length > 0) {
      console.error(`\nDuplicate works in CSV (${result.details.duplicateWorks.length}):`);
      for (const item of result.details.duplicateWorks.slice(0, 25)) {
        console.error(`  Line ${item.line}: "${item.title}" by "${item.author}" (first seen on line ${item.firstSeenLine})`);
      }
      if (result.details.duplicateWorks.length > 25) {
        console.error(`  ... and ${result.details.duplicateWorks.length - 25} more`);
      }
    }
    if (result.details.conflicts.length > 0) {
      console.error(`\nDatabase conflicts (${result.details.conflicts.length}):`);
      for (const item of result.details.conflicts.slice(0, 25)) {
        console.error(`  Line ${item.line}: ${item.message}`);
      }
      if (result.details.conflicts.length > 25) {
        console.error(`  ... and ${result.details.conflicts.length - 25} more`);
      }
    }
    if (options.apply) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`CSV catalog import could not complete: ${error?.message ?? String(error)}`);
  if (error?.details?.summary) {
    console.error(JSON.stringify(error.details.summary, null, 2));
  }
  if (error?.details?.details) {
    const details = error.details.details;
    if (details.invalidRows?.length) {
      console.error(`Invalid rows (${details.invalidRows.length}):`, details.invalidRows.slice(0, 25));
    }
    if (details.duplicateIsbns?.length) {
      console.error(`Duplicate ISBNs (${details.duplicateIsbns.length}):`, details.duplicateIsbns.slice(0, 25));
    }
    if (details.duplicateWorks?.length) {
      console.error(`Duplicate works (${details.duplicateWorks.length}):`, details.duplicateWorks.slice(0, 25));
    }
    if (details.conflicts?.length) {
      console.error(`DB Conflicts (${details.conflicts.length}):`, details.conflicts.slice(0, 25));
    }
  }
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
