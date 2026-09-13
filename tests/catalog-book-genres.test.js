import test from 'node:test';
import assert from 'node:assert/strict';
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

test('catalog book genres validation', async t => {
  const catalogPath = path.resolve('scripts/catalog-books.csv');
  const proposalPath = path.resolve('scripts/genre-taxonomy-proposal.csv');
  const genresPath = path.resolve('scripts/catalog-book-genres.csv');
  const auditPath = path.resolve('scripts/catalog-book-genres-audit.json');

  const catalogRows = parseCSV(fs.readFileSync(catalogPath, 'utf8'));
  const proposalRows = parseCSV(fs.readFileSync(proposalPath, 'utf8'));
  const genresRows = parseCSV(fs.readFileSync(genresPath, 'utf8'));
  const auditData = JSON.parse(fs.readFileSync(auditPath, 'utf8'));

  await t.test('1. catalog-books.csv has exactly 1002 books plus header', () => {
    assert.equal(catalogRows[0].join(','), 'title,author,isbn');
    assert.equal(catalogRows.length - 1, 1002);
  });

  await t.test('2. catalog-book-genres.csv has exactly 1002 rows plus header', () => {
    assert.equal(genresRows[0].join(','), 'isbn,genres');
    assert.equal(genresRows.length - 1, 1002);
  });

  const catalogIsbns = catalogRows.slice(1).map(r => r[2]);
  const genreEntries = genresRows.slice(1).map(r => ({ isbn: r[0], genresStr: r[1] }));

  await t.test('3. every catalog ISBN appears exactly once in genres mapping', () => {
    const catalogSet = new Set(catalogIsbns);
    assert.equal(catalogSet.size, 1002);

    const genreIsbnCounts = new Map();
    for (const entry of genreEntries) {
      genreIsbnCounts.set(entry.isbn, (genreIsbnCounts.get(entry.isbn) || 0) + 1);
    }

    assert.equal(genreIsbnCounts.size, 1002);
    for (const [isbn, count] of genreIsbnCounts.entries()) {
      assert.equal(count, 1, `ISBN ${isbn} appears ${count} times in catalog-book-genres.csv`);
      assert.ok(catalogSet.has(isbn), `Unknown ISBN ${isbn} in catalog-book-genres.csv`);
    }

    for (const isbn of catalogSet) {
      assert.equal(genreIsbnCounts.get(isbn), 1, `Catalog ISBN ${isbn} is missing from genres mapping`);
    }
  });

  await t.test('4. every genre slug is valid and in genre-taxonomy-proposal.csv', () => {
    const validSlugs = new Set(proposalRows.slice(1).map(r => r[1]));
    assert.equal(validSlugs.size, 37);

    for (const entry of genreEntries) {
      assert.ok(entry.genresStr && entry.genresStr.trim().length > 0, `Empty genres for ISBN ${entry.isbn}`);
      const slugs = entry.genresStr.split(';');

      // 1-3 genres
      assert.ok(slugs.length >= 1 && slugs.length <= 3, `ISBN ${entry.isbn} has ${slugs.length} genres (must be 1-3)`);

      // No duplicate slugs within a book
      const uniqueSlugs = new Set(slugs);
      assert.equal(uniqueSlugs.size, slugs.length, `ISBN ${entry.isbn} has duplicate slugs: ${entry.genresStr}`);

      // Slugs are valid
      for (const slug of slugs) {
        assert.ok(validSlugs.has(slug), `ISBN ${entry.isbn} has unknown slug "${slug}"`);
      }
    }
  });

  await t.test('5. preserves catalog row order', () => {
    for (let i = 0; i < 1002; i++) {
      assert.equal(genreEntries[i].isbn, catalogIsbns[i], `Row ${i + 1} ISBN mismatch`);
    }
  });

  await t.test('6. audit accounting matches exact numbers', () => {
    assert.equal(auditData.sourceBooks, 1002);
    assert.equal(auditData.mappedBooks, 1002);
    assert.equal(auditData.unmappedBooks, 0);
    assert.equal(auditData.booksWithMoreThan3Genres, 0);
    assert.equal(
      auditData.booksWith1Genre + auditData.booksWith2Genres + auditData.booksWith3Genres,
      1002
    );
    assert.ok(Array.isArray(auditData.borderlineBooks) && auditData.borderlineBooks.length > 0);
    for (const b of auditData.borderlineBooks) {
      assert.ok(b.isbn && b.title && b.genres && b.reason);
    }
  });
});
