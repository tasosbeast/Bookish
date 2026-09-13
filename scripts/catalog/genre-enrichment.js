import fs from 'node:fs';
import path from 'node:path';
import { workIdentity } from './work-identity.js';

export class GenreEnrichmentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GenreEnrichmentError';
    this.details = details;
  }
}

export function parseCSV(content) {
  const lines = content.trim().split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);
    rows.push(fields);
  }
  return rows;
}

export function loadSourceFiles(options = {}) {
  const catalogPath = options.catalogPath || path.resolve('scripts/catalog-books.csv');
  const taxonomyPath = options.taxonomyPath || path.resolve('scripts/genre-taxonomy-proposal.csv');
  const genresPath = options.genresPath || path.resolve('scripts/catalog-book-genres.csv');

  if (!fs.existsSync(catalogPath)) {
    throw new GenreEnrichmentError(`Catalog file not found: ${catalogPath}`);
  }
  if (!fs.existsSync(taxonomyPath)) {
    throw new GenreEnrichmentError(`Taxonomy file not found: ${taxonomyPath}`);
  }
  if (!fs.existsSync(genresPath)) {
    throw new GenreEnrichmentError(`Genres mapping file not found: ${genresPath}`);
  }

  const catalogRows = parseCSV(fs.readFileSync(catalogPath, 'utf8'));
  const taxonomyRows = parseCSV(fs.readFileSync(taxonomyPath, 'utf8'));
  const genreRows = parseCSV(fs.readFileSync(genresPath, 'utf8'));

  // Validate headers
  if (catalogRows[0].join(',') !== 'title,author,isbn') {
    throw new GenreEnrichmentError(`Invalid catalog-books.csv header: ${catalogRows[0].join(',')}`);
  }
  if (!taxonomyRows[0].join(',').startsWith('name,slug,estimatedBookCount')) {
    throw new GenreEnrichmentError(`Invalid genre-taxonomy-proposal.csv header: ${taxonomyRows[0].join(',')}`);
  }
  if (genreRows[0].join(',') !== 'isbn,genres') {
    throw new GenreEnrichmentError(`Invalid catalog-book-genres.csv header: ${genreRows[0].join(',')}`);
  }

  // Parse taxonomy
  const taxonomy = [];
  const taxonomySlugs = new Set();
  const taxonomyNames = new Set();
  const slugRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  for (let i = 1; i < taxonomyRows.length; i++) {
    const row = taxonomyRows[i];
    const name = row[0].trim();
    const slug = row[1].trim();

    if (!name || !slug) {
      throw new GenreEnrichmentError(`Empty name or slug in taxonomy row ${i + 1}`);
    }
    if (!slugRegex.test(slug)) {
      throw new GenreEnrichmentError(`Invalid slug format in taxonomy: "${slug}"`);
    }
    if (taxonomySlugs.has(slug)) {
      throw new GenreEnrichmentError(`Duplicate slug in taxonomy: "${slug}"`);
    }
    if (taxonomyNames.has(name.toLowerCase())) {
      throw new GenreEnrichmentError(`Duplicate name in taxonomy: "${name}"`);
    }

    taxonomySlugs.add(slug);
    taxonomyNames.add(name.toLowerCase());
    taxonomy.push({ name, slug });
  }

  if (taxonomy.length !== 37) {
    throw new GenreEnrichmentError(`Expected exactly 37 taxonomy genres, got ${taxonomy.length}`);
  }

  // Parse catalog
  const catalogBooks = [];
  const catalogIsbns = new Set();
  for (let i = 1; i < catalogRows.length; i++) {
    const row = catalogRows[i];
    const title = row[0].trim();
    const author = row[1].trim();
    const isbn = row[2].trim();

    if (!title || !author || !isbn) {
      throw new GenreEnrichmentError(`Missing required field in catalog row ${i + 1}`);
    }
    if (catalogIsbns.has(isbn)) {
      throw new GenreEnrichmentError(`Duplicate ISBN in catalog: ${isbn}`);
    }
    catalogIsbns.add(isbn);
    catalogBooks.push({ title, author, isbn });
  }

  if (catalogBooks.length !== 1002) {
    throw new GenreEnrichmentError(`Expected exactly 1002 catalog books, got ${catalogBooks.length}`);
  }

  // Parse genres mapping
  const genresByIsbn = new Map();
  for (let i = 1; i < genreRows.length; i++) {
    const row = genreRows[i];
    const isbn = row[0].trim();
    const genresStr = row[1] ? row[1].trim() : '';

    if (!isbn) {
      throw new GenreEnrichmentError(`Missing ISBN in genres mapping row ${i + 1}`);
    }
    if (genresByIsbn.has(isbn)) {
      throw new GenreEnrichmentError(`Duplicate ISBN in genres mapping: ${isbn}`);
    }
    if (!catalogIsbns.has(isbn)) {
      throw new GenreEnrichmentError(`ISBN ${isbn} in genres mapping does not exist in catalog`);
    }

    const slugs = genresStr.split(';').map(s => s.trim()).filter(Boolean);
    if (slugs.length < 1 || slugs.length > 3) {
      throw new GenreEnrichmentError(`Book ${isbn} has ${slugs.length} genres (must be 1-3)`);
    }

    const uniqueSlugs = new Set();
    for (const slug of slugs) {
      if (!taxonomySlugs.has(slug)) {
        throw new GenreEnrichmentError(`Unknown genre slug "${slug}" for ISBN ${isbn}`);
      }
      if (uniqueSlugs.has(slug)) {
        throw new GenreEnrichmentError(`Duplicate genre slug "${slug}" for ISBN ${isbn}`);
      }
      uniqueSlugs.add(slug);
    }

    genresByIsbn.set(isbn, slugs);
  }

  if (genresByIsbn.size !== 1002) {
    throw new GenreEnrichmentError(`Expected 1002 mapped ISBNs, got ${genresByIsbn.size}`);
  }

  for (const book of catalogBooks) {
    if (!genresByIsbn.has(book.isbn)) {
      throw new GenreEnrichmentError(`Catalog ISBN ${book.isbn} is missing from genres mapping`);
    }
  }

  return {
    taxonomy,
    catalogBooks,
    genresByIsbn,
  };
}

