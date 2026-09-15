import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PrhClient,
  PrhApiError,
  sanitizeUrl,
  formatPrhDate,
} from '../src/services/prh-api.js';
import {
  syncPrhReleases,
  PrhSyncError,
  calculateDefaultDateWindow,
  formatPreferenceRank,
  isEnglishPrhLanguage,
} from '../scripts/catalog/prh-sync.js';
import { CANONICAL_GENRE_SLUGS, mapPrhCategoriesToGenres } from '../scripts/catalog/prh-genre-map.js';

function makeValidIsbn13(prefix) {
  const digits = String(prefix).padStart(12, '0').slice(-12);
  const full12 = digits.startsWith('978') || digits.startsWith('979') ? digits : `978${digits.slice(3)}`;
  const sum = [...full12].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return `${full12}${check}`;
}

function createMockDb({ books = [], genres = [], releaseSources = [] } = {}) {
  const genreList = genres.length > 0 ? genres : Array.from(CANONICAL_GENRE_SLUGS).map((slug, i) => ({
    id: `g-${i + 1}`,
    slug,
    name: slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
  }));
  const genreStore = new Map(genreList.map(g => [g.id, { ...g }]));

  const bookStore = new Map();
  const bookGenresStore = [];
  const sourceStore = new Map(releaseSources.map((source, index) => [
    source.id || `source-${index + 1}`,
    {
      id: source.id || `source-${index + 1}`,
      bookId: source.bookId,
      provider: source.provider || 'prh',
      sourceIsbn: source.sourceIsbn,
      sourceUrl: source.sourceUrl || `https://www.penguinrandomhouse.com/books/${source.sourceIsbn}`,
      verifiedPublicationDate: source.verifiedPublicationDate instanceof Date
        ? source.verifiedPublicationDate
        : (source.verifiedPublicationDate ? new Date(`${source.verifiedPublicationDate}T00:00:00.000Z`) : null),
      lastVerifiedAt: source.lastVerifiedAt instanceof Date
        ? source.lastVerifiedAt
        : (source.lastVerifiedAt ? new Date(source.lastVerifiedAt) : new Date()),
    },
  ]));

  for (const b of books) {
    const bookRecord = {
      id: b.id || `b-${bookStore.size + 1}`,
      title: b.title,
      author: b.author,
      isbn: b.isbn ?? null,
      publicationYear: b.publicationYear ?? null,
      publicationDate: b.publicationDate instanceof Date
        ? b.publicationDate
        : (b.publicationDate ? new Date(`${b.publicationDate}T00:00:00.000Z`) : null),
      coverImageUrl: b.coverImageUrl ?? null,
      description: b.description ?? null,
    };
    bookStore.set(bookRecord.id, bookRecord);

    if (b.genres && Array.isArray(b.genres)) {
      for (const slug of b.genres) {
        const foundGenre = genreList.find(g => g.slug === slug);
        if (foundGenre) {
          bookGenresStore.push({ bookId: bookRecord.id, genreId: foundGenre.id });
        }
      }
    }
  }

  const writes = [];

  function formatBook(b, select) {
    const res = { ...b };
    if (select?.bookGenres) {
      const links = bookGenresStore.filter(bg => bg.bookId === b.id);
      res.bookGenres = links.map(l => {
        const g = genreStore.get(l.genreId);
        return { genre: { slug: g.slug, name: g.name } };
      });
    }
    if (select?.releaseMetadataSource) {
      res.releaseMetadataSource = [...sourceStore.values()].find(source => source.bookId === b.id) || null;
    }
    return res;
  }

  const db = {
    _bookStore: bookStore,
    _bookGenresStore: bookGenresStore,
    _writes: writes,
    _sourceStore: sourceStore,
    _simulateStaleBook: false,
    _simulateStaleSource: false,
    book: {
      findMany: async ({ where, select } = {}) => {
        let results = Array.from(bookStore.values());
        if (where?.isbn?.in) {
          results = results.filter(b => where.isbn.in.includes(b.isbn));
        }
        return results.map(b => formatBook(b, select));
      },
      findUnique: async ({ where, select } = {}) => {
        const book = [...bookStore.values()].find(item => item.id === where.id || item.isbn === where.isbn);
        return book ? formatBook(book, select) : null;
      },
    },
    genre: {
      findMany: async ({ where, select } = {}) => {
        let results = Array.from(genreStore.values());
        if (where?.slug?.in) {
          results = results.filter(g => where.slug.in.includes(g.slug));
        }
        return results;
      },
    },
    releaseMetadataSource: {
      findMany: async ({ where, include, select } = {}) => {
        let list = Array.from(sourceStore.values());
        if (where?.provider) {
          list = list.filter(s => s.provider === where.provider);
        }
        if (where?.sourceIsbn?.in) {
          list = list.filter(s => where.sourceIsbn.in.includes(s.sourceIsbn));
        }
        return list.map(s => {
          const res = { ...s };
          if (include?.book) {
            const b = bookStore.get(s.bookId);
            res.book = b ? { ...b } : null;
          }
          return res;
        });
      },
      findUnique: async ({ where } = {}) => {
        return [...sourceStore.values()].find(source => {
          if (where?.provider_sourceIsbn) {
            return (
              source.provider === where.provider_sourceIsbn.provider &&
              source.sourceIsbn === where.provider_sourceIsbn.sourceIsbn
            );
          }
          if (where?.id) return source.id === where.id;
          return false;
        }) || null;
      },
    },
    $transaction: async (fn) => {
      const snapshotBooks = new Map(Array.from(bookStore.entries()).map(([k, v]) => [k, { ...v }]));
      const snapshotBookGenres = [...bookGenresStore];
      const snapshotSources = new Map([...sourceStore.entries()].map(([key, value]) => [key, { ...value }]));
      const writesBefore = writes.length;

      const tx = {
        book: {
          findMany: async ({ where, select } = {}) => {
            let results = Array.from(bookStore.values());
            if (where?.isbn?.in) {
              results = results.filter(b => where.isbn.in.includes(b.isbn));
            }
            return results.map(b => formatBook(b, select));
          },
          findUnique: async ({ where, select } = {}) => {
            const book = [...bookStore.values()].find(item => item.id === where.id || item.isbn === where.isbn);
            return book ? formatBook(book, select) : null;
          },
          create: async ({ data }) => {
            const id = `b-${bookStore.size + 1}`;
            const bookRecord = {
              id,
              title: data.title,
              author: data.author,
              isbn: data.isbn,
              publicationDate: data.publicationDate,
              publicationYear: data.publicationYear,
              coverImageUrl: data.coverImageUrl,
              description: data.description ?? null,
            };
            bookStore.set(id, bookRecord);
            writes.push({ type: 'book.create', data: bookRecord });

            if (data.bookGenres?.create) {
              for (const bg of data.bookGenres.create) {
                const link = { bookId: id, genreId: bg.genreId };
                bookGenresStore.push(link);
                writes.push({ type: 'bookGenre.create', data: link });
              }
            }
            return bookRecord;
          },
          updateMany: async ({ where, data }) => {
            if (db._simulateStaleBook) {
              return { count: 0 };
            }
            let count = 0;
            for (const book of bookStore.values()) {
              if (where.id && book.id !== where.id) continue;
              if (where.isbn && book.isbn !== where.isbn) continue;
              if (where.publicationDate !== undefined) {
                const targetTime = where.publicationDate instanceof Date ? where.publicationDate.getTime() : new Date(where.publicationDate).getTime();
                const actualTime = book.publicationDate instanceof Date ? book.publicationDate.getTime() : (book.publicationDate ? new Date(book.publicationDate).getTime() : null);
                if (targetTime !== actualTime) continue;
              }
              if (data.publicationDate !== undefined) book.publicationDate = data.publicationDate;
              if (data.publicationYear !== undefined) book.publicationYear = data.publicationYear;
              writes.push({ type: 'book.updateMany', id: book.id, data });
              count++;
            }
            return { count };
          },
        },
        releaseMetadataSource: {
          findMany: async () => [...sourceStore.values()],
          findUnique: async ({ where } = {}) => {
            return [...sourceStore.values()].find(source => {
              if (where?.provider_sourceIsbn) {
                return (
                  source.provider === where.provider_sourceIsbn.provider &&
                  source.sourceIsbn === where.provider_sourceIsbn.sourceIsbn
                );
              }
              if (where?.id) return source.id === where.id;
              return false;
            }) || null;
          },
          create: async ({ data }) => {
            const id = `source-${sourceStore.size + 1}`;
            const source = { id, ...data };
            sourceStore.set(id, source);
            writes.push({ type: 'releaseMetadataSource.create', data: source });
            return source;
          },
          update: async ({ where, data }) => {
            const source = sourceStore.get(where.id);
            if (source) {
              Object.assign(source, data);
              writes.push({ type: 'releaseMetadataSource.update', id: where.id, data });
              return source;
            }
            return null;
          },
          updateMany: async ({ where, data }) => {
            if (db._simulateStaleSource) {
              return { count: 0 };
            }
            let count = 0;
            for (const source of sourceStore.values()) {
              if (where.id && source.id !== where.id) continue;
              if (where.provider && source.provider !== where.provider) continue;
              if (where.sourceIsbn && source.sourceIsbn !== where.sourceIsbn) continue;
              if (where.verifiedPublicationDate !== undefined) {
                const targetTime = where.verifiedPublicationDate instanceof Date ? where.verifiedPublicationDate.getTime() : new Date(where.verifiedPublicationDate).getTime();
                const actualTime = source.verifiedPublicationDate instanceof Date ? source.verifiedPublicationDate.getTime() : (source.verifiedPublicationDate ? new Date(source.verifiedPublicationDate).getTime() : null);
                if (targetTime !== actualTime) continue;
              }
              if (data.verifiedPublicationDate !== undefined) source.verifiedPublicationDate = data.verifiedPublicationDate;
              if (data.lastVerifiedAt !== undefined) source.lastVerifiedAt = data.lastVerifiedAt;
              writes.push({ type: 'releaseMetadataSource.updateMany', id: source.id, data });
              count++;
            }
            return { count };
          },
        },
        genre: {
          findMany: async ({ where } = {}) => {
            let results = Array.from(genreStore.values());
            if (where?.slug?.in) {
              results = results.filter(g => where.slug.in.includes(g.slug));
            }
            return results;
          },
        },
      };

      try {
        const result = await fn(tx);
        return result;
      } catch (err) {
        bookStore.clear();
        for (const [k, v] of snapshotBooks.entries()) bookStore.set(k, v);
        bookGenresStore.length = 0;
        bookGenresStore.push(...snapshotBookGenres);
        sourceStore.clear();
        for (const [k, v] of snapshotSources.entries()) sourceStore.set(k, v);
        writes.length = writesBefore;
        throw err;
      }
    },
  };

  return db;
}

