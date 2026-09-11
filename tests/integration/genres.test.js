import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('GET /api/genres endpoint', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  let assignedGenre1, assignedGenre2, orphanGenre, bookId;

  t.after(async () => {
    if (bookId) await prisma.book.delete({ where: { id: bookId } });
    if (assignedGenre1) await prisma.genre.delete({ where: { id: assignedGenre1.id } });
    if (assignedGenre2) await prisma.genre.delete({ where: { id: assignedGenre2.id } });
    if (orphanGenre) await prisma.genre.delete({ where: { id: orphanGenre.id } });
    await prisma.$disconnect();
  });

  // Create test genres (Zebra comes after Alpha alphabetically)
  assignedGenre1 = await prisma.genre.create({ data: { name: `Zebra Genre ${tag}`, slug: `zebra-${tag}` } });
  assignedGenre2 = await prisma.genre.create({ data: { name: `Alpha Genre ${tag}`, slug: `alpha-${tag}` } });
  orphanGenre = await prisma.genre.create({ data: { name: `Orphan Genre ${tag}`, slug: `orphan-${tag}` } });

  // Create a book and assign only assignedGenre1 and assignedGenre2
  const book = await prisma.book.create({
    data: {
      title: `Genre Test Book ${tag}`,
      author: 'Genre Author',
      bookGenres: {
        create: [
          { genreId: assignedGenre1.id },
          { genreId: assignedGenre2.id },
        ],
      },
    },
  });
  bookId = book.id;

  // 1. GET /api/genres is public and returns 200 without auth
  const res = await request(app).get('/api/genres').expect(200);

  assert.ok(Array.isArray(res.body.data));
  const returnedSlugs = res.body.data.map(g => g.slug);

  // 2. Returns assigned genres
  assert.ok(returnedSlugs.includes(assignedGenre1.slug));
  assert.ok(returnedSlugs.includes(assignedGenre2.slug));

  // 3. Does not return unused/orphan genre
  assert.ok(!returnedSlugs.includes(orphanGenre.slug));

  // 4. Returns only safe fields (id, name, slug)
  for (const item of res.body.data) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'slug']);
  }

  // 5. Results are deterministically sorted by name ascending
  const testGenresOnly = res.body.data.filter(g => g.slug.includes(tag));
  assert.equal(testGenresOnly.length, 2);
  assert.equal(testGenresOnly[0].slug, assignedGenre2.slug); // Alpha Genre
  assert.equal(testGenresOnly[1].slug, assignedGenre1.slug); // Zebra Genre
});
