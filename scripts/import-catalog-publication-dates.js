import 'dotenv/config';
import { resolve } from 'node:path';
import {
  enrichCatalogPublicationDates,
  PublicationDateEnrichmentError,
} from './catalog/publication-date-enrichment.js';

let db;

try {
  const args = process.argv.slice(2);
  let apply = false;
  let source = resolve('scripts/catalog-publication-dates.csv');

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

  const result = await enrichCatalogPublicationDates(db, { source, apply });

  console.log(JSON.stringify(result.summary, null, 2));

  const { details } = result;

  if (details.validationErrors?.length > 0) {
    console.error(`\nValidation errors (${details.validationErrors.length}):`);
    for (const err of details.validationErrors.slice(0, 25)) {
      console.error(`  Line ${err.line ?? '?'}: [${err.isbn || '?'}] ${err.message}`);
    }
    if (details.validationErrors.length > 25) {
      console.error(`  ... and ${details.validationErrors.length - 25} more`);
    }
  }

  if (details.missingDatabaseBooks?.length > 0) {
    console.error(`\nMissing database books (${details.missingDatabaseBooks.length}):`);
    for (const item of details.missingDatabaseBooks.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.isbn}] requested ${item.requestedDate}`);
    }
    if (details.missingDatabaseBooks.length > 25) {
      console.error(`  ... and ${details.missingDatabaseBooks.length - 25} more`);
    }
  }

  if (details.conflictingExistingDates?.length > 0) {
    console.error(`\nConflicting existing dates (${details.conflictingExistingDates.length}):`);
    for (const item of details.conflictingExistingDates.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.isbn}] "${item.title}": database=${item.databaseDate} vs requested=${item.requestedDate}`);
    }
    if (details.conflictingExistingDates.length > 25) {
      console.error(`  ... and ${details.conflictingExistingDates.length - 25} more`);
    }
  }

  if (details.publicationYearMismatches?.length > 0) {
    console.error(`\nPublication year mismatches (${details.publicationYearMismatches.length}):`);
    for (const item of details.publicationYearMismatches.slice(0, 25)) {
      console.error(`  Line ${item.line ?? '?'}: [${item.isbn}] "${item.title}": database year=${item.databaseYear} vs requested date=${item.requestedDate}`);
    }
    if (details.publicationYearMismatches.length > 25) {
      console.error(`  ... and ${details.publicationYearMismatches.length - 25} more`);
    }
  }

  if (details.needsUpdate?.length > 0 && !apply) {
    console.log(`\nPlanned updates (${details.needsUpdate.length}):`);
    for (const item of details.needsUpdate.slice(0, 25)) {
      console.log(`  [${item.isbn}] "${item.title}": -> ${item.publicationDate}`);
    }
    if (details.needsUpdate.length > 25) {
      console.log(`  ... and ${details.needsUpdate.length - 25} more`);
    }
  }

  if (result.summary.updated > 0) {
    console.log(`\nSuccessfully updated ${result.summary.updated} book(s).`);
  }

  if (!result.summary.preflightSafe) {
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof PublicationDateEnrichmentError && error.details?.summary) {
    console.log(JSON.stringify(error.details.summary, null, 2));
  }
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) {
    await db.$disconnect();
  }
}