// =========================================================================
// 1-7: PRH CLIENT TESTS
// =========================================================================

test('1. API key never leaked in error messages or URLs', async () => {
  const secretKey = 'super-secret-prh-token-12345';
  const urlWithSecret = `https://api.penguinrandomhouse.com/title/client/Public/domains/PRH.US/titles?foo=bar&api_key=${secretKey}`;
  const sanitized = sanitizeUrl(urlWithSecret);
  assert.equal(sanitized.includes(secretKey), false);
  assert.equal(sanitized.includes('[REDACTED]'), true);

  const client = new PrhClient({
    apiKey: secretKey,
    maxAttempts: 1,
    fetchImpl: async (url) => {
      throw new Error(`Failed to fetch from ${url}`);
    },
  });

  const testIsbn = makeValidIsbn13('978059344444');
  await assert.rejects(
    async () => client.getTitleByIsbn(testIsbn),
    (err) => {
      assert.equal(err instanceof PrhApiError, true);
      assert.equal(err.message.includes(secretKey), false, 'Error message must not contain raw secret');
      assert.equal(err.message.includes('[REDACTED]'), true);
      return true;
    }
  );
});

test('2. Date range formatted and query parameters encoded correctly in listTitlesByOnSaleRange', async () => {
  let requestedUrl = '';
  const client = new PrhClient({
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { titles: [] }, recordCount: 0 }),
      };
    },
  });

  await client.listTitlesByOnSaleRange({ from: '2026-06-15', to: '2026-09-15', start: 0, rows: 50 });

  assert.equal(requestedUrl.includes('onSaleFrom=06%2F15%2F2026'), true);
  assert.equal(requestedUrl.includes('onSaleTo=09%2F15%2F2026'), true);
  assert.equal(requestedUrl.includes('start=0'), true);
  assert.equal(requestedUrl.includes('rows=50'), true);
});

