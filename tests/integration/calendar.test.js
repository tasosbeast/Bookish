import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { signTokens, digest } from '../../src/services/tokens.js';

test('PostgreSQL: GET /api/calendar date bounds, user isolation, historical completions, rereads, and validation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const passwordHash = await bcrypt.hash('secretPassphrase123!', 10);

    let userA, userB;
    let tokenA;
    const bookIds = [];
    const activityIds = [];
    let genreId;

    t.after(async () => {
      if (activityIds.length) {
        await prisma.activity.deleteMany({ where: { id: { in: activityIds } } });
      }
      if (bookIds.length) {
        await prisma.bookGenre.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.userBook.deleteMany({ where: { bookId: { in: bookIds } } });
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      }
      if (genreId) {
        await prisma.genre.delete({ where: { id: genreId } });
      }
      if (userA || userB) {
        await prisma.refreshSession.deleteMany({
          where: { userId: { in: [userA?.id, userB?.id].filter(Boolean) } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: [userA?.id, userB?.id].filter(Boolean) } },
        });
      }
      await prisma.$disconnect();
    });

    // Create users
    userA = await prisma.user.create({
      data: {
        username: `cal_a_${tag}`,
        email: `cal_a_${tag}@example.com`,
        passwordHash,
      },
    });

    userB = await prisma.user.create({
      data: {
        username: `cal_b_${tag}`,
        email: `cal_b_${tag}@example.com`,
        passwordHash,
      },
    });

    // Create active session for userA
    const sessionIdA = randomUUID();
    const expiresAtA = new Date(Date.now() + 86400000);
    const { accessToken } = signTokens(userA.id, sessionIdA, expiresAtA);
    tokenA = accessToken;

    await prisma.refreshSession.create({
      data: {
        id: sessionIdA,
        userId: userA.id,
        tokenHash: digest(`cal-${sessionIdA}`),
        expiresAt: expiresAtA,
      },
    });

    // Create Genre
    const genre = await prisma.genre.create({
      data: { name: `CalGenre ${tag}`, slug: `cal-genre-${tag}` },
    });
    genreId = genre.id;

    // Helper to create test book
    async function createBook(title, publicationDate, publicationYear = null) {
      const book = await prisma.book.create({
        data: {
          title: `${title} ${tag}`,
          author: `Author ${tag}`,
          isbn: `978${Math.floor(1000000000 + Math.random() * 9000000000)}`,
          publicationYear: publicationYear ?? (publicationDate ? Number(publicationDate.slice(0, 4)) : 2026),
          publicationDate: publicationDate ? new Date(`${publicationDate}T00:00:00.000Z`) : null,
          bookGenres: { create: { genreId } },
        },
      });
      bookIds.push(book.id);
      return book;
    }

    // Helper to create activity
    async function createActivity(userId, bookId, type, finishedOn, options = {}) {
      const activity = await prisma.activity.create({
        data: {
          userId,
          bookId,
          type,
          finishedOn: finishedOn ? new Date(`${finishedOn}T00:00:00.000Z`) : null,
          historical: options.historical ?? false,
          createdAt: options.createdAt ?? new Date(),
        },
      });
      activityIds.push(activity.id);
      return activity;
    }

    const rangeFrom = '2026-08-31';
    const rangeTo = '2026-10-11';

    // 1. Release on first visible date (2026-08-31)
    const bRelFirst = await createBook('Release First Day', '2026-08-31');
    // 2. Release on last visible date (2026-10-11)
    const bRelLast = await createBook('Release Last Day', '2026-10-11');
    // 3. Release inside range (2026-09-15)
    const bRelMid = await createBook('Release Mid Range', '2026-09-15');
    // 4. Release before range (2026-08-30) - should NOT appear
    const bRelBefore = await createBook('Release Before', '2026-08-30');
    // 5. Release after range (2026-10-12) - should NOT appear
    const bRelAfter = await createBook('Release After', '2026-10-12');
    // 6. Book with publicationYear only (null publicationDate) - should NOT appear
    const bYearOnly = await createBook('Release Year Only', null, 2026);

    // 7. User A completion on first visible date (2026-08-31)
    const actFinFirst = await createActivity(userA.id, bRelMid.id, 'finished_reading', '2026-08-31');
    // 8. User A completion on last visible date (2026-10-11)
    const actFinLast = await createActivity(userA.id, bRelMid.id, 'finished_reading', '2026-10-11');
    // 9. User A historical=true completion inside range (2026-09-05) - MUST appear
    const actHist = await createActivity(userA.id, bRelFirst.id, 'finished_reading', '2026-09-05', { historical: true });
    // 10 & 11. User A rereads for the same book (2026-09-10 and 2026-09-20) - BOTH must appear
    const bReread = await createBook('Reread Book', '2026-01-01');
    const actReread1 = await createActivity(userA.id, bReread.id, 'finished_reading', '2026-09-10');
    const actReread2 = await createActivity(userA.id, bReread.id, 'finished_reading', '2026-09-20');
    // 12. User A finishedOn differs from createdAt (finishedOn: 2026-09-12, createdAt: 2026-10-25) - must use finishedOn
    const actDateMismatch = await createActivity(userA.id, bRelLast.id, 'finished_reading', '2026-09-12', {
      createdAt: new Date('2026-10-25T12:00:00.000Z'),
    });
    // 13. User A finished_reading with null finishedOn - should NOT appear
    const actNullFin = await createActivity(userA.id, bRelMid.id, 'finished_reading', null);
    // 14. User A started_reading activity - should NOT appear in Calendar v1
    const actStarted = await createActivity(userA.id, bRelMid.id, 'started_reading', '2026-09-15');
    // 15. User B (different user) completion in range - should NOT appear for User A
    const actUserB = await createActivity(userB.id, bRelMid.id, 'finished_reading', '2026-09-15');

    // ============================================================
    // Test 1: Authentication required
    // ============================================================
    await request(app)
      .get('/api/calendar')
      .query({ from: rangeFrom, to: rangeTo })
      .expect(401);

    // ============================================================
    // Test 2: Validation errors
    // ============================================================
    // Missing params
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);

    // from > to
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ from: '2026-09-15', to: '2026-09-10' })
      .expect(400);

    // Range > 42 days (43 days)
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ from: '2026-08-31', to: '2026-10-12' })
      .expect(400);

    // Impossible calendar date (Feb 31)
    await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ from: '2026-02-31', to: '2026-03-10' })
      .expect(400);

    // ============================================================
    // Test 3: Successful request & headers
    // ============================================================
    const res = await request(app)
      .get('/api/calendar')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ from: rangeFrom, to: rangeTo })
      .expect(200);

    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body.range, { from: rangeFrom, to: rangeTo });

    const events = res.body.events;
    const eventIds = events.map(e => e.id);

    // ============================================================
    // Test 4: Release events coverage
    // ============================================================
    assert.ok(eventIds.includes(`release:${bRelFirst.id}:2026-08-31`), 'Release on first visible date included');
    assert.ok(eventIds.includes(`release:${bRelLast.id}:2026-10-11`), 'Release on last visible date included');
    assert.ok(eventIds.includes(`release:${bRelMid.id}:2026-09-15`), 'Release in middle of range included');

    assert.ok(!eventIds.includes(`release:${bRelBefore.id}:2026-08-30`), 'Release before range excluded');
    assert.ok(!eventIds.includes(`release:${bRelAfter.id}:2026-10-12`), 'Release after range excluded');
    assert.ok(!eventIds.some(id => id.includes(bYearOnly.id)), 'publicationYear-only book excluded');

    // ============================================================
    // Test 5: Finished events coverage & User isolation
    // ============================================================
    assert.ok(eventIds.includes(`finished:${actFinFirst.id}`), 'Finished on first visible date included');
    assert.ok(eventIds.includes(`finished:${actFinLast.id}`), 'Finished on last visible date included');
    assert.ok(eventIds.includes(`finished:${actHist.id}`), 'historical=true finished completion included');

    // Rereads
    assert.ok(eventIds.includes(`finished:${actReread1.id}`), 'First reread included');
    assert.ok(eventIds.includes(`finished:${actReread2.id}`), 'Second reread included');
    const rereadEvents = events.filter(e => e.book.id === bReread.id);
    assert.equal(rereadEvents.length, 2, 'Both reread completions returned as distinct events');

    // finishedOn semantics over createdAt
    const dateMismatchEvent = events.find(e => e.id === `finished:${actDateMismatch.id}`);
    assert.ok(dateMismatchEvent, 'Event with mismatched createdAt found');
    assert.equal(dateMismatchEvent.date, '2026-09-12', 'Uses finishedOn date, not createdAt');

    // Exclusions
    assert.ok(!eventIds.includes(`finished:${actNullFin.id}`), 'null finishedOn excluded');
    assert.ok(!eventIds.some(id => id.includes(actStarted.id)), 'started_reading excluded');
    assert.ok(!eventIds.includes(`finished:${actUserB.id}`), 'Other user finished event excluded (user isolation)');

    // ============================================================
    // Test 6: Deterministic sorting
    // ============================================================
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i];
      const b = events[i + 1];
      if (a.date === b.date) {
        if (a.type === b.type) {
          assert.ok(a.id < b.id, 'Tie-breaking sorts by id asc');
        } else {
          assert.ok(a.type < b.type, 'Tie-breaking sorts by type asc');
        }
      } else {
        assert.ok(a.date < b.date, 'Sorted by date asc');
      }
    }

    // ============================================================
    // Test 7: Exact YYYY-MM-DD string formatting
    // ============================================================
    for (const e of events) {
      assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, 'Date matches exact YYYY-MM-DD pattern');
    }
  }
);
