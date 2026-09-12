import { normalizeAuthorName, normalizeIsbn13 } from './normalize.js';
import { titleForWorkIdentity } from './work-identity.js';
import { coverImageUrl } from './csv-import.js';
import { LAUNCH_REPAIR_MANIFEST } from './repair-manifest.js';

export class RepairCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RepairCatalogError';
    this.code = code;
    this.details = details;
  }
}

export function validateManifestEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new RepairCatalogError('invalid_manifest', `Manifest entry at index ${index} must be an object`);
  }
  const oldIsbn = normalizeIsbn13(entry.oldIsbn);
  const desiredIsbn = normalizeIsbn13(entry.desiredIsbn);
  const expectedCurrentTitle = (entry.expectedCurrentTitle || '').trim();
  const expectedCurrentAuthor = (entry.expectedCurrentAuthor || '').trim();
  const desiredTitle = (entry.desiredTitle || '').trim();
  const desiredAuthor = (entry.desiredAuthor || '').trim();

  if (!expectedCurrentTitle) throw new RepairCatalogError('invalid_manifest', `Entry ${index} missing expectedCurrentTitle`);
  if (!expectedCurrentAuthor) throw new RepairCatalogError('invalid_manifest', `Entry ${index} missing expectedCurrentAuthor`);
  if (!desiredTitle) throw new RepairCatalogError('invalid_manifest', `Entry ${index} missing desiredTitle`);
  if (!desiredAuthor) throw new RepairCatalogError('invalid_manifest', `Entry ${index} missing desiredAuthor`);

  return {
    oldIsbn,
    expectedCurrentTitle,
    expectedCurrentAuthor,
    desiredTitle,
    desiredAuthor,
    desiredIsbn,
  };
}

function isCompatibleWork(book, entry) {
  const normBookTitle = titleForWorkIdentity(book.title);
  const normBookAuthor = normalizeAuthorName(book.author);

  const normExpectedTitle = titleForWorkIdentity(entry.expectedCurrentTitle);
  const normExpectedAuthor = normalizeAuthorName(entry.expectedCurrentAuthor);

  if (normBookTitle === normExpectedTitle && normBookAuthor === normExpectedAuthor) {
    return true;
  }

  const normDesiredTitle = titleForWorkIdentity(entry.desiredTitle);
  const normDesiredAuthor = normalizeAuthorName(entry.desiredAuthor);

  if (normBookTitle === normDesiredTitle && normBookAuthor === normDesiredAuthor) {
    return true;
  }

  return false;
}