export async function analyzeGenreEnrichment(db, options = {}) {
  const { taxonomy, catalogBooks, genresByIsbn } = options.sourceData || loadSourceFiles(options);

  // 1. Fetch existing books from database
  const existingBooks = await db.book.findMany({
    select: {
      id: true,
      isbn: true,
      title: true,
      author: true,
    },
  });

  const existingByIsbn = new Map();
  for (const b of existingBooks) {
    if (b.isbn) {
      existingByIsbn.set(b.isbn, b);
    }
  }

  // Pre-calculate work identities for all existing books
  const existingByWork = new Map();
  for (const b of existingBooks) {
    const key = workIdentity(b);
    if (!existingByWork.has(key)) {
      existingByWork.set(key, []);
    }
    existingByWork.get(key).push(b);
  }

  let matchedExactIsbn = 0;
  let matchedExistingWork = 0;
  const missingBooks = [];
  const ambiguousBooks = [];
  const matchedBooks = []; // { catalogBook, dbBook, matchType }
  const claimedDbBookIds = new Map(); // dbBookId -> [catalogBook]

  for (const cat of catalogBooks) {
    // 1. Exact ISBN match
    const exact = existingByIsbn.get(cat.isbn);
    if (exact) {
      matchedExactIsbn++;
      matchedBooks.push({ catalogBook: cat, dbBook: exact, matchType: 'exact-isbn' });
      if (!claimedDbBookIds.has(exact.id)) claimedDbBookIds.set(exact.id, []);
      claimedDbBookIds.get(exact.id).push(cat);
      continue;
    }

    // 2. Normalized work fallback
    const key = workIdentity(cat);
    const candidates = existingByWork.get(key) || [];

    if (candidates.length === 1) {
      matchedExistingWork++;
      const matched = candidates[0];
      matchedBooks.push({ catalogBook: cat, dbBook: matched, matchType: 'work-identity' });
      if (!claimedDbBookIds.has(matched.id)) claimedDbBookIds.set(matched.id, []);
      claimedDbBookIds.get(matched.id).push(cat);
    } else if (candidates.length > 1) {
      ambiguousBooks.push({
        title: cat.title,
        author: cat.author,
        isbn: cat.isbn,
        candidates: candidates.map(c => ({ id: c.id, isbn: c.isbn, title: c.title, author: c.author })),
      });
    } else {
      missingBooks.push({
        title: cat.title,
        author: cat.author,
        isbn: cat.isbn,
      });
    }
  }

  // Check if multiple catalog books claimed the same DB book ID
  const bookConflicts = [];
  for (const [dbBookId, claimants] of claimedDbBookIds.entries()) {
    if (claimants.length > 1) {
      bookConflicts.push({
        dbBookId,
        claimants: claimants.map(c => ({ title: c.title, author: c.author, isbn: c.isbn })),
      });
    }
  }

  // 2. Fetch existing genres from database
  const existingGenres = await db.genre.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
    },
  });

  const existingGenreBySlug = new Map();
  const existingGenreByNameLower = new Map();
  for (const g of existingGenres) {
    existingGenreBySlug.set(g.slug, g);
    existingGenreByNameLower.set(g.name.toLowerCase(), g);
  }

  let existingCanonicalGenres = 0;
  let newCanonicalGenres = 0;
  const genreConflicts = [];
  const genresToCreate = []; // { name, slug }

  for (const t of taxonomy) {
    const existing = existingGenreBySlug.get(t.slug);
    if (existing) {
      if (existing.name.toLowerCase() !== t.name.toLowerCase()) {
        genreConflicts.push({
          slug: t.slug,
          canonicalName: t.name,
          existingName: existing.name,
          reason: `Slug "${t.slug}" already exists with incompatible name "${existing.name}" (expected "${t.name}")`,
        });
      } else {
        existingCanonicalGenres++;
      }
    } else {
      const existingByName = existingGenreByNameLower.get(t.name.toLowerCase());
      if (existingByName) {
        genreConflicts.push({
          slug: t.slug,
          canonicalName: t.name,
          existingSlug: existingByName.slug,
          reason: `Name "${t.name}" already exists with different slug "${existingByName.slug}" (expected "${t.slug}")`,
        });
      } else {
        newCanonicalGenres++;
        genresToCreate.push(t);
      }
    }
  }

  // 3. BookGenre relations for matched books
  const matchedBookIds = matchedBooks.map(m => m.dbBook.id);
  const existingBookGenres = matchedBookIds.length > 0
    ? await db.bookGenre.findMany({
        where: {
          bookId: { in: matchedBookIds },
        },
        include: {
          genre: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
      })
    : [];

  const currentGenresByBookId = new Map();
  for (const bg of existingBookGenres) {
    if (!currentGenresByBookId.has(bg.bookId)) {
      currentGenresByBookId.set(bg.bookId, new Map());
    }
    currentGenresByBookId.get(bg.bookId).set(bg.genre.slug, bg.genre);
  }

  let booksAlreadyCorrect = 0;
  let booksNeedingChanges = 0;
  let linksToAdd = 0;
  let linksToRemove = 0;

  const plannedAdditions = []; // { bookId, title, isbn, missingSlugs }
  const plannedRemovals = [];  // { bookId, title, isbn, staleSlugs, staleGenreIds }

  for (const m of matchedBooks) {
    const bookId = m.dbBook.id;
    const desiredSlugs = genresByIsbn.get(m.catalogBook.isbn);
    const currentGenreMap = currentGenresByBookId.get(bookId) || new Map();
    const currentSlugs = new Set(currentGenreMap.keys());

    const missingSlugs = desiredSlugs.filter(s => !currentSlugs.has(s));
    const staleSlugs = Array.from(currentSlugs).filter(s => !desiredSlugs.includes(s));

    if (missingSlugs.length === 0 && staleSlugs.length === 0) {
      booksAlreadyCorrect++;
    } else {
      booksNeedingChanges++;
      if (missingSlugs.length > 0) {
        linksToAdd += missingSlugs.length;
        plannedAdditions.push({
          bookId,
          title: m.dbBook.title,
          isbn: m.catalogBook.isbn,
          missingSlugs,
        });
      }
      if (staleSlugs.length > 0) {
        linksToRemove += staleSlugs.length;
        plannedRemovals.push({
          bookId,
          title: m.dbBook.title,
          isbn: m.catalogBook.isbn,
          staleSlugs,
          staleGenreIds: staleSlugs.map(s => currentGenreMap.get(s).id),
        });
      }
    }
  }

  const preflightSafe =
    missingBooks.length === 0 &&
    ambiguousBooks.length === 0 &&
    bookConflicts.length === 0 &&
    genreConflicts.length === 0;

  const summary = {
    sourceBooks: catalogBooks.length,
    taxonomyGenres: taxonomy.length,
    matchedExactIsbn,
    matchedExistingWork,
    missingBooks: missingBooks.length,
    ambiguousBooks: ambiguousBooks.length,
    bookConflicts: bookConflicts.length,
    genreConflicts: genreConflicts.length,
    existingCanonicalGenres,
    newCanonicalGenres,
    booksAlreadyCorrect,
    booksNeedingChanges,
    linksToAdd,
    linksToRemove,
    createdGenres: 0,
    addedLinks: 0,
    removedLinks: 0,
    bookRowsUpdated: 0,
  };

  const details = {
    preflightSafe,
    missingBooks,
    ambiguousBooks,
    bookConflicts,
    genreConflicts,
    genresToCreate,
    matchedBooks,
    plannedAdditions,
    plannedRemovals,
    genresByIsbn,
    taxonomy,
  };

  return { summary, details };
}

