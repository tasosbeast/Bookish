import 'dotenv/config';
import { resolve } from 'node:path';
import {
  importReleaseCatalog,
  ReleaseCatalogError,
} from './catalog/release-catalog.js';

let db;

try {
  const args = process.argv.slice(2);
  let apply = false;
  let source = resolve('scripts/release-catalog.csv');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--dry-run') {
      apply = false;
    } else if (arg === '--source' || arg === '-s') {
      const value = args[++i];
      if (!value) {
        throw new Error('--source requires a file path');
      }
      source = resolve(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  db = (await import('../src/lib/prisma.js')).prisma;

  console.log(`\nMode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Source: ${source}\n`);

  const result = await importReleaseCatalog(db, { source, apply });

  console.log(JSON.stringify(result.summary, null, 2));

  const { details } = result;

  if (details.invalidRows?.length > 0) {
    console.error(`\nInvalid rows (${details.invalidRows.length}):`);
    for (const item of details.invalidRows.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.field ?? '?'}] ${item.message}`);
    }
    if (details.invalidRows.length > 25) {
      console.error(`  ... and ${details.invalidRows.length - 25} more`);
    }
  }

  if (details.duplicateIsbns?.length > 0) {
    console.error(`\nDuplicate ISBNs within CSV (${details.duplicateIsbns.length}):`);
    for (const item of details.duplicateIsbns.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.isbn}] first seen on line ${item.firstSeenLine}`);
    }
    if (details.duplicateIsbns.length > 25) {
      console.error(`  ... and ${details.duplicateIsbns.length - 25} more`);
    }
  }

  if (details.duplicateWorks?.length > 0) {
    console.error(`\nDuplicate works within CSV (${details.duplicateWorks.length}):`);
    for (const item of details.duplicateWorks.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: "${item.title}" by "${item.author}" first seen on line ${item.firstSeenLine}`);
    }
    if (details.duplicateWorks.length > 25) {
      console.error(`  ... and ${details.duplicateWorks.length - 25} more`);
    }
  }

  if (details.missingGenres?.length > 0) {
    console.error(`\nMissing genres in database (${details.missingGenres.length}):`);
    for (const item of details.missingGenres.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.isbn}] "${item.title}": ${item.reason}`);
    }
    if (details.missingGenres.length > 25) {
      console.error(`  ... and ${details.missingGenres.length - 25} more`);
    }
  }

  if (details.exactIsbnConflicts?.length > 0) {
    console.error(`\nExact ISBN conflicts (${details.exactIsbnConflicts.length}):`);
    for (const item of details.exactIsbnConflicts.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.isbn}] ${item.message}`);
    }
    if (details.exactIsbnConflicts.length > 25) {
      console.error(`  ... and ${details.exactIsbnConflicts.length - 25} more`);
    }
  }

  if (details.existingWorkCollisions?.length > 0) {
    console.error(`\nExisting work collisions (${details.existingWorkCollisions.length}):`);
    for (const item of details.existingWorkCollisions.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.isbn}] ${item.message}`);
    }
    if (details.existingWorkCollisions.length > 25) {
      console.error(`  ... and ${details.existingWorkCollisions.length - 25} more`);
    }
  }

  if (details.alreadyPresent?.length > 0) {
    console.log(`\nAlready present books (${details.alreadyPresent.length}):`);
    for (const item of details.alreadyPresent.slice(0, 25)) {
      console.log(`  [${item.isbn}] "${item.title}" (id: ${item.bookId})`);
    }
    if (details.alreadyPresent.length > 25) {
      console.log(`  ... and ${details.alreadyPresent.length - 25} more`);
    }
  }

  if (details.newBooks?.length > 0 && !apply) {
    console.log(`\nPlanned new books (${details.newBooks.length}):`);
    for (const item of details.newBooks.slice(0, 25)) {
      console.log(`  [${item.isbn}] "${item.title}" by "${item.author}" (${item.publicationDate})`);
    }
    if (details.newBooks.length > 25) {
      console.log(`  ... and ${details.newBooks.length - 25} more`);
    }
  }

  if (result.summary.created > 0) {
    console.log(`\nSuccessfully created ${result.summary.created} release book(s).`);
  }

  if (!result.summary.preflightSafe) {
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof ReleaseCatalogError && error.details?.summary) {
    console.log(JSON.stringify(error.details.summary, null, 2));
  }
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) {
    await db.$disconnect();
  }
}