test('3. Pagination handles multi-page responses', async () => {
  let calls = 0;
  const client = new PrhClient({
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      calls++;
      const u = new URL(url);
      const start = parseInt(u.searchParams.get('start'), 10);
      if (start === 0) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            recordCount: 150,
            data: { titles: Array.from({ length: 100 }, (_, i) => ({ isbn: makeValidIsbn13(`978000000${String(i).padStart(3, '0')}`), title: `Book ${i}`, format: { code: 'HC' } })) },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          recordCount: 150,
          data: { titles: Array.from({ length: 50 }, (_, i) => ({ isbn: makeValidIsbn13(`978000001${String(i).padStart(3, '0')}`), title: `Book ${100 + i}`, format: { code: 'HC' } })) },
        }),
      };
    },
  });

  const db = createMockDb();
  const res = await syncPrhReleases(db, {
    client,
    asOf: '2026-07-01',
    from: '2026-06-01',
    to: '2026-08-01',
  });

  assert.equal(calls, 2);
  assert.equal(res.summary.discovery.remoteTitlesFetched, 150);
});

test('4. HTTP 429 retries with Retry-After backoff', async () => {
  let attempts = 0;
  const sleepDelays = [];
  const client = new PrhClient({
    apiKey: 'test-key',
    maxAttempts: 3,
    sleep: async (ms) => { sleepDelays.push(ms); },
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', '2']]),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { titles: [{ title: 'Success After 429' }] } }),
      };
    },
  });

  const testIsbn = makeValidIsbn13('978059344444');
  const res = await client.getTitleByIsbn(testIsbn);
  assert.equal(attempts, 2);
  assert.deepEqual(sleepDelays, [2000]);
  assert.equal(res.title, 'Success After 429');
});