export async function preflightLaunchRepair(db, manifest = LAUNCH_REPAIR_MANIFEST) {
  const validatedEntries = manifest.map((entry, idx) => validateManifestEntry(entry, idx));

  // Collect all ISBNs we care about
  const oldIsbns = validatedEntries.map(e => e.oldIsbn);
  const desiredIsbns = validatedEntries.map(e => e.desiredIsbn);
  const allIsbns = [...new Set([...oldIsbns, ...desiredIsbns])];

  const existingBooks = await db.book.findMany({
    where: { isbn: { in: allIsbns } },
    select: {
      id: true,
      title: true,
      author: true,
      isbn: true,
      coverImageUrl: true,
    },
  });

  const booksByIsbn = new Map();
  for (const book of existingBooks) {
    booksByIsbn.set(book.isbn, book);
  }

  const repairsToApply = [];
  const alreadyRepairedList = [];
  const genuinelyMissingList = [];
  const missingErrors = [];
  const alternateIdentityMatches = [];
  const ambiguousIdentityMatches = [];
  const identityConflictErrors = [];
  const isbnCollisionErrors = [];
  const unresolvedEntries = [];

  for (const entry of validatedEntries) {
    const bookWithOldIsbn = booksByIsbn.get(entry.oldIsbn);
    const bookWithDesiredIsbn = booksByIsbn.get(entry.desiredIsbn);

    if (entry.desiredIsbn === entry.oldIsbn) {
      // Same-ISBN title/author repair (e.g. Harry Potter, The Painted Man, Captain Corelli, Notes from a Big Country)
      if (!bookWithOldIsbn) {
        unresolvedEntries.push(entry);
        continue;
      }

      const isCurrentMatch =
        titleForWorkIdentity(bookWithOldIsbn.title) === titleForWorkIdentity(entry.expectedCurrentTitle) &&
        normalizeAuthorName(bookWithOldIsbn.author) === normalizeAuthorName(entry.expectedCurrentAuthor);

      const isAlreadyDesired =
        titleForWorkIdentity(bookWithOldIsbn.title) === titleForWorkIdentity(entry.desiredTitle) &&
        normalizeAuthorName(bookWithOldIsbn.author) === normalizeAuthorName(entry.desiredAuthor);

      if (isAlreadyDesired) {
        alreadyRepairedList.push({
          bookId: bookWithOldIsbn.id,
          title: bookWithOldIsbn.title,
          author: bookWithOldIsbn.author,
          isbn: bookWithOldIsbn.isbn,
        });
        continue;
      }

      if (isCurrentMatch) {
        repairsToApply.push({
          bookId: bookWithOldIsbn.id,
          oldTitle: bookWithOldIsbn.title,
          newTitle: entry.desiredTitle,
          oldAuthor: bookWithOldIsbn.author,
          newAuthor: entry.desiredAuthor,
          oldIsbn: entry.oldIsbn,
          newIsbn: entry.desiredIsbn,
          oldCoverImageUrl: bookWithOldIsbn.coverImageUrl,
          newCoverImageUrl: bookWithOldIsbn.coverImageUrl, // preserve existing cover for same-ISBN
        });
      } else {
        identityConflictErrors.push({
          isbn: entry.oldIsbn,
          message: `Book with ISBN ${entry.oldIsbn} has title "${bookWithOldIsbn.title}" by "${bookWithOldIsbn.author}", expected "${entry.expectedCurrentTitle}" by "${entry.expectedCurrentAuthor}"`,
        });
      }
      continue;
    }

    // Different ISBN repair
    if (bookWithOldIsbn) {
      const isCurrentMatch =
        titleForWorkIdentity(bookWithOldIsbn.title) === titleForWorkIdentity(entry.expectedCurrentTitle) &&
        normalizeAuthorName(bookWithOldIsbn.author) === normalizeAuthorName(entry.expectedCurrentAuthor);

      if (!isCurrentMatch) {
        identityConflictErrors.push({
          isbn: entry.oldIsbn,
          message: `Book with ISBN ${entry.oldIsbn} has title "${bookWithOldIsbn.title}" by "${bookWithOldIsbn.author}", expected "${entry.expectedCurrentTitle}" by "${entry.expectedCurrentAuthor}"`,
        });
        continue;
      }

      // Check collision with desiredIsbn
      if (bookWithDesiredIsbn && bookWithDesiredIsbn.id !== bookWithOldIsbn.id) {
        isbnCollisionErrors.push({
          oldIsbn: entry.oldIsbn,
          desiredIsbn: entry.desiredIsbn,
          collisionBookId: bookWithDesiredIsbn.id,
          message: `Target ISBN ${entry.desiredIsbn} is already used by another Book row (id: ${bookWithDesiredIsbn.id}, title: "${bookWithDesiredIsbn.title}")`,
        });
        continue;
      }

      repairsToApply.push({
        bookId: bookWithOldIsbn.id,
        oldTitle: bookWithOldIsbn.title,
        newTitle: entry.desiredTitle,
        oldAuthor: bookWithOldIsbn.author,
        newAuthor: entry.desiredAuthor,
        oldIsbn: entry.oldIsbn,
        newIsbn: entry.desiredIsbn,
        oldCoverImageUrl: bookWithOldIsbn.coverImageUrl,
        newCoverImageUrl: coverImageUrl(entry.desiredIsbn),
      });
    } else {
      // Not found by oldIsbn. Check if already repaired under desiredIsbn
      if (bookWithDesiredIsbn) {
        const isAlreadyDesired =
          titleForWorkIdentity(bookWithDesiredIsbn.title) === titleForWorkIdentity(entry.desiredTitle) &&
          normalizeAuthorName(bookWithDesiredIsbn.author) === normalizeAuthorName(entry.desiredAuthor);

        if (isAlreadyDesired) {
          alreadyRepairedList.push({
            bookId: bookWithDesiredIsbn.id,
            title: bookWithDesiredIsbn.title,
            author: bookWithDesiredIsbn.author,
            isbn: bookWithDesiredIsbn.isbn,
          });
        } else {
          identityConflictErrors.push({
            oldIsbn: entry.oldIsbn,
            desiredIsbn: entry.desiredIsbn,
            message: `Book with old ISBN ${entry.oldIsbn} was not found, and book with target ISBN ${entry.desiredIsbn} has unexpected identity "${bookWithDesiredIsbn.title}" by "${bookWithDesiredIsbn.author}"`,
          });
        }
      } else {
        // Neither oldIsbn nor desiredIsbn exists in the database
        unresolvedEntries.push(entry);
      }
    }
  }

  // Identity fallback search for unresolved entries
  if (unresolvedEntries.length > 0) {
    const candidateBooks = await db.book.findMany({
      select: {
        id: true,
        title: true,
        author: true,
        isbn: true,
      },
    });

    for (const entry of unresolvedEntries) {
      const matching = candidateBooks.filter(
        book =>
          isCompatibleWork(book, entry) &&
          book.isbn !== entry.oldIsbn &&
          book.isbn !== entry.desiredIsbn
      );

      if (matching.length === 1) {
        alternateIdentityMatches.push({
          bookId: matching[0].id,
          title: matching[0].title,
          author: matching[0].author,
          currentIsbn: matching[0].isbn,
          manifestOldIsbn: entry.oldIsbn,
          desiredIsbn: entry.desiredIsbn,
        });
      } else if (matching.length > 1) {
        ambiguousIdentityMatches.push({
          manifestOldIsbn: entry.oldIsbn,
          desiredIsbn: entry.desiredIsbn,
          expectedTitle: entry.expectedCurrentTitle,
          expectedAuthor: entry.expectedCurrentAuthor,
          candidates: matching.map(b => ({
            bookId: b.id,
            title: b.title,
            author: b.author,
            currentIsbn: b.isbn,
          })),
          message: `Multiple candidate books (${matching.length}) found for work "${entry.expectedCurrentTitle}" by "${entry.expectedCurrentAuthor}"`,
        });
      } else {
        const errorItem = {
          isbn: entry.oldIsbn,
          desiredIsbn: entry.desiredIsbn,
          title: entry.expectedCurrentTitle,
          author: entry.expectedCurrentAuthor,
          message: `Book with old ISBN ${entry.oldIsbn} was not found in the database, and no compatible work was found`,
        };
        genuinelyMissingList.push(errorItem);
        missingErrors.push(errorItem);
      }
    }
  }

  const foundCount = repairsToApply.length + alreadyRepairedList.length;

  const summary = {
    repairEntries: validatedEntries.length,
    found: foundCount,
    alreadyRepaired: alreadyRepairedList.length,
    missing: missingErrors.length,
    genuinelyMissing: genuinelyMissingList.length,
    alternateIdentityMatches: alternateIdentityMatches.length,
    ambiguousIdentityMatches: ambiguousIdentityMatches.length,
    identityConflicts: identityConflictErrors.length,
    isbnCollisions: isbnCollisionErrors.length,
    readyToRepair: repairsToApply.length,
    updated: 0,
  };

  return {
    summary,
    details: {
      repairsToApply,
      alreadyRepairedList,
      missingErrors,
      genuinelyMissingList,
      alternateIdentityMatches,
      ambiguousIdentityMatches,
      identityConflictErrors,
      isbnCollisionErrors,
    },
  };
}

