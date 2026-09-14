import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { normalizeIsbn13 } from './normalize.js';

export class PublicationDateEnrichmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PublicationDateEnrichmentError';
    this.code = code;
    this.details = details;
  }
}

export function isValidCalendarDate(val) {
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return false;
  }
  const [year, month, day] = val.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function isValidHttpsUrl(val) {
  if (typeof val !== 'string' || !val.trim()) {
    return false;
  }
  try {
    const u = new URL(val.trim());
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function loadCanonicalCatalogIsbns(catalogPath = path.resolve('scripts/catalog-books.csv')) {
  if (!fs.existsSync(catalogPath)) {
    throw new PublicationDateEnrichmentError('catalog_missing', `Canonical catalog not found: ${catalogPath}`);
  }
  const content = fs.readFileSync(catalogPath, 'utf8');
  const records = parse(content, {
    bom: true,
    trim: true,
    skip_empty_lines: true,
    columns: true,
  });
  const isbns = new Set();
  for (const record of records) {
    if (record.isbn) {
      try {
        isbns.add(normalizeIsbn13(record.isbn));
      } catch {
        isbns.add(record.isbn.replace(/[ -]/g, ''));
      }
    }
  }
  return isbns;
}

export function parsePublicationDatesCsv(csvContent) {
  if (typeof csvContent !== 'string' && !Buffer.isBuffer(csvContent)) {
    throw new PublicationDateEnrichmentError('invalid_input', 'CSV content must be a string or Buffer');
  }

  const text = Buffer.isBuffer(csvContent) ? csvContent.toString('utf8') : csvContent;
  if (!text.trim()) {
    return [];
  }

  let headerSeen = false;
  let rawRecords;
  try {
    rawRecords = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      info: true,
      columns: header => {
        headerSeen = true;
        if (!Array.isArray(header) || header.length !== 3) {
          throw new PublicationDateEnrichmentError(
            'invalid_header',
            `CSV header must have exactly 3 columns: isbn,publicationDate,sourceUrl (found ${header?.length ?? 0} columns)`
          );
        }
        const trimmed = header.map(h => typeof h === 'string' ? h.trim() : '');
        if (trimmed[0] !== 'isbn' || trimmed[1] !== 'publicationDate' || trimmed[2] !== 'sourceUrl') {
          throw new PublicationDateEnrichmentError(
            'invalid_header',
            `CSV header columns must be isbn,publicationDate,sourceUrl (found: ${header.join(',')})`
          );
        }
        return ['isbn', 'publicationDate', 'sourceUrl'];
      },
    });
  } catch (err) {
    if (err instanceof PublicationDateEnrichmentError) {
      throw err;
    }
    throw new PublicationDateEnrichmentError('parse_error', `Failed to parse CSV: ${err.message}`, { originalError: err });
  }

  if (!headerSeen) {
    return [];
  }

  return rawRecords;
}

export function validatePublicationDateRecords(rawRecords, canonicalIsbns) {
  const validationErrors = [];
  const validRecords = [];
  const seenIsbns = new Set();

  for (const item of rawRecords) {
    const { record, info } = item;
    const line = info?.lines ?? null;
    const rawIsbn = typeof record.isbn === 'string' ? record.isbn.trim() : '';
    const rawDate = typeof record.publicationDate === 'string' ? record.publicationDate.trim() : '';
    const rawUrl = typeof record.sourceUrl === 'string' ? record.sourceUrl.trim() : '';

    let isRecordValid = true;
    let normalizedIsbn = null;

    // 1. ISBN validation
    if (!rawIsbn) {
      validationErrors.push({
        line,
        isbn: rawIsbn,
        field: 'isbn',
        message: 'ISBN is required',
      });
      isRecordValid = false;
    } else {
      try {
        normalizedIsbn = normalizeIsbn13(rawIsbn);
      } catch {
        validationErrors.push({
          line,
          isbn: rawIsbn,
          field: 'isbn',
          message: `Invalid ISBN-13: "${rawIsbn}"`,
        });
        isRecordValid = false;
      }
    }

    if (normalizedIsbn) {
      if (seenIsbns.has(normalizedIsbn)) {
        validationErrors.push({
          line,
          isbn: normalizedIsbn,
          field: 'isbn',
          message: `Duplicate ISBN "${normalizedIsbn}" in source file`,
        });
        isRecordValid = false;
      } else {
        seenIsbns.add(normalizedIsbn);
      }

      if (!canonicalIsbns.has(normalizedIsbn)) {
        validationErrors.push({
          line,
          isbn: normalizedIsbn,
          field: 'isbn',
          message: `ISBN "${normalizedIsbn}" does not exist in canonical catalog (scripts/catalog-books.csv)`,
        });
        isRecordValid = false;
      }
    }

    // 2. publicationDate validation
    if (!rawDate) {
      validationErrors.push({
        line,
        isbn: normalizedIsbn || rawIsbn,
        field: 'publicationDate',
        message: 'publicationDate is required',
      });
      isRecordValid = false;
    } else if (!isValidCalendarDate(rawDate)) {
      validationErrors.push({
        line,
        isbn: normalizedIsbn || rawIsbn,
        field: 'publicationDate',
        value: rawDate,
        message: `Invalid publicationDate: "${rawDate}". Must be a valid calendar date in YYYY-MM-DD format.`,
      });
      isRecordValid = false;
    }

    // 3. sourceUrl validation
    if (!rawUrl) {
      validationErrors.push({
        line,
        isbn: normalizedIsbn || rawIsbn,
        field: 'sourceUrl',
        message: 'sourceUrl is required',
      });
      isRecordValid = false;
    } else if (!isValidHttpsUrl(rawUrl)) {
      validationErrors.push({
        line,
        isbn: normalizedIsbn || rawIsbn,
        field: 'sourceUrl',
        value: rawUrl,
        message: `Invalid sourceUrl: "${rawUrl}". Must be a valid HTTPS URL.`,
      });
      isRecordValid = false;
    }

    if (isRecordValid) {
      validRecords.push({
        isbn: normalizedIsbn,
        publicationDate: rawDate,
        sourceUrl: rawUrl,
        line,
      });
    }
  }

  return { validationErrors, validRecords };
}