test('5. HTTP 5xx retries with backoff', async () => {
  let attempts = 0;
  const sleepDelays = [];
  const client = new PrhClient({
    apiKey: 'test-key',
    maxAttempts: 3,
    backoffMs: [100, 200],
    sleep: async (ms) => { sleepDelays.push(ms); },
    fetchImpl: async () => {
      attempts++;
      if (attempts < 3) {
        return {
          ok: false,
          status: 503,
          headers: new Map(),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { titles: [{ title: 'Success After 503' }] } }),
      };
    },
  });

  const testIsbn = makeValidIsbn13('978059344444');
  const res = await client.getTitleByIsbn(testIsbn);
  assert.equal(attempts, 3);
  assert.deepEqual(sleepDelays, [100, 200]);
  assert.equal(res.title, 'Success After 503');
});

test('6. HTTP 4xx (non-429) fails immediately without retry', async () => {
  let attempts = 0;
  const client = new PrhClient({
    apiKey: 'test-key',
    maxAttempts: 3,
    fetchImpl: async () => {
      attempts++;
      return {
        ok: false,
        status: 400,
        headers: new Map(),
      };
    },
  });

  const testIsbn = makeValidIsbn13('978059344444');
  await assert.rejects(
    async () => client.getTitleByIsbn(testIsbn),
    (err) => {
      assert.equal(err instanceof PrhApiError, true);
      assert.equal(err.status, 400);
      assert.equal(err.attempts, 1);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test('7. Timeout triggers AbortSignal and fails boundedly', async () => {
  let attempts = 0;
  const client = new PrhClient({
    apiKey: 'test-key',
    maxAttempts: 2,
    backoffMs: [10],
    sleep: async () => {},
    fetchImpl: async () => {
      attempts++;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
  });

  const testIsbn = makeValidIsbn13('978059344444');
  await assert.rejects(
    async () => client.getTitleByIsbn(testIsbn),
    (err) => {
      assert.equal(err instanceof PrhApiError, true);
      assert.equal(err.code, 'timeout');
      assert.equal(err.attempts, 2);
      return true;
    }
  );
  assert.equal(attempts, 2);
});

// =========================================================================
// 8-19: REFRESH PHASE TESTS
// =========================================================================

test('8. Unchanged remote date marks source verified without modifying Book.publicationDate', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const originalDate = '2026-07-15';
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: originalDate, publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: originalDate }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: '2026-07-15',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: false });
  assert.equal(res.summary.refresh.managedSources, 1);
  assert.equal(res.summary.refresh.unchanged, 1);
  assert.equal(res.summary.refresh.dateChanged, 0);
  assert.equal(res.summary.refresh.localDivergence, 0);
});

test('9. Changed remote date updates Book.publicationDate, publicationYear and verifiedPublicationDate', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const oldDate = '2026-07-15';
  const newDate = '2026-08-20';
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: oldDate, publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: oldDate }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: newDate,
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: true });
  assert.equal(res.summary.refresh.dateChanged, 1);
  assert.equal(res.summary.refresh.updated, 1);

  const updatedBook = db._bookStore.get('b-1');
  assert.equal(updatedBook.publicationDate.toISOString().slice(0, 10), newDate);
  assert.equal(updatedBook.publicationYear, 2026);

  const updatedSource = db._sourceStore.get('s-1');
  assert.equal(updatedSource.verifiedPublicationDate.toISOString().slice(0, 10), newDate);
});

test('10. Local divergence (Book.publicationDate !== verifiedPublicationDate) blocks refresh and preserves local date', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const localDate = '2026-05-01';
  const verifiedDate = '2026-07-15';
  const remoteDate = '2026-09-01';

  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: localDate, publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: verifiedDate }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: remoteDate,
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: true });
  assert.equal(res.summary.refresh.localDivergence, 1);
  assert.equal(res.summary.refresh.updated, 0);

  const book = db._bookStore.get('b-1');
  assert.equal(book.publicationDate.toISOString().slice(0, 10), localDate);
});

test('11. Mismatched remote ISBN blocks refresh', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const differentIsbn = makeValidIsbn13('978059399999');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn: differentIsbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: '2026-08-01',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: true });
  assert.equal(res.summary.refresh.identityConflicts, 1);
  assert.equal(res.summary.refresh.updated, 0);
});