export async function repairLaunchCatalog(db, { apply = false, manifest = LAUNCH_REPAIR_MANIFEST } = {}) {
  const preflight = await preflightLaunchRepair(db, manifest);
  const { summary, details } = preflight;

  const hasErrors =
    summary.missing > 0 ||
    summary.genuinelyMissing > 0 ||
    summary.alternateIdentityMatches > 0 ||
    summary.ambiguousIdentityMatches > 0 ||
    summary.identityConflicts > 0 ||
    summary.isbnCollisions > 0;

  if (apply) {
    if (hasErrors) {
      const parts = [];
      if (summary.genuinelyMissing > 0) parts.push(`${summary.genuinelyMissing} genuinely missing`);
      if (summary.alternateIdentityMatches > 0) parts.push(`${summary.alternateIdentityMatches} alternate matches`);
      if (summary.ambiguousIdentityMatches > 0) parts.push(`${summary.ambiguousIdentityMatches} ambiguous matches`);
      if (summary.identityConflicts > 0) parts.push(`${summary.identityConflicts} identity conflicts`);
      if (summary.isbnCollisions > 0) parts.push(`${summary.isbnCollisions} collisions`);

      throw new RepairCatalogError(
        'preflight_failed',
        `Preflight checks failed with ${parts.join(', ')}`,
        { summary, details }
      );
    }

    if (details.repairsToApply.length === 0) {
      return {
        summary: { ...summary, updated: 0 },
        details,
        applied: true,
      };
    }

    await db.$transaction(async tx => {
      for (const repair of details.repairsToApply) {
        await tx.book.update({
          where: { id: repair.bookId },
          data: {
            title: repair.newTitle,
            author: repair.newAuthor,
            isbn: repair.newIsbn,
            coverImageUrl: repair.newCoverImageUrl,
          },
        });
      }

      // Post-repair verification in transaction
      const targetIds = details.repairsToApply.map(r => r.bookId);
      const reloaded = await tx.book.findMany({
        where: { id: { in: targetIds } },
        select: {
          id: true,
          title: true,
          author: true,
          isbn: true,
          coverImageUrl: true,
        },
      });

      const reloadedById = new Map(reloaded.map(b => [b.id, b]));
      for (const repair of details.repairsToApply) {
        const book = reloadedById.get(repair.bookId);
        if (!book) {
          throw new Error(`Integrity error: Book ID ${repair.bookId} was missing after update`);
        }
        if (book.title !== repair.newTitle) {
          throw new Error(`Verification error: Book ${book.id} title "${book.title}" did not match desired "${repair.newTitle}"`);
        }
        if (book.author !== repair.newAuthor) {
          throw new Error(`Verification error: Book ${book.id} author "${book.author}" did not match desired "${repair.newAuthor}"`);
        }
        if (book.isbn !== repair.newIsbn) {
          throw new Error(`Verification error: Book ${book.id} ISBN "${book.isbn}" did not match desired "${repair.newIsbn}"`);
        }
        if (repair.newCoverImageUrl && book.coverImageUrl !== repair.newCoverImageUrl) {
          throw new Error(`Verification error: Book ${book.id} coverImageUrl "${book.coverImageUrl}" did not match desired "${repair.newCoverImageUrl}"`);
        }
      }
    });

    return {
      summary: { ...summary, updated: details.repairsToApply.length },
      details,
      applied: true,
    };
  }

  return {
    summary,
    details,
    applied: false,
  };
}
