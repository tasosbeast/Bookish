import 'dotenv/config';
import { repairLaunchCatalog, RepairCatalogError } from './catalog/repair-launch.js';
import { LAUNCH_REPAIR_MANIFEST } from './catalog/repair-manifest.js';

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

  const result = await repairLaunchCatalog(db, { apply, manifest: LAUNCH_REPAIR_MANIFEST });

  console.log(JSON.stringify(result.summary, null, 2));

  const {
    repairsToApply,
    alreadyRepairedList,
    missingErrors,
    genuinelyMissingList,
    alternateIdentityMatches,
    ambiguousIdentityMatches,
    identityConflictErrors,
    isbnCollisionErrors,
  } = result.details;

  if (repairsToApply.length > 0) {
    console.log(`\nReady to repair (${repairsToApply.length}):`);
    for (const r of repairsToApply.slice(0, 30)) {
      console.log(`  [${r.bookId}]`);
      console.log(`    Title:  "${r.oldTitle}" -> "${r.newTitle}"`);
      console.log(`    Author: "${r.oldAuthor}" -> "${r.newAuthor}"`);
      console.log(`    ISBN:   ${r.oldIsbn} -> ${r.newIsbn}`);
    }
  }

  if (alreadyRepairedList.length > 0) {
    console.log(`\nAlready repaired (${alreadyRepairedList.length}):`);
    for (const r of alreadyRepairedList.slice(0, 10)) {
      console.log(`  [${r.bookId}] "${r.title}" by "${r.author}" (${r.isbn})`);
    }
  }

  if (alternateIdentityMatches && alternateIdentityMatches.length > 0) {
    console.log(`\nAlternate identity matches (diagnostic only) (${alternateIdentityMatches.length}):`);
    for (const a of alternateIdentityMatches) {
      console.log(`  [${a.bookId}]`);
      console.log(`    Title:          "${a.title}"`);
      console.log(`    Author:         "${a.author}"`);
      console.log(`    Current ISBN:   ${a.currentIsbn}`);
      console.log(`    Manifest Old:   ${a.manifestOldIsbn}`);
      console.log(`    Desired ISBN:   ${a.desiredIsbn}`);
    }
  }

  if (ambiguousIdentityMatches && ambiguousIdentityMatches.length > 0) {
    console.error(`\nAmbiguous identity matches (${ambiguousIdentityMatches.length}):`);
    for (const amb of ambiguousIdentityMatches) {
      console.error(`  Expected: "${amb.expectedTitle}" by "${amb.expectedAuthor}" (old ISBN: ${amb.manifestOldIsbn}, desired ISBN: ${amb.desiredIsbn})`);
      console.error(`  Candidates (${amb.candidates.length}):`);
      for (const c of amb.candidates) {
        console.error(`    [${c.bookId}] "${c.title}" by "${c.author}" (ISBN: ${c.currentIsbn})`);
      }
    }
  }

  const missingList = genuinelyMissingList?.length > 0 ? genuinelyMissingList : missingErrors;
  if (missingList && missingList.length > 0) {
    console.error(`\nGenuinely missing (${missingList.length}):`);
    for (const m of missingList) {
      console.error(`  ISBN ${m.isbn}: ${m.message}`);
    }
  }

  if (identityConflictErrors.length > 0) {
    console.error(`\nIdentity conflicts (${identityConflictErrors.length}):`);
    for (const c of identityConflictErrors) {
      console.error(`  ${c.message}`);
    }
  }

  if (isbnCollisionErrors.length > 0) {
    console.error(`\nTarget ISBN collisions (${isbnCollisionErrors.length}):`);
    for (const c of isbnCollisionErrors) {
      console.error(`  ${c.message}`);
    }
  }

  const hasIssues =
    (missingList?.length ?? 0) > 0 ||
    (alternateIdentityMatches?.length ?? 0) > 0 ||
    (ambiguousIdentityMatches?.length ?? 0) > 0 ||
    identityConflictErrors.length > 0 ||
    isbnCollisionErrors.length > 0;

  if (hasIssues && apply) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Launch catalog repair failed: ${error?.message ?? String(error)}`);
  if (error instanceof RepairCatalogError && error.details?.summary) {
    console.error(JSON.stringify(error.details.summary, null, 2));
  }
  process.exitCode = 1;
} finally {
  if (db?.$disconnect) {
    await db.$disconnect().catch(() => {});
  }
}