export async function enrichCatalogPublicationDates(db, options = {}) {
  const {
    source = path.resolve('scripts/catalog-publication-dates.csv'),
    catalogPath = path.resolve('scripts/catalog-books.csv'),
    apply = false,
  } = options;

  let csvContent = options.csvContent;
  if (csvContent === undefined) {
    if (!fs.existsSync(source)) {
      throw new PublicationDateEnrichmentError('source_missing', `Source file not found: ${source}`);
    }
    csvContent = fs.readFileSync(source, 'utf8');
  }

  const rawRecords = parsePublicationDatesCsv(csvContent);
  const canonicalIsbns = options.canonicalIsbns || loadCanonicalCatalogIsbns(catalogPath);

  const { validationErrors, validRecords } = validatePublicationDateRecords(rawRecords, canonicalIsbns);

  const details = {
    validationErrors,
    missingDatabaseBooks: [],
    conflictingExistingDates: [],
    publicationYearMismatches: [],
    alreadyCorrect: [],
    needsUpdate: [],
  };

  let matchedDatabaseBooks = 0;

  if (validRecords.length > 0) {
    const isbns = validRecords.map(r => r.isbn);
    const dbBooks = await db.book.findMany({
      where: { isbn: { in: isbns } },
      select: {
        id: true,
        isbn: true,
        title: true,
        publicationYear: true,
        publicationDate: true,
      },
    });

    const dbBooksByIsbn = new Map(dbBooks.map(b => [b.isbn, b]));

    for (const record of validRecords) {
      const dbBook = dbBooksByIsbn.get(record.isbn);
      if (!dbBook) {
        details.missingDatabaseBooks.push({
          isbn: record.isbn,
          requestedDate: record.publicationDate,
          sourceUrl: record.sourceUrl,
          line: record.line,
          message: `Book with ISBN ${record.isbn} not found in database`,
        });
        continue;
      }

      matchedDatabaseBooks++;

      const sourceYear = parseInt(record.publicationDate.slice(0, 4), 10);
      const dbDateStr = dbBook.publicationDate
        ? (dbBook.publicationDate instanceof Date
            ? dbBook.publicationDate.toISOString().slice(0, 10)
            : String(dbBook.publicationDate).slice(0, 10))
        : null;

      let isBlocked = false;

      // Check publicationYearMismatch (allowed if dbBook.publicationYear is null)
      if (dbBook.publicationYear !== null && dbBook.publicationYear !== undefined && dbBook.publicationYear !== sourceYear) {
        details.publicationYearMismatches.push({
          isbn: record.isbn,
          title: dbBook.title,
          databaseYear: dbBook.publicationYear,
          requestedYear: sourceYear,
          requestedDate: record.publicationDate,
          line: record.line,
          message: `Database publicationYear (${dbBook.publicationYear}) does not match requested year (${sourceYear})`,
        });
        isBlocked = true;
      }

      // Check conflictingExistingDate
      if (dbDateStr !== null && dbDateStr !== record.publicationDate) {
        details.conflictingExistingDates.push({
          isbn: record.isbn,
          title: dbBook.title,
          databaseDate: dbDateStr,
          requestedDate: record.publicationDate,
          line: record.line,
          message: `Database already has a different publicationDate (${dbDateStr} vs ${record.publicationDate})`,
        });
        isBlocked = true;
      }

      if (isBlocked) {
        continue;
      }

      if (dbDateStr === record.publicationDate) {
        details.alreadyCorrect.push({
          bookId: dbBook.id,
          isbn: record.isbn,
          title: dbBook.title,
          publicationDate: dbDateStr,
        });
      } else if (dbDateStr === null) {
        details.needsUpdate.push({
          bookId: dbBook.id,
          isbn: record.isbn,
          title: dbBook.title,
          publicationDate: record.publicationDate,
        });
      }
    }
  }

  const preflightSafe = (
    details.validationErrors.length === 0 &&
    details.missingDatabaseBooks.length === 0 &&
    details.conflictingExistingDates.length === 0 &&
    details.publicationYearMismatches.length === 0
  );

  const summary = {
    sourceRows: rawRecords.length,
    matchedDatabaseBooks,
    alreadyCorrect: details.alreadyCorrect.length,
    needsUpdate: details.needsUpdate.length,
    missingDatabaseBooks: details.missingDatabaseBooks.length,
    conflictingExistingDates: details.conflictingExistingDates.length,
    publicationYearMismatches: details.publicationYearMismatches.length,
    updated: 0,
    preflightSafe,
  };

  if (apply) {
    if (!preflightSafe) {
      const issues = [];
      if (details.validationErrors.length > 0) issues.push(`${details.validationErrors.length} validation error(s)`);
      if (details.missingDatabaseBooks.length > 0) issues.push(`${details.missingDatabaseBooks.length} missing database book(s)`);
      if (details.conflictingExistingDates.length > 0) issues.push(`${details.conflictingExistingDates.length} conflicting existing date(s)`);
      if (details.publicationYearMismatches.length > 0) issues.push(`${details.publicationYearMismatches.length} publication year mismatch(es)`);
      throw new PublicationDateEnrichmentError(
        'preflight_blocked',
        `Cannot apply: preflight blockers detected (${issues.join(', ')})`,
        { summary, details }
      );
    }

    if (details.needsUpdate.length > 0) {
      await db.$transaction(async tx => {
        // Revalidate every planned needsUpdate row inside transaction before ANY writes
        const plannedIds = details.needsUpdate.map(u => u.bookId);
        const currentBooks = await tx.book.findMany({
          where: { id: { in: plannedIds } },
          select: {
            id: true,
            isbn: true,
            title: true,
            publicationYear: true,
            publicationDate: true,
          },
        });
        const currentBooksById = new Map(currentBooks.map(b => [b.id, b]));

        for (const item of details.needsUpdate) {
          const current = currentBooksById.get(item.bookId);
          if (!current) {
            throw new PublicationDateEnrichmentError(
              'stale_preflight',
              `Stale preflight: book ${item.isbn} no longer exists in database`,
              { isbn: item.isbn, bookId: item.bookId }
            );
          }

          if (current.isbn !== item.isbn) {
            throw new PublicationDateEnrichmentError(
              'stale_preflight',
              `Stale preflight: book ${item.bookId} ISBN changed from ${item.isbn} to ${current.isbn}`,
              { isbn: item.isbn, bookId: item.bookId }
            );
          }

          if (current.publicationDate !== null && current.publicationDate !== undefined) {
            const currentStr = current.publicationDate instanceof Date
              ? current.publicationDate.toISOString().slice(0, 10)
              : String(current.publicationDate).slice(0, 10);
            throw new PublicationDateEnrichmentError(
              'stale_preflight',
              `Stale preflight: book ${item.isbn} publicationDate was modified to ${currentStr} after preflight`,
              { isbn: item.isbn, bookId: item.bookId, currentPublicationDate: currentStr, plannedPublicationDate: item.publicationDate }
            );
          }

          const requestedYear = parseInt(item.publicationDate.slice(0, 4), 10);
          if (current.publicationYear !== null && current.publicationYear !== undefined && current.publicationYear !== requestedYear) {
            throw new PublicationDateEnrichmentError(
              'stale_preflight',
              `Stale preflight: book ${item.isbn} publicationYear changed to ${current.publicationYear}, mismatching requested year ${requestedYear}`,
              { isbn: item.isbn, bookId: item.bookId, currentPublicationYear: current.publicationYear, requestedYear }
            );
          }
        }

        // All planned rows passed revalidation; now perform updates
        for (const item of details.needsUpdate) {
          await tx.book.update({
            where: { id: item.bookId },
            data: {
              publicationDate: new Date(`${item.publicationDate}T00:00:00.000Z`),
            },
          });
        }

        // Re-read affected rows and verify stored values
        const updatedIds = details.needsUpdate.map(u => u.bookId);
        const reloaded = await tx.book.findMany({
          where: { id: { in: updatedIds } },
          select: { id: true, isbn: true, publicationDate: true },
        });
        const reloadedById = new Map(reloaded.map(b => [b.id, b]));

        for (const item of details.needsUpdate) {
          const stored = reloadedById.get(item.bookId);
          if (!stored || !stored.publicationDate) {
            throw new PublicationDateEnrichmentError(
              'verification_failed',
              `Verification failed for book ${item.isbn}: expected publicationDate ${item.publicationDate}, found null`
            );
          }
          const storedStr = stored.publicationDate instanceof Date
            ? stored.publicationDate.toISOString().slice(0, 10)
            : String(stored.publicationDate).slice(0, 10);
          if (storedStr !== item.publicationDate) {
            throw new PublicationDateEnrichmentError(
              'verification_failed',
              `Verification failed for book ${item.isbn}: expected publicationDate ${item.publicationDate}, found ${storedStr}`
            );
          }
        }
      });

      summary.updated = details.needsUpdate.length;
    }
  }

  return { summary, details };
}
