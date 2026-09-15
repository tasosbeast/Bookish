import 'dotenv/config';
import { syncPrhReleases, PrhSyncError } from './catalog/prh-sync.js';

let db;

try {
  const args = process.argv.slice(2);
  let apply = false;
  let asOf;
  let from;
  let to;
  let maxNew;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--dry-run') {
      apply = false;
    } else if (arg === '--as-of') {
      const val = args[++i];
      if (!val) throw new Error('--as-of requires a YYYY-MM-DD date argument');
      asOf = val;
    } else if (arg === '--from') {
      const val = args[++i];
      if (!val) throw new Error('--from requires a YYYY-MM-DD date argument');
      from = val;
    } else if (arg === '--to') {
      const val = args[++i];
      if (!val) throw new Error('--to requires a YYYY-MM-DD date argument');
      to = val;
    } else if (arg === '--max-new') {
      const val = args[++i];
      if (!val) throw new Error('--max-new requires an integer argument');
      maxNew = parseInt(val, 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const apiKey = process.env.PRH_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    console.error('Error: PRH sync requires PRH_API_KEY to be set in environment.');
    process.exit(1);
  }

  db = (await import('../src/lib/prisma.js')).prisma;

  console.log(`\nMode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  const result = await syncPrhReleases(db, {
    apiKey,
    apply,
    asOf,
    from,
    to,
    maxNew,
  });

  console.log(JSON.stringify(result.summary, null, 2));

  const { details } = result;

  // Print refresh details if any
  if (details.refresh.dateChanged.length > 0) {
    console.log(`\nRefresh: Date changed (${details.refresh.dateChanged.length}):`);
    for (const item of details.refresh.dateChanged) {
      console.log(`  [${item.isbn}] "${item.title}": ${item.previousDate} -> ${item.remoteOnsale}`);
    }
  }
  if (details.refresh.localDivergence.length > 0) {
    console.log(`\nRefresh: Local divergence protected (${details.refresh.localDivergence.length}):`);
    for (const item of details.refresh.localDivergence) {
      console.log(`  [${item.isbn}] "${item.title}": book date ${item.bookPublicationDate} vs verified ${item.verifiedPublicationDate}`);
    }
  }
  if (details.refresh.identityConflicts.length > 0) {
    console.warn(`\nRefresh: Identity conflicts (${details.refresh.identityConflicts.length}):`);
    for (const item of details.refresh.identityConflicts) {
      console.warn(`  [${item.isbn}] "${item.title}": ${item.reason}`);
    }
  }
  if (details.refresh.remoteMissing.length > 0) {
    console.warn(`\nRefresh: Remote missing (${details.refresh.remoteMissing.length}):`);
    for (const item of details.refresh.remoteMissing) {
      console.warn(`  [${item.isbn}] "${item.title}": ${item.reason}`);
    }
  }
  if (details.refresh.remoteInvalid.length > 0) {
    console.warn(`\nRefresh: Remote invalid (${details.refresh.remoteInvalid.length}):`);
    for (const item of details.refresh.remoteInvalid) {
      console.warn(`  [${item.isbn}] "${item.title}": ${item.reason}`);
    }
  }

  // Print discovery details if any
  if (details.discovery.plannedNew.length > 0) {
    console.log(`\nDiscovery: Planned new books (${details.discovery.plannedNew.length}):`);
    for (const item of details.discovery.plannedNew) {
      console.log(`  [${item.isbn}] "${item.title}" by "${item.author}" (${item.publicationDate}) [${item.genres.join(', ')}]`);
    }
  }
  if (details.discovery.deferredByLimit.length > 0) {
    console.log(`\nDiscovery: Deferred by limit (${details.discovery.deferredByLimit.length}):`);
    for (const item of details.discovery.deferredByLimit.slice(0, 10)) {
      console.log(`  [${item.isbn}] "${item.title}" (${item.publicationDate})`);
    }
    if (details.discovery.deferredByLimit.length > 10) {
      console.log(`  ... and ${details.discovery.deferredByLimit.length - 10} more`);
    }
  }
  if (details.discovery.workCollisions.length > 0) {
    console.log(`\nDiscovery: Work collisions (${details.discovery.workCollisions.length}):`);
    for (const item of details.discovery.workCollisions.slice(0, 10)) {
      console.log(`  [${item.isbn}] "${item.title}" by "${item.author}": ${item.reason}`);
    }
  }
  if (details.discovery.unmappedGenres.length > 0) {
    console.log(`\nDiscovery: Unmapped genres (${details.discovery.unmappedGenres.length}):`);
    for (const item of details.discovery.unmappedGenres.slice(0, 10)) {
      console.log(`  [${item.isbn}] "${item.title}": ${item.reason}`);
    }
  }

  if (apply) {
    if (result.summary.refresh.updated > 0 || result.summary.refresh.verified > 0) {
      console.log(`\nRefresh applied: ${result.summary.refresh.updated} updated, ${result.summary.refresh.verified} verified.`);
    }
    if (result.summary.discovery.created > 0) {
      console.log(`Discovery applied: ${result.summary.discovery.created} release book(s) created.`);
    }
  }
} catch (error) {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (db) {
    await db.$disconnect();
  }
}
