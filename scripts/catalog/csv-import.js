import { parse } from 'csv-parse/sync';
import { normalizeIsbn13 } from './normalize.js';
import { compatibleIdentity, workIdentity } from './work-identity.js';

export class CsvCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CsvCatalogError';
    this.code = code;
    this.details = details;
  }
}

export function coverImageUrl(isbn) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
}

export function parseCatalogCsv(csvContent) {
  if (typeof csvContent !== 'string' && !Buffer.isBuffer(csvContent)) {
    throw new CsvCatalogError('invalid_input', 'CSV content must be a string or Buffer');
  }

  const text = Buffer.isBuffer(csvContent) ? csvContent.toString('utf8') : csvContent;
  if (!text.trim()) {
    throw new CsvCatalogError('empty_file', 'CSV content is empty');
  }

  let rawRecords;
  let headerSeen = false;
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
          throw new CsvCatalogError(
            'invalid_header',
            `CSV header must have exactly 3 columns: title, author, isbn (found ${header?.length ?? 0} columns)`
          );
        }
        const normalized = header.map(h => typeof h === 'string' ? h.trim().toLowerCase() : '');
        if (normalized[0] !== 'title' || normalized[1] !== 'author' || normalized[2] !== 'isbn') {
          throw new CsvCatalogError(
            'invalid_header',
            `CSV header columns must be title, author, isbn (found: ${header.join(', ')})`
          );
        }
        return ['title', 'author', 'isbn'];
      },
    });
  } catch (err) {
    if (err instanceof CsvCatalogError) {
      throw err;
    }
    throw new CsvCatalogError('parse_error', `Failed to parse CSV: ${err.message}`, { originalError: err });
  }

  if (!headerSeen) {
    throw new CsvCatalogError('missing_header', 'CSV is missing a header row');
  }

  const validRows = [];
  const invalidRows = [];

  for (const item of rawRecords) {
    const { record, info } = item;
    const line = info.lines;
    const row = info.records;

    if (info.error) {
      invalidRows.push({
        line,
        row,
        message: `Malformed CSV row: ${info.error.message || 'inconsistent column count'}`,
        code: 'malformed_row',
      });
      continue;
    }

    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const author = typeof record.author === 'string' ? record.author.trim() : '';
    const rawIsbn = typeof record.isbn === 'string' ? record.isbn.trim() : '';

    const errors = [];
    if (!title) {
      errors.push({ line, row, message: 'Missing required field: title', code: 'missing_title' });
    }
    if (!author) {
      errors.push({ line, row, message: 'Missing required field: author', code: 'missing_author' });
    }
    if (!rawIsbn) {
      errors.push({ line, row, message: 'Missing required field: isbn', code: 'missing_isbn' });
    }

    let normalizedIsbn = null;
    if (rawIsbn) {
      try {
        normalizedIsbn = normalizeIsbn13(rawIsbn);
      } catch (err) {
        errors.push({
          line,
          row,
          isbn: rawIsbn,
          message: `Invalid ISBN-13: ${err.message}`,
          code: 'invalid_isbn',
        });
      }
    }

    if (errors.length > 0) {
      for (const err of errors) {
        invalidRows.push(err);
      }
      continue;
    }

    validRows.push({
      line,
      row,
      title,
      author,
      isbn: normalizedIsbn,
      rawTitle: record.title,
      rawAuthor: record.author,
      rawIsbn: record.isbn,
    });
  }

  // Detect in-CSV duplicates among valid rows
  const seenIsbns = new Map();
  const seenWorks = new Map();
  const duplicateIsbns = [];
  const duplicateWorks = [];
  const duplicateRowIndices = new Set();

  for (let i = 0; i < validRows.length; i++) {
    const item = validRows[i];
    const workId = workIdentity(item);

    const previousIsbn = seenIsbns.get(item.isbn);
    if (previousIsbn) {
      duplicateIsbns.push({
        line: item.line,
        row: item.row,
        isbn: item.isbn,
        title: item.title,
        author: item.author,
        firstSeenLine: previousIsbn.line,
        firstSeenRow: previousIsbn.row,
      });
      duplicateRowIndices.add(i);
    } else {
      seenIsbns.set(item.isbn, item);
    }

    const previousWork = seenWorks.get(workId);
    if (previousWork) {
      duplicateWorks.push({
        line: item.line,
        row: item.row,
        workIdentity: workId,
        title: item.title,
        author: item.author,
        isbn: item.isbn,
        firstSeenLine: previousWork.line,
        firstSeenRow: previousWork.row,
        firstSeenIsbn: previousWork.isbn,
      });
      duplicateRowIndices.add(i);
    } else {
      seenWorks.set(workId, item);
    }
  }

  const uniqueValidRows = validRows.filter((_, idx) => !duplicateRowIndices.has(idx));

  return {
    sourceRows: rawRecords.length,
    validRows,
    invalidRows,
    duplicateIsbns,
    duplicateWorks,
    uniqueValidRows,
  };
}