test('12. Identity mismatch (title/author incompatible) blocks refresh', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Original Novel Title', author: 'Original Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Completely Unrelated Book',
      author: 'Someone Else Entirely',
      onsale: '2026-08-01',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: true });
  assert.equal(res.summary.refresh.identityConflicts, 1);
  assert.equal(res.summary.refresh.updated, 0);
});

test('13. Remote 404/missing title recorded without modifying database', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: true });
  assert.equal(res.summary.refresh.remoteMissing, 1);
  assert.equal(res.summary.refresh.updated, 0);
});

test('14. Malformed/missing remote onsale date recorded without modifying database', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: 'invalid-date-string',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: true });
  assert.equal(res.summary.refresh.remoteInvalid, 1);
  assert.equal(res.summary.refresh.updated, 0);
});

test('15. Dry-run performs zero writes for refresh', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: '2026-08-01',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: false });
  assert.equal(res.summary.refresh.dateChanged, 1);
  assert.equal(db._writes.length, 0);
  assert.equal(res.summary.refresh.updated, 0);
});

test('16. Apply updates Book.publicationDate, Book.publicationYear, ReleaseMetadataSource.verifiedPublicationDate atomically', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: '2027-01-10',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  await syncPrhReleases(db, { client, apply: true });
  const book = db._bookStore.get('b-1');
  assert.equal(book.publicationDate.toISOString().slice(0, 10), '2027-01-10');
  assert.equal(book.publicationYear, 2027);

  const source = db._sourceStore.get('s-1');
  assert.equal(source.verifiedPublicationDate.toISOString().slice(0, 10), '2027-01-10');
});

test('17. Apply updates ReleaseMetadataSource.lastVerifiedAt on unchanged date', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const oldVerification = new Date('2025-01-01T00:00:00.000Z');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15', lastVerifiedAt: oldVerification }],
  });

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: '2026-07-15',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  const res = await syncPrhReleases(db, { client, apply: true });
  assert.equal(res.summary.refresh.verified, 1);
  const source = db._sourceStore.get('s-1');
  assert.notEqual(source.lastVerifiedAt.getTime(), oldVerification.getTime());
});

test('18. Stale preflight: concurrent modification of Book.publicationDate rolls back', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  db._simulateStaleBook = true;

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: '2026-08-15',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  await assert.rejects(
    async () => syncPrhReleases(db, { client, apply: true }),
    (err) => {
      assert.equal(err instanceof PrhSyncError, true);
      assert.equal(err.code, 'stale_preflight');
      return true;
    }
  );

  assert.equal(db._writes.length, 0);
});

test('19. Stale preflight: concurrent modification of ReleaseMetadataSource rolls back', async () => {
  const isbn = makeValidIsbn13('978059344444');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Existing Novel', author: 'Known Author', publicationDate: '2026-07-15', publicationYear: 2026 }],
    releaseSources: [{ id: 's-1', bookId: 'b-1', provider: 'prh', sourceIsbn: isbn, verifiedPublicationDate: '2026-07-15' }],
  });

  db._simulateStaleSource = true;

  const client = {
    getTitleByIsbn: async () => ({
      isbn,
      title: 'Existing Novel',
      author: 'Known Author',
      onsale: '2026-08-15',
    }),
    listTitlesByOnSaleRange: async () => ({ titles: [] }),
  };

  await assert.rejects(
    async () => syncPrhReleases(db, { client, apply: true }),
    (err) => {
      assert.equal(err instanceof PrhSyncError, true);
      assert.equal(err.code, 'stale_preflight');
      return true;
    }
  );

  assert.equal(db._writes.length, 0);
});

// =========================================================================
// 20-34: DISCOVERY PHASE TESTS
// =========================================================================

test('20. Excluded format: eBook rejected', () => {
  const rank1 = formatPreferenceRank({ code: 'EB', description: 'Electronic Book' });
  const rank2 = formatPreferenceRank(null, 'ebook edition');
  assert.equal(rank1, -1);
  assert.equal(rank2, -1);
});

test('21. Excluded format: audiobook rejected', () => {
  const rank1 = formatPreferenceRank({ code: 'AB', description: 'Audiobook on CD' });
  const rank2 = formatPreferenceRank(null, 'Compact Disc Audio');
  assert.equal(rank1, -1);
  assert.equal(rank2, -1);
});

test('22. Accepted format: Hardcover (HC) accepted with top rank', () => {
  const rank1 = formatPreferenceRank({ code: 'HC', description: 'Hardcover' });
  const rank2 = formatPreferenceRank(null, 'Hardcover');
  assert.equal(rank1, 1);
  assert.equal(rank2, 1);
});

test('23. Format preference: HC preferred over Paperback for same work', () => {
  const hcRank = formatPreferenceRank({ code: 'HC' }, 'Hardcover');
  const trRank = formatPreferenceRank({ code: 'TR' }, 'Trade Paperback');
  const pbRank = formatPreferenceRank({ code: 'PB' }, 'Mass Market Paperback');
  assert.equal(hcRank < trRank, true);
  assert.equal(trRank < pbRank, true);
});

