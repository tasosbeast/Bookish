import 'dotenv/config';
import { enrichCatalogGenres, GenreEnrichmentError } from './catalog/genre-enrichment.js';

let db;

try {
  const args = process.argv.slice(2);
  let apply = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply' || arg === '--dry-run') {
      if (apply !== null) {
        throw new Error('Choose exactly one mode: --dry-run or --apply');
      }
      apply = arg === '--apply';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (apply === null) {
    throw new Error('Choose exactly one mode: --dry-run or --apply');
  }

  db = (await import('../src/lib/prisma.js')).prisma;

  const result = await enrichCatalogGenres(db, { apply });

  console.log(JSON.stringify(result.summary, null, 2));

  const {
    preflightSafe,
    missingBooks,
    ambiguousBooks,
    bookConflicts,
    genreConflicts,
    genresToCreate,
    plannedAdditions,
    plannedRemovals,
  } = result.details;

  if (genresToCreate.length > 0) {
    console.log(`\nPlanned canonical genre creations (${genresToCreate.length}):`);
    for (const g of genresToCreate.slice(0, 15)) {
      console.log(`  + ${g.name} (${g.slug})`);
    }
    if (genresToCreate.length > 15) {
      console.log(`  ... and ${genresToCreate.length - 15} more`);
    }
  }

  if (plannedAdditions.length > 0) {
    console.log(`\nPlanned BookGenre additions (${plannedAdditions.length} books):`);
    for (const a of plannedAdditions.slice(0, 15)) {
      console.log(`  [${a.isbn}] "${a.title}": + ${a.missingSlugs.join('; ')}`);
    }
    if (plannedAdditions.length > 15) {
      console.log(`  ... and ${plannedAdditions.length - 15} more books`);
    }
  }

  if (plannedRemovals.length > 0) {
    console.log(`\nPlanned BookGenre removals (${plannedRemovals.length} books):`);
    for (const r of plannedRemovals.slice(0, 15)) {
      console.log(`  [${r.isbn}] "${r.title}": - ${r.staleSlugs.join('; ')}`);
    }
    if (plannedRemovals.length > 15) {
      console.log(`  ... and ${plannedRemovals.length - 15} more books`);
    }
  }

  if (missingBooks.length > 0) {
    console.error(`\nMissing catalog books (${missingBooks.length}):`);
    for (const m of missingBooks.slice(0, 20)) {
      console.error(`  [${m.isbn}] "${m.title}" by "${m.author}"`);
    }
    if (missingBooks.length > 20) {
      console.error(`  ... and ${missingBooks.length - 20} more`);
    }
  }

  if (ambiguousBooks.length > 0) {
    console.error(`\nAmbiguous work matches (${ambiguousBooks.length}):`);
    for (const a of ambiguousBooks.slice(0, 10)) {
      console.error(`  [${a.isbn}] "${a.title}" by "${a.author}" -> ${a.candidates.length} candidates in DB`);
    }
    if (ambiguousBooks.length > 10) {
      console.error(`  ... and ${ambiguousBooks.length - 10} more`);
    }
  }

  if (bookConflicts.length > 0) {
    console.error(`\nDuplicate production book claims (${bookConflicts.length}):`);
    for (const bc of bookConflicts) {
      console.error(`  DB Book ID ${bc.dbBookId} claimed by multiple catalog rows:`);
      for (const c of bc.claimants) {
        console.error(`    [${c.isbn}] "${c.title}" by "${c.author}"`);
      }
    }
  }

  if (genreConflicts.length > 0) {
    console.error(`\nGenre name/slug conflicts (${genreConflicts.length}):`);
    for (const gc of genreConflicts) {
      console.error(`  ${gc.reason}`);
    }
  }

  if (!preflightSafe && apply) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Catalog genre import failed: ${error?.message ?? String(error)}`);
  if (error instanceof GenreEnrichmentError && error.details?.summary) {
    console.error(JSON.stringify(error.details.summary, null, 2));
  }
  process.exitCode = 1;
} finally {
  if (db?.$disconnect) {
    await db.$disconnect().catch(() => {});
  }
}
