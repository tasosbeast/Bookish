import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { normalizeIsbn13 } from './normalize.js';
import { workIdentity, compatibleIdentity } from './work-identity.js';
import { serializePublicationDate } from '../../src/services/books.js';

export class ReleaseCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseCatalogError';
    this.code = code;
    this.details = details;
  }
}

export const EXPECTED_HEADERS = [
  'title',
  'author',
  'isbn',
  'publicationDate',
  'coverImageUrl',
  'genres',
  'sourceUrl',
];

export const RELEASE_PROVIDERS = Object.freeze({
  'www.penguinrandomhouse.com': 'prh',
  'us.macmillan.com': 'macmillan',
  'www.hachettebookgroup.com': 'hachette',
});

export function deriveReleaseProvider(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ReleaseCatalogError('invalid_source_url', 'sourceUrl must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:') {
    throw new ReleaseCatalogError('invalid_source_url', 'sourceUrl must use HTTPS');
  }
  const provider = RELEASE_PROVIDERS[url.hostname.toLowerCase()];
  if (!provider) {
    throw new ReleaseCatalogError('unsupported_source_provider', `Unsupported release source hostname: ${url.hostname}`);
  }
  return provider;
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

export function parseReleaseCatalogCsv(csvContent) {
  if (typeof csvContent !== 'string' && !Buffer.isBuffer(csvContent)) {
    throw new ReleaseCatalogError('invalid_input', 'CSV content must be a string or Buffer');
  }

  const text = Buffer.isBuffer(csvContent) ? csvContent.toString('utf8') : csvContent;
  if (!text.trim()) {
    throw new ReleaseCatalogError('empty_file', 'CSV content is empty');
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
        if (!Array.isArray(header) || header.length !== EXPECTED_HEADERS.length) {
          throw new ReleaseCatalogError(
            'invalid_header',
            `CSV header must have exactly ${EXPECTED_HEADERS.length} columns: ${EXPECTED_HEADERS.join(',')} (found ${header?.length ?? 0} columns)`
          );
        }
        const trimmed = header.map(h => typeof h === 'string' ? h.trim() : '');
        const matches = EXPECTED_HEADERS.every((exp, idx) => trimmed[idx] === exp);
        if (!matches) {
          throw new ReleaseCatalogError(
            'invalid_header',
            `CSV header columns must be ${EXPECTED_HEADERS.join(',')} (found: ${header.join(',')})`
          );
        }
        return EXPECTED_HEADERS;
      },
    });
  } catch (err) {
    if (err instanceof ReleaseCatalogError) {
      throw err;
    }
    throw new ReleaseCatalogError('parse_error', `Failed to parse CSV: ${err.message}`, { originalError: err });
  }

  if (!headerSeen) {
    throw new ReleaseCatalogError('invalid_header', 'CSV missing header');
  }

  return rawRecords;
}