test('24. Deduplication: multiple editions of same PRH workId collapsed to preferred edition', async () => {
  const isbn1 = makeValidIsbn13('978059300001');
  const isbn2 = makeValidIsbn13('978059300002');
  const db = createMockDb();
  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn: isbn1,
          workId: 12345,
          title: 'The Great Space Odyssey',
          author: 'Arthur Science',
          onsale: '2026-07-20',
          format: { code: 'PB' },
          formatDescription: 'Paperback',
          seoFriendlyUrl: '/books/12345/pb',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover1.jpg' }],
          categories: [{ description: 'Science Fiction' }],
        },
        {
          isbn: isbn2,
          workId: 12345,
          title: 'The Great Space Odyssey',
          author: 'Arthur Science',
          onsale: '2026-07-20',
          format: { code: 'HC' },
          formatDescription: 'Hardcover',
          seoFriendlyUrl: '/books/12345/hc',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover2.jpg' }],
          categories: [{ description: 'Science Fiction' }],
        },
      ],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01' });
  assert.equal(res.summary.discovery.eligiblePrintTitles, 2);
  assert.equal(res.summary.discovery.duplicateEditionsRemoved, 1);
  assert.equal(res.summary.discovery.plannedNew, 1);
  assert.equal(res.details.discovery.plannedNew[0].isbn, isbn2, 'HC edition should be selected');
});

test('25. Deduplication: candidate with ISBN already in Bookish skipped', async () => {
  const isbn = makeValidIsbn13('978059311111');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn, title: 'Already In DB', author: 'Some Author', publicationDate: '2026-06-01' }],
  });

  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn,
          title: 'Already In DB',
          author: 'Some Author',
          onsale: '2026-06-01',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/already',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover.jpg' }],
          categories: [{ description: 'Fiction' }],
        },
      ],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01' });
  assert.equal(res.summary.discovery.alreadyInBookish, 1);
  assert.equal(res.summary.discovery.plannedNew, 0);
});

test('26. Deduplication: candidate matching existing Bookish work (title/author) skipped', async () => {
  const existingIsbn = makeValidIsbn13('978059322222');
  const newCandidateIsbn = makeValidIsbn13('978059333333');
  const db = createMockDb({
    books: [{ id: 'b-1', isbn: existingIsbn, title: 'Dune Messiah', author: 'Frank Herbert', publicationDate: '2026-01-01' }],
  });

  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn: newCandidateIsbn,
          title: 'Dune Messiah',
          author: 'Frank Herbert',
          onsale: '2026-08-01',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/dune-messiah',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover.jpg' }],
          categories: [{ description: 'Science Fiction' }],
        },
      ],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01' });
  assert.equal(res.summary.discovery.workCollisions, 1);
  assert.equal(res.summary.discovery.plannedNew, 0);
});

test('27. Missing or placeholder cover image skipped', async () => {
  const isbn1 = makeValidIsbn13('978059344441');
  const isbn2 = makeValidIsbn13('978059344442');
  const db = createMockDb();
  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn: isbn1,
          title: 'No Cover Book',
          author: 'Coverless Author',
          onsale: '2026-07-01',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/no-cover',
          _links: [],
          categories: [{ description: 'Fiction' }],
        },
        {
          isbn: isbn2,
          title: 'Placeholder Cover Book',
          author: 'Author Two',
          onsale: '2026-07-01',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/placeholder',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/placeholder-cover.jpg' }],
          categories: [{ description: 'Fiction' }],
        },
      ],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01' });
  assert.equal(res.summary.discovery.invalidCandidates, 2);
  assert.equal(res.summary.discovery.plannedNew, 0);
});

test('28. Missing or unmappable PRH categories skipped', async () => {
  const isbn = makeValidIsbn13('978059355555');
  const db = createMockDb();
  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn,
          title: 'Unmappable Book',
          author: 'Niche Author',
          onsale: '2026-07-01',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/unmappable',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover.jpg' }],
          categories: [{ description: 'Non-Classifiable Specialized Manual' }],
        },
      ],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01' });
  assert.equal(res.summary.discovery.unmappedGenres, 1);
  assert.equal(res.summary.discovery.plannedNew, 0);
});

test('29. Valid categories mapped to 1-3 canonical Bookish genres', () => {
  const mapped1 = mapPrhCategoriesToGenres([
    { description: 'Space Opera' },
    { description: 'Military Science Fiction' },
  ]);
  assert.deepEqual(mapped1, ['space-opera', 'science-fiction']);

  const mapped2 = mapPrhCategoriesToGenres([
    { description: 'Epic Fantasy' },
    { description: 'High Fantasy' },
    { description: 'Historical Fiction' },
    { description: 'Romance' },
  ]);
  assert.equal(mapped2.length, 3);
  assert.equal(mapped2.every(s => CANONICAL_GENRE_SLUGS.has(s)), true);
});

