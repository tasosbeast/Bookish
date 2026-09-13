import fs from 'node:fs';
import path from 'node:path';

function parseCSV(content) {
  const lines = content.trim().split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
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

export function validateCatalogGenres() {
  const catalogPath = path.resolve('scripts/catalog-books.csv');
  const proposalPath = path.resolve('scripts/genre-taxonomy-proposal.csv');
  const genresPath = path.resolve('scripts/catalog-book-genres.csv');
  const auditPath = path.resolve('scripts/catalog-book-genres-audit.json');

  const catalogRows = parseCSV(fs.readFileSync(catalogPath, 'utf8'));
  const proposalRows = parseCSV(fs.readFileSync(proposalPath, 'utf8'));
  const genresRows = parseCSV(fs.readFileSync(genresPath, 'utf8'));
  const auditData = JSON.parse(fs.readFileSync(auditPath, 'utf8'));

  if (catalogRows[0].join(',') !== 'title,author,isbn') {
    throw new Error('Invalid catalog-books.csv header');
  }
  if (catalogRows.length - 1 !== 1002) {
    throw new Error(`Expected 1002 catalog books, got ${catalogRows.length - 1}`);
  }

  if (genresRows[0].join(',') !== 'isbn,genres') {
    throw new Error('Invalid catalog-book-genres.csv header');
  }
  if (genresRows.length - 1 !== 1002) {
    throw new Error(`Expected 1002 genre mapping rows, got ${genresRows.length - 1}`);
  }

  const catalogIsbns = catalogRows.slice(1).map(r => r[2]);
  const catalogSet = new Set(catalogIsbns);
  if (catalogSet.size !== 1002) {
    throw new Error('Duplicate ISBNs found in catalog-books.csv');
  }

  const validSlugs = new Set(proposalRows.slice(1).map(r => r[1]));
  const seenIsbns = new Set();

  for (let i = 1; i < genresRows.length; i++) {
    const [isbn, genresStr] = genresRows[i];
    if (seenIsbns.has(isbn)) {
      throw new Error(`Duplicate ISBN row: ${isbn}`);
    }
    seenIsbns.add(isbn);

    if (!catalogSet.has(isbn)) {
      throw new Error(`Unknown ISBN in genres mapping: ${isbn}`);
    }

    if (!genresStr || !genresStr.trim()) {
      throw new Error(`Empty genres for ISBN: ${isbn}`);
    }

    const slugs = genresStr.split(';');
    if (slugs.length < 1 || slugs.length > 3) {
      throw new Error(`Expected 1-3 genres for ISBN ${isbn}, got ${slugs.length}`);
    }

    const uniqueSlugs = new Set(slugs);
    if (uniqueSlugs.size !== slugs.length) {
      throw new Error(`Duplicate genre slugs for ISBN ${isbn}: ${genresStr}`);
    }

    for (const slug of slugs) {
      if (!validSlugs.has(slug)) {
        throw new Error(`Invalid genre slug "${slug}" for ISBN ${isbn}`);
      }
    }
  }

  for (const isbn of catalogSet) {
    if (!seenIsbns.has(isbn)) {
      throw new Error(`Missing ISBN from genres mapping: ${isbn}`);
    }
  }

  if (auditData.sourceBooks !== 1002 || auditData.mappedBooks !== 1002 || auditData.unmappedBooks !== 0) {
    throw new Error('Audit accounting mismatch');
  }
  if (auditData.booksWithMoreThan3Genres !== 0) {
    throw new Error('Books with more than 3 genres must be 0');
  }

  return {
    valid: true,
    totalBooks: 1002,
    totalMapped: seenIsbns.size,
    validSlugsCount: validSlugs.size,
  };
}

if (process.argv[1] && import.meta.url === `file:///${path.resolve(process.argv[1]).replace(/\\/g, '/')}`) {
  const res = validateCatalogGenres();
  console.log('Validation successful:', res);
}