export async function enrichCatalogGenres(db, options = {}) {
  const apply = Boolean(options.apply);
  const analysis = await analyzeGenreEnrichment(db, options);
  const { summary, details } = analysis;

  if (!details.preflightSafe) {
    if (apply) {
      const issues = [];
      if (details.missingBooks.length > 0) issues.push(`${details.missingBooks.length} missing books`);
      if (details.ambiguousBooks.length > 0) issues.push(`${details.ambiguousBooks.length} ambiguous book matches`);
      if (details.bookConflicts.length > 0) issues.push(`${details.bookConflicts.length} duplicate book claims`);
      if (details.genreConflicts.length > 0) issues.push(`${details.genreConflicts.length} genre name/slug conflicts`);
      throw new GenreEnrichmentError(`Cannot apply: preflight blockers detected (${issues.join(', ')})`, {
        summary,
        details,
      });
    }
    return { summary, details };
  }

  if (!apply) {
    return { summary, details };
  }

  // Run apply within transaction
  await db.$transaction(async tx => {
    // 1. Create missing canonical genre rows
    if (details.genresToCreate.length > 0) {
      await tx.genre.createMany({
        data: details.genresToCreate.map(g => ({
          name: g.name,
          slug: g.slug,
        })),
        skipDuplicates: true,
      });
    }

    // 2. Resolve all canonical genre IDs
    const allCanonicalSlugs = details.taxonomy.map(t => t.slug);
    const allDbGenres = await tx.genre.findMany({
      where: {
        slug: { in: allCanonicalSlugs },
      },
      select: {
        id: true,
        slug: true,
      },
    });

    const genreIdBySlug = new Map(allDbGenres.map(g => [g.slug, g.id]));
    for (const slug of allCanonicalSlugs) {
      if (!genreIdBySlug.has(slug)) {
        throw new GenreEnrichmentError(`Failed to resolve genre ID for slug "${slug}"`);
      }
    }

    // 3. Add missing BookGenre relationships
    const linksToCreate = [];
    for (const addition of details.plannedAdditions) {
      for (const slug of addition.missingSlugs) {
        linksToCreate.push({
          bookId: addition.bookId,
          genreId: genreIdBySlug.get(slug),
        });
      }
    }

    if (linksToCreate.length > 0) {
      await tx.bookGenre.createMany({
        data: linksToCreate,
        skipDuplicates: true,
      });
    }

    // 4. Remove stale BookGenre relationships ONLY from matched curated books
    const stalePairs = [];
    for (const removal of details.plannedRemovals) {
      for (const genreId of removal.staleGenreIds) {
        stalePairs.push({
          bookId: removal.bookId,
          genreId,
        });
      }
    }

    if (stalePairs.length > 0) {
      // Delete in bounded chunks to avoid overly large SQL queries
      const chunkSize = 500;
      for (let i = 0; i < stalePairs.length; i += chunkSize) {
        const chunk = stalePairs.slice(i, i + chunkSize);
        await tx.bookGenre.deleteMany({
          where: {
            OR: chunk,
          },
        });
      }
    }

    // 5. Post-apply verification: every matched curated Book has exactly its desired canonical genre set
    const matchedBookIds = details.matchedBooks.map(m => m.dbBook.id);
    const postBookGenres = await tx.bookGenre.findMany({
      where: {
        bookId: { in: matchedBookIds },
      },
      select: {
        bookId: true,
        genre: {
          select: {
            slug: true,
          },
        },
      },
    });

    const postGenresByBookId = new Map();
    for (const bg of postBookGenres) {
      if (!postGenresByBookId.has(bg.bookId)) {
        postGenresByBookId.set(bg.bookId, new Set());
      }
      postGenresByBookId.get(bg.bookId).add(bg.genre.slug);
    }

    for (const m of details.matchedBooks) {
      const bookId = m.dbBook.id;
      const desiredSlugs = details.genresByIsbn.get(m.catalogBook.isbn);
      const actualSlugs = postGenresByBookId.get(bookId) || new Set();

      if (actualSlugs.size !== desiredSlugs.length) {
        throw new GenreEnrichmentError(
          `Post-apply verification failed for book ${bookId} ("${m.dbBook.title}"): expected ${desiredSlugs.length} genres, found ${actualSlugs.size}`
        );
      }
      for (const slug of desiredSlugs) {
        if (!actualSlugs.has(slug)) {
          throw new GenreEnrichmentError(
            `Post-apply verification failed for book ${bookId} ("${m.dbBook.title}"): missing genre "${slug}"`
          );
        }
      }
    }
  }, { timeout: 60000 });

  summary.createdGenres = details.genresToCreate.length;
  summary.addedLinks = summary.linksToAdd;
  summary.removedLinks = summary.linksToRemove;

  return { summary, details };
}