export function validateReleaseCatalogRecords(rawRecords) {
  const invalidRows = [];
  const validRows = [];

  for (let i = 0; i < rawRecords.length; i++) {
    const rawItem = rawRecords[i];
    const record = rawItem && typeof rawItem === 'object' && 'record' in rawItem ? rawItem.record : rawItem;
    const info = rawItem?.info;
    const line = info?.lines ?? (i + 2);
    const row = i + 1;

    let isRecordValid = true;

    // 1. title
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!title) {
      invalidRows.push({ line, row, field: 'title', message: 'title is required and cannot be blank' });
      isRecordValid = false;
    }

    // 2. author
    const author = typeof record.author === 'string' ? record.author.trim() : '';
    if (!author) {
      invalidRows.push({ line, row, field: 'author', message: 'author is required and cannot be blank' });
      isRecordValid = false;
    }

    // 3. isbn
    const rawIsbn = typeof record.isbn === 'string' ? record.isbn.trim() : '';
    let normalizedIsbn = null;
    if (!rawIsbn) {
      invalidRows.push({ line, row, field: 'isbn', message: 'isbn is required and cannot be blank' });
      isRecordValid = false;
    } else {
      try {
        normalizedIsbn = normalizeIsbn13(rawIsbn);
      } catch (err) {
        invalidRows.push({ line, row, field: 'isbn', value: rawIsbn, message: `Invalid ISBN-13: ${err.message}` });
        isRecordValid = false;
      }
    }

    // 4. publicationDate
    const rawDate = typeof record.publicationDate === 'string' ? record.publicationDate.trim() : '';
    if (!rawDate) {
      invalidRows.push({ line, row, field: 'publicationDate', message: 'publicationDate is required and cannot be blank' });
      isRecordValid = false;
    } else if (!isValidCalendarDate(rawDate)) {
      invalidRows.push({ line, row, field: 'publicationDate', value: rawDate, message: `Invalid publicationDate: "${rawDate}". Must be a valid calendar date in YYYY-MM-DD format.` });
      isRecordValid = false;
    } else if (rawDate < '2025-01-01') {
      invalidRows.push({ line, row, field: 'publicationDate', value: rawDate, message: `publicationDate "${rawDate}" is before minimum release date 2025-01-01` });
      isRecordValid = false;
    } else if (rawDate > '2027-12-31') {
      invalidRows.push({ line, row, field: 'publicationDate', value: rawDate, message: `publicationDate "${rawDate}" is after maximum release date 2027-12-31` });
      isRecordValid = false;
    }

    // 5. coverImageUrl
    const rawCover = typeof record.coverImageUrl === 'string' ? record.coverImageUrl.trim() : '';
    if (!rawCover) {
      invalidRows.push({ line, row, field: 'coverImageUrl', message: 'coverImageUrl is required and cannot be blank' });
      isRecordValid = false;
    } else if (!isValidHttpsUrl(rawCover)) {
      invalidRows.push({ line, row, field: 'coverImageUrl', value: rawCover, message: `Invalid coverImageUrl: "${rawCover}". Must be a valid HTTPS URL.` });
      isRecordValid = false;
    }

    // 6. genres
    let genreSlugs = [];
    if (Array.isArray(record.genres)) {
      genreSlugs = record.genres.map(g => typeof g === 'string' ? g.trim() : '').filter(Boolean);
    } else if (typeof record.genres === 'string' && record.genres.trim()) {
      genreSlugs = record.genres.split(';').map(g => g.trim()).filter(Boolean);
    }
    if (genreSlugs.length === 0) {
      invalidRows.push({ line, row, field: 'genres', message: 'genres is required and cannot be blank (at least 1 genre required)' });
      isRecordValid = false;
    } else if (genreSlugs.length > 3) {
      invalidRows.push({ line, row, field: 'genres', value: record.genres, message: `Too many genres (${genreSlugs.length}); maximum 3 allowed` });
      isRecordValid = false;
    } else {
      const unique = new Set(genreSlugs);
      if (unique.size !== genreSlugs.length) {
        invalidRows.push({ line, row, field: 'genres', value: record.genres, message: `Duplicate genre slugs in row: ${Array.isArray(record.genres) ? record.genres.join(';') : record.genres}` });
        isRecordValid = false;
      }
    }

    // 7. sourceUrl
    const rawSourceUrl = typeof record.sourceUrl === 'string' ? record.sourceUrl.trim() : '';
    if (!rawSourceUrl) {
      invalidRows.push({ line, row, field: 'sourceUrl', message: 'sourceUrl is required and cannot be blank' });
      isRecordValid = false;
    } else if (!isValidHttpsUrl(rawSourceUrl)) {
      invalidRows.push({ line, row, field: 'sourceUrl', value: rawSourceUrl, message: `Invalid sourceUrl: "${rawSourceUrl}". Must be a valid HTTPS URL.` });
      isRecordValid = false;
    }

    let provider = null;
    if (isRecordValid) {
      try {
        provider = deriveReleaseProvider(rawSourceUrl);
      } catch (error) {
        invalidRows.push({ line, row, field: 'sourceUrl', value: rawSourceUrl, message: error.message });
        isRecordValid = false;
      }
    }

    if (isRecordValid) {
      validRows.push({
        line,
        row,
        title,
        author,
        isbn: normalizedIsbn,
        publicationDate: rawDate,
        derivedYear: parseInt(rawDate.slice(0, 4), 10),
        coverImageUrl: rawCover,
        genres: genreSlugs,
        sourceUrl: rawSourceUrl,
        provider,
      });
    }
  }

  return { invalidRows, validRows };
}