test('30. Controlled growth: max-new limit enforced', async () => {
  const db = createMockDb();
  const titles = Array.from({ length: 15 }, (_, i) => ({
    isbn: makeValidIsbn13(`978059366${String(i).padStart(3, '0')}`),
    workId: 1000 + i,
    title: `Safe Book ${i}`,
    author: `Author ${i}`,
    onsale: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
    format: { code: 'HC' },
    seoFriendlyUrl: `/books/safe-${i}`,
    _links: [{ rel: 'icon', href: `https://images.penguinrandomhouse.com/cover-${i}.jpg` }],
    categories: [{ description: 'Fiction' }],
  }));

  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({ titles }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01', maxNew: 5 });
  assert.equal(res.summary.discovery.safeCandidates, 15);
  assert.equal(res.summary.discovery.plannedNew, 5);
  assert.equal(res.summary.discovery.deferredByLimit, 10);
});

test('31. Controlled growth: excess candidates reported in details.discovery.deferredByLimit', async () => {
  const db = createMockDb();
  const titles = Array.from({ length: 4 }, (_, i) => ({
    isbn: makeValidIsbn13(`978059377${String(i).padStart(3, '0')}`),
    workId: 2000 + i,
    title: `Excess Book ${i}`,
    author: `Author ${i}`,
    onsale: `2026-07-1${i}`,
    format: { code: 'HC' },
    seoFriendlyUrl: `/books/excess-${i}`,
    _links: [{ rel: 'icon', href: `https://images.penguinrandomhouse.com/cover-${i}.jpg` }],
    categories: [{ description: 'Science Fiction' }],
  }));

  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({ titles }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01', maxNew: 2 });
  assert.equal(res.details.discovery.deferredByLimit.length, 2);
  assert.equal(res.details.discovery.deferredByLimit[0].isbn, titles[2].isbn);
});

test('32. Dry-run performs zero writes for discovery', async () => {
  const isbn = makeValidIsbn13('978059388888');
  const db = createMockDb();
  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn,
          title: 'Dry Discovery Book',
          author: 'Dry Author',
          onsale: '2026-07-15',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/dry-discovery',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover.jpg' }],
          categories: [{ description: 'Fiction' }],
        },
      ],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01', apply: false });
  assert.equal(res.summary.discovery.plannedNew, 1);
  assert.equal(res.summary.discovery.created, 0);
  assert.equal(db._writes.length, 0);
});

test('33. Apply creates Book + BookGenre + ReleaseMetadataSource via release-catalog importer', async () => {
  const isbn = makeValidIsbn13('978059399991');
  const db = createMockDb();
  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn,
          title: 'Applied Discovery Novel',
          author: 'Applied Author',
          onsale: '2026-07-15',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/applied-discovery',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover.jpg' }],
          categories: [{ description: 'Science Fiction' }],
        },
      ],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01', apply: true });
  assert.equal(res.summary.discovery.plannedNew, 1);
  assert.equal(res.summary.discovery.created, 1);

  const createdBook = [...db._bookStore.values()].find(b => b.isbn === isbn);
  assert.ok(createdBook);
  assert.equal(createdBook.title, 'Applied Discovery Novel');
  assert.equal(createdBook.publicationYear, 2026);
  assert.equal(createdBook.publicationDate.toISOString().slice(0, 10), '2026-07-15');

  const createdSource = [...db._sourceStore.values()].find(s => s.sourceIsbn === isbn);
  assert.ok(createdSource);
  assert.equal(createdSource.provider, 'prh');
  assert.equal(createdSource.bookId, createdBook.id);
});

test('34. Second sync run with same data discovers 0 new books (idempotent)', async () => {
  const isbn = makeValidIsbn13('978059399992');
  const db = createMockDb();
  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [
        {
          isbn,
          title: 'Idempotent Novel',
          author: 'Idempotent Author',
          onsale: '2026-07-15',
          format: { code: 'HC' },
          seoFriendlyUrl: '/books/idempotent-novel',
          _links: [{ rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover.jpg' }],
          categories: [{ description: 'Fiction' }],
        },
      ],
    }),
  };

  // Run 1: Apply
  const run1 = await syncPrhReleases(db, { client, asOf: '2026-07-01', apply: true });
  assert.equal(run1.summary.discovery.created, 1);

  // Run 2: Same data
  const run2 = await syncPrhReleases(db, { client, asOf: '2026-07-01', apply: true });
  assert.equal(run2.summary.discovery.alreadyInBookish, 1);
  assert.equal(run2.summary.discovery.plannedNew, 0);
  assert.equal(run2.summary.discovery.created, 0);
});