export async function classifyCsvCatalog(db, candidateRows) {
  const existing = await db.book.findMany({
    select: { id: true, isbn: true, title: true, author: true },
  });

  const existingByIsbn = new Map();
  const existingByWork = new Map();

  for (const book of existing) {
    if (book.isbn) {
      existingByIsbn.set(book.isbn, book);
    }
    const id = workIdentity(book);
    const list = existingByWork.get(id) || [];
    list.push(book);
    existingByWork.set(id, list);
  }

  let matchedExactIsbn = 0;
  let matchedExistingWork = 0;
  const conflicts = [];
  const newBooks = [];
  const claimedBookIds = new Set();

  for (const entry of candidateRows) {
    const workId = workIdentity(entry);
    const exact = existingByIsbn.get(entry.isbn);

    if (exact) {
      if (!compatibleIdentity(exact, entry)) {
        conflicts.push({
          line: entry.line,
          row: entry.row,
          isbn: entry.isbn,
          title: entry.title,
          author: entry.author,
          reason: 'identity_conflict',
          message: `Existing ISBN ${entry.isbn} belongs to "${exact.title}" by "${exact.author}"`,
          existingBookId: exact.id,
          existingTitle: exact.title,
          existingAuthor: exact.author,
        });
      } else if (claimedBookIds.has(exact.id)) {
        conflicts.push({
          line: entry.line,
          row: entry.row,
          isbn: entry.isbn,
          title: entry.title,
          author: entry.author,
          reason: 'existing_book_reused',
          message: `Existing Book ID ${exact.id} already claimed by another entry`,
          existingBookId: exact.id,
        });
      } else {
        claimedBookIds.add(exact.id);
        matchedExactIsbn++;
      }
      continue;
    }

    const workMatches = existingByWork.get(workId) || [];
    if (workMatches.length > 1) {
      conflicts.push({
        line: entry.line,
        row: entry.row,
        isbn: entry.isbn,
        title: entry.title,
        author: entry.author,
        reason: 'ambiguous_work_match',
        message: `Multiple existing books (${workMatches.length}) match normalized work identity`,
        existingBookIds: workMatches.map(b => b.id),
      });
    } else if (workMatches.length === 1) {
      const book = workMatches[0];
      if (claimedBookIds.has(book.id)) {
        conflicts.push({
          line: entry.line,
          row: entry.row,
          isbn: entry.isbn,
          title: entry.title,
          author: entry.author,
          reason: 'existing_book_reused',
          message: `Existing Book ID ${book.id} already claimed by another entry`,
          existingBookId: book.id,
        });
      } else {
        claimedBookIds.add(book.id);
        matchedExistingWork++;
      }
    } else {
      newBooks.push(entry);
    }
  }

  return {
    matchedExactIsbn,
    matchedExistingWork,
    conflicts,
    newBooks,
  };
}

export async function importCatalogCsv(db, csvContent, options = {}) {
  const apply = Boolean(options.apply);
  const chunkSize = Number(options.chunkSize) || 500;

  const parsed = parseCatalogCsv(csvContent);
  const classified = await classifyCsvCatalog(db, parsed.uniqueValidRows);

  const summary = {
    sourceRows: parsed.sourceRows,
    validRows: parsed.validRows.length,
    invalidRows: parsed.sourceRows - parsed.validRows.length,
    duplicateIsbns: parsed.duplicateIsbns.length,
    duplicateWorks: parsed.duplicateWorks.length,
    matchedExactIsbn: classified.matchedExactIsbn,
    matchedExistingWork: classified.matchedExistingWork,
    conflicts: classified.conflicts.length,
    newBooks: classified.newBooks.length,
    created: 0,
    updated: 0,
  };

  const details = {
    invalidRows: parsed.invalidRows,
    duplicateIsbns: parsed.duplicateIsbns,
    duplicateWorks: parsed.duplicateWorks,
    conflicts: classified.conflicts,
  };

  const hasErrors = summary.invalidRows > 0 ||
                    summary.duplicateIsbns > 0 ||
                    summary.duplicateWorks > 0 ||
                    summary.conflicts > 0;

  if (!apply) {
    return { summary, details };
  }

  if (hasErrors) {
    throw new CsvCatalogError(
      'preflight_failed',
      'CSV catalog preflight failed; refusing to apply',
      { summary, details }
    );
  }

  if (classified.newBooks.length === 0) {
    return { summary, details };
  }

  // Atomically create new books in chunks
  try {
    await db.$transaction(async tx => {
      for (let i = 0; i < classified.newBooks.length; i += chunkSize) {
        const chunk = classified.newBooks.slice(i, i + chunkSize).map(book => ({
          title: book.title,
          author: book.author,
          isbn: book.isbn,
          description: null,
          publicationYear: null,
          coverImageUrl: coverImageUrl(book.isbn),
        }));
        await tx.book.createMany({
          data: chunk,
        });
      }
    });
    summary.created = classified.newBooks.length;
  } catch (err) {
    throw new CsvCatalogError(
      'apply_failed',
      `Failed to apply new books to database: ${err.message}`,
      { originalError: err, summary, details }
    );
  }

  return { summary, details };
}