function releaseMetadataMatches(book, entry) {
  const derivedYear = entry.derivedYear;
  const existingDateStr = serializePublicationDate(book.publicationDate);
  const existingGenreSlugs = new Set(
    (book.bookGenres || []).map(bg => bg.genre?.slug || bg.genreSlug).filter(Boolean)
  );
  const requestedGenreSlugs = new Set(entry.genres);
  const genresMatch = existingGenreSlugs.size === requestedGenreSlugs.size &&
    [...requestedGenreSlugs].every(slug => existingGenreSlugs.has(slug));
  return {
    matches: compatibleIdentity(book, entry) &&
      book.publicationYear === derivedYear &&
      existingDateStr === entry.publicationDate &&
      book.coverImageUrl === entry.coverImageUrl && genresMatch,
    existingDateStr,
    existingGenreSlugs,
    requestedGenreSlugs,
  };
}

function matchingProvenance(source, entry) {
  return source && source.provider === entry.provider &&
    source.sourceUrl === entry.sourceUrl && source.sourceIsbn === entry.isbn &&
    serializePublicationDate(source.verifiedPublicationDate) === entry.publicationDate;
}

export async function importReleaseCatalog(db, options = {}) {
  const {
    source = path.resolve('scripts/release-catalog.csv'),
    apply = false,
  } = options;

  let rawRecordsLength = 0;
  let invalidRows, validRows;

  if (options.records || options.entries) {
    const rawInput = options.records || options.entries;
    rawRecordsLength = rawInput.length;
    const validated = validateReleaseCatalogRecords(rawInput);
    invalidRows = validated.invalidRows;
    validRows = validated.validRows;
  } else {
    let csvContent = options.csvContent;
    if (csvContent === undefined) {
      if (!fs.existsSync(source)) {
        throw new ReleaseCatalogError('source_missing', `Source file not found: ${source}`);
      }
      csvContent = fs.readFileSync(source, 'utf8');
    }
    const rawRecords = parseReleaseCatalogCsv(csvContent);
    rawRecordsLength = rawRecords.length;
    const validated = validateReleaseCatalogRecords(rawRecords);
    invalidRows = validated.invalidRows;
    validRows = validated.validRows;
  }

  const seenIsbns = new Map();
  const seenWorks = new Map();
  const duplicateIsbns = [];
  const duplicateWorks = [];
  const duplicateIndices = new Set();

  for (let i = 0; i < validRows.length; i++) {
    const item = validRows[i];
    const workId = workIdentity(item);

    const prevIsbn = seenIsbns.get(item.isbn);
    if (prevIsbn) {
      duplicateIsbns.push({
        line: item.line,
        row: item.row,
        isbn: item.isbn,
        title: item.title,
        author: item.author,
        firstSeenLine: prevIsbn.line,
        firstSeenRow: prevIsbn.row,
      });
      duplicateIndices.add(i);
    } else {
      seenIsbns.set(item.isbn, item);
    }

    const prevWork = seenWorks.get(workId);
    if (prevWork) {
      duplicateWorks.push({
        line: item.line,
        row: item.row,
        workIdentity: workId,
        title: item.title,
        author: item.author,
        isbn: item.isbn,
        firstSeenLine: prevWork.line,
        firstSeenRow: prevWork.row,
        firstSeenIsbn: prevWork.isbn,
      });
      duplicateIndices.add(i);
    } else {
      seenWorks.set(workId, item);
    }
  }

  const candidateRows = validRows.filter((_, idx) => !duplicateIndices.has(idx));

  const existingBooks = await db.book.findMany({
    select: {
      id: true,
      isbn: true,
      title: true,
      author: true,
      publicationYear: true,
      publicationDate: true,
      coverImageUrl: true,
      bookGenres: {
        select: {
          genre: { select: { slug: true } },
        },
      },
      releaseMetadataSource: {
        select: { id: true, provider: true, sourceUrl: true, sourceIsbn: true, verifiedPublicationDate: true },
      },
    },
  });

  const existingGenres = await db.genre.findMany({
    select: { id: true, slug: true, name: true },
  });
  const knownGenreSlugs = new Set(existingGenres.map(g => g.slug));
  const existingSources = await db.releaseMetadataSource.findMany({
    select: { id: true, bookId: true, provider: true, sourceIsbn: true },
  });
  const sourceByProviderIsbn = new Map(existingSources.map(source => [
    `${source.provider}:${source.sourceIsbn}`, source,
  ]));

  const existingByIsbn = new Map();
  const existingByWork = new Map();

  for (const book of existingBooks) {
    if (book.isbn) {
      existingByIsbn.set(book.isbn, book);
    }
    const id = workIdentity(book);
    if (!existingByWork.has(id)) {
      existingByWork.set(id, []);
    }
    existingByWork.get(id).push(book);
  }

  const details = {
    invalidRows,
    duplicateIsbns,
    duplicateWorks,
    newBooks: [],
    alreadyPresent: [],
    missingProvenance: [],
    provenanceConflicts: [],
    exactIsbnConflicts: [],
    existingWorkCollisions: [],
    missingGenres: [],
  };

  for (const entry of candidateRows) {
    // Check missing genres
    const unknownSlugs = entry.genres.filter(slug => !knownGenreSlugs.has(slug));
    if (unknownSlugs.length > 0) {
      details.missingGenres.push({
        line: entry.line,
        row: entry.row,
        isbn: entry.isbn,
        title: entry.title,
        missingGenreSlugs: unknownSlugs,
        reason: `Unknown genre slug(s): ${unknownSlugs.join(', ')}`,
      });
      continue;
    }

    const exact = existingByIsbn.get(entry.isbn);
    const sourceCollision = sourceByProviderIsbn.get(`${entry.provider}:${entry.isbn}`);
    if (sourceCollision && (!exact || sourceCollision.bookId !== exact.id)) {
      details.provenanceConflicts.push({
        line: entry.line, row: entry.row, isbn: entry.isbn,
        reason: 'provider_source_isbn_collision',
        message: `Provider ${entry.provider} already uses ISBN ${entry.isbn} for another book`,
      });
      continue;
    }
    if (exact) {
      const comparison = releaseMetadataMatches(exact, entry);
      if (comparison.matches) {
        if (matchingProvenance(exact.releaseMetadataSource, entry)) {
        details.alreadyPresent.push({
          line: entry.line,
          row: entry.row,
          isbn: entry.isbn,
          title: entry.title,
          author: entry.author,
          bookId: exact.id,
        });
        } else if (!exact.releaseMetadataSource) {
          details.missingProvenance.push({
            line: entry.line, row: entry.row, isbn: entry.isbn,
            title: entry.title, author: entry.author, bookId: exact.id,
            provider: entry.provider, sourceUrl: entry.sourceUrl,
            publicationDate: entry.publicationDate, derivedYear: entry.derivedYear,
            coverImageUrl: entry.coverImageUrl, genres: entry.genres,
          });
        } else {
          details.provenanceConflicts.push({
            line: entry.line, row: entry.row, isbn: entry.isbn,
            reason: 'existing_provenance_conflict',
            message: `Book ${entry.isbn} already has different release provenance`,
          });
        }
      } else {
        const differences = [];
        if (!compatibleIdentity(exact, entry)) differences.push(`title/author incompatible (existing "${exact.title}" by "${exact.author}" vs requested "${entry.title}" by "${entry.author}")`);
        if (exact.publicationYear !== entry.derivedYear) differences.push(`publicationYear mismatch (existing ${exact.publicationYear} vs requested ${entry.derivedYear})`);
        if (comparison.existingDateStr !== entry.publicationDate) differences.push(`publicationDate mismatch (existing ${comparison.existingDateStr} vs requested ${entry.publicationDate})`);
        if (exact.coverImageUrl !== entry.coverImageUrl) differences.push(`coverImageUrl mismatch (existing "${exact.coverImageUrl}" vs requested "${entry.coverImageUrl}")`);
        if (comparison.existingGenreSlugs.size !== comparison.requestedGenreSlugs.size || ![...comparison.requestedGenreSlugs].every(s => comparison.existingGenreSlugs.has(s))) differences.push(`genres mismatch (existing [${[...comparison.existingGenreSlugs].sort().join(', ')}] vs requested [${[...comparison.requestedGenreSlugs].sort().join(', ')}])`);

        details.exactIsbnConflicts.push({
          line: entry.line,
          row: entry.row,
          isbn: entry.isbn,
          title: entry.title,
          author: entry.author,
          reason: 'exact_isbn_metadata_mismatch',
          message: `Existing ISBN ${entry.isbn} differs in metadata: ${differences.join('; ')}`,
          existing: {
            title: exact.title,
            author: exact.author,
            publicationYear: exact.publicationYear,
            publicationDate: comparison.existingDateStr,
            coverImageUrl: exact.coverImageUrl,
            genres: [...comparison.existingGenreSlugs].sort(),
          },
          requested: {
            title: entry.title,
            author: entry.author,
            publicationYear: entry.derivedYear,
            publicationDate: entry.publicationDate,
            coverImageUrl: entry.coverImageUrl,
            genres: [...comparison.requestedGenreSlugs].sort(),
          },
        });
      }
      continue;
    }

    // Check existing work collision
    const workId = workIdentity(entry);
    const collisions = existingByWork.get(workId);
    if (collisions && collisions.length > 0) {
      details.existingWorkCollisions.push({
        line: entry.line,
        row: entry.row,
        isbn: entry.isbn,
        title: entry.title,
        author: entry.author,
        existingBookId: collisions[0].id,
        existingIsbn: collisions[0].isbn,
        existingTitle: collisions[0].title,
        existingAuthor: collisions[0].author,
        reason: 'existing_work_collision',
        message: `Work "${entry.title}" by "${entry.author}" already exists in catalog under ISBN ${collisions[0].isbn || '(no isbn)'}`,
      });
      continue;
    }

    details.newBooks.push(entry);
  }

  const preflightSafe = (
    details.invalidRows.length === 0 &&
    details.duplicateIsbns.length === 0 &&
    details.duplicateWorks.length === 0 &&
    details.exactIsbnConflicts.length === 0 &&
    details.existingWorkCollisions.length === 0 &&
    details.missingGenres.length === 0 &&
    details.provenanceConflicts.length === 0
  );

  const summary = {
    sourceRows: rawRecordsLength,
    validRows: validRows.length,
    invalidRows: details.invalidRows.length,
    duplicateIsbns: details.duplicateIsbns.length,
    duplicateWorks: details.duplicateWorks.length,
    newBooks: details.newBooks.length,
    alreadyPresent: details.alreadyPresent.length,
    missingProvenance: details.missingProvenance.length,
    provenanceConflicts: details.provenanceConflicts.length,
    provenanceAttached: 0,
    exactIsbnConflicts: details.exactIsbnConflicts.length,
    existingWorkCollisions: details.existingWorkCollisions.length,
    missingGenres: details.missingGenres.length,
    created: 0,
    preflightSafe,
  };

  if (apply) {
    if (!preflightSafe) {
      const issues = [];
      if (details.invalidRows.length > 0) issues.push(`${details.invalidRows.length} invalid row(s)`);
      if (details.duplicateIsbns.length > 0) issues.push(`${details.duplicateIsbns.length} duplicate ISBN(s)`);
      if (details.duplicateWorks.length > 0) issues.push(`${details.duplicateWorks.length} duplicate work(s)`);
      if (details.exactIsbnConflicts.length > 0) issues.push(`${details.exactIsbnConflicts.length} exact ISBN conflict(s)`);
      if (details.existingWorkCollisions.length > 0) issues.push(`${details.existingWorkCollisions.length} existing work collision(s)`);
      if (details.missingGenres.length > 0) issues.push(`${details.missingGenres.length} missing genre(s)`);
      if (details.provenanceConflicts.length > 0) issues.push(`${details.provenanceConflicts.length} provenance conflict(s)`);
      throw new ReleaseCatalogError(
        'preflight_blocked',
        `Cannot apply: preflight blockers detected (${issues.join(', ')})`,
        { summary, details }
      );
    }

    if (details.newBooks.length > 0 || details.missingProvenance.length > 0) {
      await db.$transaction(async tx => {
        // 1. Re-check exact ISBN does not now exist
        const plannedIsbns = details.newBooks.map(b => b.isbn);
        const existingIsbnBooks = plannedIsbns.length === 0 ? [] : await tx.book.findMany({
          where: { isbn: { in: plannedIsbns } }, select: { id: true, isbn: true },
        });
        if (existingIsbnBooks.length > 0) {
          throw new ReleaseCatalogError(
            'stale_preflight',
            `Stale preflight: ISBN "${existingIsbnBooks[0].isbn}" already exists in database`,
            { isbn: existingIsbnBooks[0].isbn }
          );
        }

        // 2. Re-check normalized work collision does not now exist
        const allBooks = await tx.book.findMany({
          select: { id: true, isbn: true, title: true, author: true },
        });
        for (const item of details.newBooks) {
          const collision = allBooks.find(b => workIdentity(b) === workIdentity(item));
          if (collision) {
            throw new ReleaseCatalogError(
              'stale_preflight',
              `Stale preflight: work collision with "${collision.title}" by "${collision.author}" (ISBN: ${collision.isbn || 'none'})`,
              { isbn: item.isbn, collidingBookId: collision.id }
            );
          }
        }

        // 3. Re-check requested genres still exist
        const neededSlugs = [...new Set(details.newBooks.flatMap(b => b.genres))];
        const currentGenres = neededSlugs.length === 0 ? [] : await tx.genre.findMany({
          where: { slug: { in: neededSlugs } }, select: { id: true, slug: true },
        });
        const currentGenreMap = new Map(currentGenres.map(g => [g.slug, g.id]));
        for (const slug of neededSlugs) {
          if (!currentGenreMap.has(slug)) {
            throw new ReleaseCatalogError(
              'stale_preflight',
              `Stale preflight: genre slug "${slug}" no longer exists in database`,
              { slug }
            );
          }
        }

        // 4. Re-check provenance uniqueness before any writes.
        const plannedSources = [...details.newBooks, ...details.missingProvenance];
        for (const item of plannedSources) {
          const existingSource = await tx.releaseMetadataSource.findUnique({
            where: { provider_sourceIsbn: { provider: item.provider, sourceIsbn: item.isbn } },
            select: { id: true, bookId: true },
          });
          if (existingSource) {
            throw new ReleaseCatalogError('stale_preflight', `Stale preflight: release provenance already exists for ${item.provider}:${item.isbn}`);
          }
        }

        // 5. Create each new book, genres and provenance in the same transaction.
        for (const item of details.newBooks) {
          const dateObj = new Date(`${item.publicationDate}T00:00:00.000Z`);
          const derivedYear = parseInt(item.publicationDate.slice(0, 4), 10);
          try {
            const book = await tx.book.create({
              data: {
                title: item.title,
                author: item.author,
                isbn: item.isbn,
                publicationDate: dateObj,
                publicationYear: derivedYear,
                coverImageUrl: item.coverImageUrl,
                description: null,
                bookGenres: {
                  create: item.genres.map(slug => ({
                    genreId: currentGenreMap.get(slug),
                  })),
                },
              },
            });
            await tx.releaseMetadataSource.create({
              data: {
                bookId: book.id, provider: item.provider, sourceUrl: item.sourceUrl,
                sourceIsbn: item.isbn, verifiedPublicationDate: dateObj, lastVerifiedAt: new Date(),
              },
            });
          } catch (err) {
            if (err?.code === 'P2002') {
              throw new ReleaseCatalogError(
                'stale_preflight',
                `Database unique constraint error during apply for book ${item.isbn}: ${err.message}`,
                { originalError: err, isbn: item.isbn }
              );
            }
            throw err;
          }
        }

        // 6. Attach only missing provenance after re-checking all matching metadata.
        for (const item of details.missingProvenance) {
          const current = await tx.book.findUnique({
            where: { id: item.bookId },
            select: {
              id: true, isbn: true, title: true, author: true, publicationYear: true, publicationDate: true, coverImageUrl: true,
              bookGenres: { select: { genre: { select: { slug: true } } } },
              releaseMetadataSource: { select: { id: true } },
            },
          });
          if (!current || current.isbn !== item.isbn || current.releaseMetadataSource || !releaseMetadataMatches(current, item).matches) {
            throw new ReleaseCatalogError('stale_preflight', `Stale preflight: book ${item.isbn} can no longer receive release provenance`);
          }
          const dateObj = new Date(`${item.publicationDate}T00:00:00.000Z`);
          try {
            await tx.releaseMetadataSource.create({
              data: { bookId: current.id, provider: item.provider, sourceUrl: item.sourceUrl, sourceIsbn: item.isbn,
                verifiedPublicationDate: dateObj, lastVerifiedAt: new Date() },
            });
          } catch (error) {
            if (error?.code === 'P2002') {
              throw new ReleaseCatalogError('stale_preflight', `Stale preflight: release provenance changed for ${item.isbn}`, { isbn: item.isbn });
            }
            throw error;
          }
        }
      });

      summary.created = details.newBooks.length;
      summary.provenanceAttached = details.missingProvenance.length;
    }
  }

  return { summary, details };
}