// =========================================================================
// 35-43: PRH LANGUAGE HANDLING TESTS
// =========================================================================

test('35. isEnglishPrhLanguage: language "E" is accepted', () => {
  assert.equal(isEnglishPrhLanguage({ language: 'E' }), true);
  assert.equal(isEnglishPrhLanguage('E'), true);
});

test('36. isEnglishPrhLanguage: language "e" is accepted', () => {
  assert.equal(isEnglishPrhLanguage({ language: 'e' }), true);
  assert.equal(isEnglishPrhLanguage('e'), true);
});

test('37. isEnglishPrhLanguage: language "English" is accepted', () => {
  assert.equal(isEnglishPrhLanguage({ language: 'English' }), true);
  assert.equal(isEnglishPrhLanguage({ languageDescription: 'English' }), true);
  assert.equal(isEnglishPrhLanguage({ language: '', languageDescription: 'English' }), true);
  assert.equal(isEnglishPrhLanguage('English'), true);
});

test('38. isEnglishPrhLanguage: language "ENG" is accepted', () => {
  assert.equal(isEnglishPrhLanguage({ language: 'ENG' }), true);
  assert.equal(isEnglishPrhLanguage({ language: 'en' }), true);
  assert.equal(isEnglishPrhLanguage('ENG'), true);
});

test('39. isEnglishPrhLanguage: blank/missing language is accepted', () => {
  assert.equal(isEnglishPrhLanguage({}), true);
  assert.equal(isEnglishPrhLanguage({ language: '' }), true);
  assert.equal(isEnglishPrhLanguage({ language: '   ' }), true);
  assert.equal(isEnglishPrhLanguage({ language: null }), true);
  assert.equal(isEnglishPrhLanguage({ languageDescription: '' }), true);
  assert.equal(isEnglishPrhLanguage(null), true);
  assert.equal(isEnglishPrhLanguage(undefined), true);
  assert.equal(isEnglishPrhLanguage(''), true);
});

test('40. isEnglishPrhLanguage: language "SP" is rejected', () => {
  assert.equal(isEnglishPrhLanguage({ language: 'SP' }), false);
  assert.equal(isEnglishPrhLanguage('SP'), false);
});

test('41. isEnglishPrhLanguage: language "Spanish" is rejected', () => {
  assert.equal(isEnglishPrhLanguage({ language: 'Spanish' }), false);
  assert.equal(isEnglishPrhLanguage({ languageDescription: 'Spanish' }), false);
  assert.equal(isEnglishPrhLanguage({ language: '', languageDescription: 'Spanish' }), false);
  assert.equal(isEnglishPrhLanguage('Spanish'), false);
});

test('42. isEnglishPrhLanguage: explicit unknown non-empty code is rejected', () => {
  assert.equal(isEnglishPrhLanguage({ language: 'FR' }), false);
  assert.equal(isEnglishPrhLanguage({ language: 'DE' }), false);
  assert.equal(isEnglishPrhLanguage({ language: 'XYZ' }), false);
  assert.equal(isEnglishPrhLanguage('XYZ'), false);
});

test('43. Realistic PRH Title fixture with language "E" survives discovery filtering', async () => {
  const isbn = makeValidIsbn13('978059399993');
  const db = createMockDb();
  const realisticPrhTitleFixture = {
    isbn,
    workId: 456789,
    title: 'The Starlight Archive',
    author: 'Brandon Sanderson',
    onsale: '2026-08-15',
    language: 'E',
    languageDescription: 'English',
    format: { code: 'HC', description: 'Hardcover' },
    formatDescription: 'Hardcover',
    seoFriendlyUrl: '/books/456789/the-starlight-archive-by-brandon-sanderson',
    _links: [
      { rel: 'icon', href: 'https://images.penguinrandomhouse.com/cover/456789.jpg' },
    ],
    categories: [
      { catUri: '/categories/epic-fantasy', description: 'Epic Fantasy' },
    ],
  };

  const client = {
    getTitleByIsbn: async () => null,
    listTitlesByOnSaleRange: async () => ({
      titles: [realisticPrhTitleFixture],
    }),
  };

  const res = await syncPrhReleases(db, { client, asOf: '2026-07-01', apply: false });
  assert.equal(res.summary.discovery.eligiblePrintTitles, 1);
  assert.equal(res.summary.discovery.invalidCandidates, 0);
  assert.equal(res.summary.discovery.plannedNew, 1);
  assert.equal(res.details.discovery.plannedNew[0].isbn, isbn);
  assert.equal(res.details.discovery.plannedNew[0].title, 'The Starlight Archive');
});

