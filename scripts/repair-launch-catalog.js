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

  const { repairsToApply, alreadyRepairedList, missingErrors, identityConflictErrors, isbnCollisionErrors } = result.details;

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

  const hasIssues = missingErrors.length > 0 || identityConflictErrors.length > 0 || isbnCollisionErrors.length > 0;

  if (hasIssues) {
    if (missingErrors.length > 0) {
      console.error(`\nMissing old books (${missingErrors.length}):`);
      for (const m of missingErrors) {
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
    if (apply) {
      process.exitCode = 1;
    }
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
