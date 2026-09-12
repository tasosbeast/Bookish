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
  const missingErrors = [];
  const identityConflictErrors = [];
  const isbnCollisionErrors = [];

  for (const entry of validatedEntries) {
    const bookWithOldIsbn = booksByIsbn.get(entry.oldIsbn);
    const bookWithDesiredIsbn = booksByIsbn.get(entry.desiredIsbn);

    if (entry.desiredIsbn === entry.oldIsbn) {
      // Same-ISBN title/author repair (e.g. Harry Potter, The Painted Man, Captain Corelli, Notes from a Big Country)
      if (!bookWithOldIsbn) {
        missingErrors.push({
          isbn: entry.oldIsbn,
          message: `Book with ISBN ${entry.oldIsbn} was not found in the database`,
        });
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
        missingErrors.push({
          isbn: entry.oldIsbn,
          message: `Book with old ISBN ${entry.oldIsbn} was not found in the database`,
        });
      }
    }
  }

  const foundCount = repairsToApply.length + alreadyRepairedList.length;

  const summary = {
    repairEntries: validatedEntries.length,
    found: foundCount,
    alreadyRepaired: alreadyRepairedList.length,
    missing: missingErrors.length,
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
      identityConflictErrors,
      isbnCollisionErrors,
    },
  };
}

export async function repairLaunchCatalog(db, { apply = false, manifest = LAUNCH_REPAIR_MANIFEST } = {}) {
  const preflight = await preflightLaunchRepair(db, manifest);
  const { summary, details } = preflight;

  const hasErrors = summary.missing > 0 || summary.identityConflicts > 0 || summary.isbnCollisions > 0;

  if (apply) {
    if (hasErrors) {
      throw new RepairCatalogError(
        'preflight_failed',
        `Preflight checks failed with ${summary.missing} missing, ${summary.identityConflicts} conflicts, and ${summary.isbnCollisions} collisions`,
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
