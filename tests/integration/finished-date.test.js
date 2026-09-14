import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { signTokens, digest } from '../../src/services/tokens.js';
import { saveShelf, removeShelf } from '../../src/services/ratings.js';
import { getCurrentChallenge, getUserTrophies } from '../../src/services/challenges.js';
import { listFeed } from '../../src/services/feed.js';
import { personalBook } from '../../src/services/user-books.js';
import { maxAllowedFinishedOn } from '../../src/validators/index.js';

test('PostgreSQL: Editable Date finished support for books marked Read',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const userIds = [];
    const bookIds = [];

    t.after(async () => {
      if (userIds.length) {
        await prisma.friendship.deleteMany({ where: { OR: [{ userAId: { in: userIds } }, { userBId: { in: userIds } }] } });
        await prisma.activity.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.review.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.userBook.deleteMany({ where: { userId: { in: userIds } } });
        await prisma.refreshSession.deleteMany({ where: { userId: { in: userIds } } });
      }
      if (bookIds.length) {
        await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
      }
      if (userIds.length) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.$disconnect();
    });

    const signup = async suffix => {
      const user = await prisma.user.create({
        data: {
          username: `fd${tag}${suffix}`,
          email: `fd${tag}${suffix}@example.com`,
          passwordHash: 'fixture-password',
        },
      });
      userIds.push(user.id);
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 86400000);
      const { accessToken } = signTokens(user.id, sessionId, expiresAt);
      await prisma.refreshSession.create({
        data: { id: sessionId, userId: user.id, expiresAt, tokenHash: digest(`dummy-${sessionId}`) },
      });
      return { token: accessToken, userId: user.id, username: user.username };
    };

    const createBook = async title => {
      const book = await prisma.book.create({
        data: {
          title: `${title} ${tag}`,
          author: `Author ${tag}`,
          isbn: `${Math.floor(1000000000000 + Math.random() * 9000000000000)}`.slice(0, 13),
        },
      });
      bookIds.push(book.id);
      return book;
    };

    const auth = (reader, method, path) => request(app)[method](path).auth(reader.token, { type: 'bearer' });

    const [userA, userB] = await Promise.all(['a', 'b'].map(signup));
    const [book1, book2, book3, book4, book5, book6] = await Promise.all(
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map(createBook)
    );

    const todayUtc = new Date().toISOString().slice(0, 10);

    // 1. read transition without finishedOn defaults to current date
    await saveShelf(userA.userId, { bookId: book1.id, status: 'read' });
    const act1 = await prisma.activity.findFirst({
      where: { userId: userA.userId, bookId: book1.id, type: 'finished_reading' },
    });
    assert.ok(act1, 'Activity created');
    assert.equal(act1.finishedOn.toISOString().slice(0, 10), todayUtc, 'Defaults to current UTC date');

    // 2. read transition with explicit finishedOn stores it
    await saveShelf(userA.userId, { bookId: book2.id, status: 'read', finishedOn: '2026-09-05' });
    const act2 = await prisma.activity.findFirst({
      where: { userId: userA.userId, bookId: book2.id, type: 'finished_reading' },
    });
    assert.ok(act2);
    assert.equal(act2.finishedOn.toISOString().slice(0, 10), '2026-09-05');

    // 3. future finishedOn rejected
    const nextYear = new Date().getUTCFullYear() + 1;
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book3.id, status: 'read', finishedOn: `${nextYear}-01-01` })
      .expect(400);

    // 4. invalid calendar date rejected
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book3.id, status: 'read', finishedOn: '2026-02-30' })
      .expect(400);
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book3.id, status: 'read', finishedOn: '2026-09-05T12:00:00Z' })
      .expect(400);

    // 5. non-read status + finishedOn rejected
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book3.id, status: 'currently_reading', finishedOn: '2026-09-05' })
      .expect(400);
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book3.id, status: 'want_to_read', finishedOn: '2026-09-05' })
      .expect(400);
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book3.id, finishedOn: '2026-09-05' }) // book3 has no status (not read)
      .expect(400);

    // 6. editing finishedOn while already Read updates existing activity
    // 7. edit creates no second finished_reading activity
    // 8. edit does not alter Activity.createdAt
    const act1CreatedAtBefore = act1.createdAt;
    await saveShelf(userA.userId, { bookId: book1.id, finishedOn: '2026-09-01' });
    const actsBook1 = await prisma.activity.findMany({
      where: { userId: userA.userId, bookId: book1.id, type: 'finished_reading' },
    });
    assert.equal(actsBook1.length, 1, 'No second finished_reading activity created');
    assert.equal(actsBook1[0].finishedOn.toISOString().slice(0, 10), '2026-09-01', 'finishedOn updated');
    assert.equal(actsBook1[0].createdAt.toISOString(), act1CreatedAtBefore.toISOString(), 'createdAt unchanged');

    // 9. edit creates no additional Feed activity
    const totalActsUserA = await prisma.activity.count({ where: { userId: userA.userId } });
    await saveShelf(userA.userId, { bookId: book1.id, finishedOn: '2026-09-03' });
    const totalActsUserAAfter = await prisma.activity.count({ where: { userId: userA.userId } });
    assert.equal(totalActsUserA, totalActsUserAAfter, 'Total activities unchanged by editing finish date');

    // 10. reread creates a second completion event
    // 11. editing current reread updates only latest completion
    await saveShelf(userA.userId, { bookId: book1.id, status: 'currently_reading' });
    await saveShelf(userA.userId, { bookId: book1.id, status: 'read', finishedOn: '2026-09-10' });
    const actsReread = await prisma.activity.findMany({
      where: { userId: userA.userId, bookId: book1.id, type: 'finished_reading' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    assert.equal(actsReread.length, 2, 'Two finished_reading events for reread');
    const firstCompletionId = actsReread[0].id;
    const secondCompletionId = actsReread[1].id;

    // Edit finish date of current reread
    await saveShelf(userA.userId, { bookId: book1.id, finishedOn: '2026-09-09' });
    const actFirstReloaded = await prisma.activity.findUnique({ where: { id: firstCompletionId } });
    const actSecondReloaded = await prisma.activity.findUnique({ where: { id: secondCompletionId } });
    assert.equal(actFirstReloaded.finishedOn.toISOString().slice(0, 10), '2026-09-03', 'Older completion untouched');
    assert.equal(actSecondReloaded.finishedOn.toISOString().slice(0, 10), '2026-09-09', 'Latest completion updated');

    // 12. personal book response returns finishedOn
    const pBookRes = await auth(userA, 'get', `/api/user-books/${book1.id}`).expect(200);
    assert.equal(pBookRes.body.data.shelf.status, 'read');
    assert.equal(pBookRes.body.data.shelf.finishedOn, '2026-09-09');

    // 13. existing migrated finished_reading activities receive date from createdAt
    // 14. non-finished activities keep finishedOn null
    const pastTimestamp = new Date('2026-05-15T14:30:00.000Z');
    const directFinishedAct = await prisma.activity.create({
      data: {
        userId: userA.userId,
        bookId: book4.id,
        type: 'finished_reading',
        createdAt: pastTimestamp,
        finishedOn: new Date('2026-05-15T00:00:00.000Z'), // simulates migration backfill DATE(created_at)
      },
    });
    const startedAct = await prisma.activity.findFirst({
      where: { userId: userA.userId, bookId: book1.id, type: 'started_reading' },
    });
    assert.ok(startedAct);
    assert.equal(startedAct.finishedOn, null, 'Non-finished activities keep finishedOn null');

    // Challenges tests:
    // 15. activity created in September but finishedOn in August counts in August
    await saveShelf(userB.userId, { bookId: book1.id, status: 'read', finishedOn: '2026-08-25' });
    const userBChallengeAug = await getCurrentChallenge(userB.userId, new Date('2026-08-28T00:00:00.000Z'));
    assert.equal(userBChallengeAug.data.progress, 1, 'Book finishedOn August counts in August');
    const userBChallengeSep = await getCurrentChallenge(userB.userId, new Date('2026-09-14T00:00:00.000Z'));
    assert.equal(userBChallengeSep.data.progress, 0, 'Book finishedOn August does not count in September');

    // 16. changing finishedOn across months moves challenge membership
    await saveShelf(userB.userId, { bookId: book1.id, finishedOn: '2026-09-05' });
    const userBChallengeAugAfter = await getCurrentChallenge(userB.userId, new Date('2026-08-28T00:00:00.000Z'));
    const userBChallengeSepAfter = await getCurrentChallenge(userB.userId, new Date('2026-09-14T00:00:00.000Z'));
    assert.equal(userBChallengeAugAfter.data.progress, 0, 'No longer in August');
    assert.equal(userBChallengeSepAfter.data.progress, 1, 'Moved to September');

    // 17. same book twice in same finishedOn month counts once
    // UserB reads book1 again in September
    await saveShelf(userB.userId, { bookId: book1.id, status: 'currently_reading' });
    await saveShelf(userB.userId, { bookId: book1.id, status: 'read', finishedOn: '2026-09-20' });
    const userBChallengeSepRepeat = await getCurrentChallenge(userB.userId, new Date('2026-09-14T00:00:00.000Z'));
    assert.equal(userBChallengeSepRepeat.data.progress, 1, 'Same book finished twice in same month counts once');

    // 18. same book in different finishedOn months may count in both
    await saveShelf(userB.userId, { bookId: book1.id, status: 'currently_reading' });
    await saveShelf(userB.userId, { bookId: book1.id, status: 'read', finishedOn: '2026-10-05' });
    const userBChallengeOct = await getCurrentChallenge(userB.userId, new Date('2026-10-10T00:00:00.000Z'));
    assert.equal(userBChallengeOct.data.progress, 1, 'Same book counts in October challenge as well');

    // 19. trophy grouping uses finishedOn year/month
    // 20. completedAt is third distinct finish date at UTC midnight
    await saveShelf(userB.userId, { bookId: book2.id, status: 'read', finishedOn: '2026-09-10' });
    await saveShelf(userB.userId, { bookId: book3.id, status: 'read', finishedOn: '2026-09-18' });
    const trophiesUserB = await getUserTrophies(userB.userId);
    const sepTrophy = trophiesUserB.data.find(t => t.key === '2026-09');
    assert.ok(sepTrophy, 'September trophy earned based on finishedOn grouping');
    assert.equal(sepTrophy.completedAt, '2026-09-18T00:00:00.000Z', 'completedAt is 3rd distinct finish date at UTC midnight');

    // 21. Feed friendship cutoff still uses createdAt, not finishedOn
    // Alice and Bob become friends at Sep 10
    const friendshipAcceptedAt = new Date('2026-09-10T00:00:00.000Z');
    await prisma.friendship.create({
      data: {
        userAId: userA.userId,
        userBId: userB.userId,
        requestedById: userA.userId,
        status: 'accepted',
        acceptedAt: friendshipAcceptedAt,
      },
    });

    // Bob finished book5 with backdated finishedOn = August 20, but createdAt = now (after friendship acceptedAt)
    await saveShelf(userB.userId, { bookId: book5.id, status: 'read', finishedOn: '2026-08-20' });
    const feedForAlice = await listFeed(userA.userId);
    const bobBook5Activity = feedForAlice.data.find(item => item.book.id === book5.id);
    assert.ok(bobBook5Activity, 'Feed shows activity created after friendship even with backdated finishedOn');

    // If an activity was created before friendship acceptedAt, it is excluded from Feed regardless of finishedOn
    const oldCreatedActivity = await prisma.activity.create({
      data: {
        userId: userB.userId,
        bookId: book6.id,
        type: 'finished_reading',
        createdAt: new Date('2026-09-01T00:00:00.000Z'), // before friendship
        finishedOn: new Date('2026-09-12T00:00:00.000Z'), // even if finishedOn is after friendship!
      },
    });
    const feedForAlice2 = await listFeed(userA.userId);
    const excludedActivity = feedForAlice2.data.find(item => item.book.id === book6.id);
    assert.equal(excludedActivity, undefined, 'Activity created before friendship is excluded even if finishedOn is after');

    // 22. Legacy Read book with no completion activity can set finishedOn without appearing in Feed
    const book7 = await createBook('B7');
    // Simulate legacy book marked Read before activity tracking existed
    await prisma.userBook.create({
      data: {
        userId: userB.userId,
        bookId: book7.id,
        status: 'read',
      },
    });
    // Bob sets finishedOn on this legacy read book
    await saveShelf(userB.userId, { bookId: book7.id, finishedOn: '2026-05-10' });

    // Personal book response returns the finish date
    const bobBook7Personal = await personalBook(userB.userId, book7.id);
    assert.equal(bobBook7Personal.data.shelf.finishedOn, '2026-05-10');

    // DB record has historical = true
    const legacyAct = await prisma.activity.findFirst({
      where: { userId: userB.userId, bookId: book7.id, type: 'finished_reading' },
    });
    assert.ok(legacyAct, 'Historical activity created for legacy read');
    assert.equal(legacyAct.historical, true, 'Marked as historical activity');
    assert.equal(legacyAct.finishedOn.toISOString().slice(0, 10), '2026-05-10');

    // Alice's feed does NOT show this historical completion
    const feedForAlice3 = await listFeed(userA.userId);
    const legacyInFeed = feedForAlice3.data.find(item => item.book.id === book7.id);
    assert.equal(legacyInFeed, undefined, 'Legacy read finish date does NOT appear in Friends Feed');

    // 23. Subsequent date edit updates the same historical completion without creating new records
    await saveShelf(userB.userId, { bookId: book7.id, finishedOn: '2026-05-12' });
    const legacyActsAfterEdit = await prisma.activity.findMany({
      where: { userId: userB.userId, bookId: book7.id, type: 'finished_reading' },
    });
    assert.equal(legacyActsAfterEdit.length, 1, 'Only one completion record exists after edit');
    assert.equal(legacyActsAfterEdit[0].finishedOn.toISOString().slice(0, 10), '2026-05-12');
    assert.equal(legacyActsAfterEdit[0].historical, true);

    const feedForAlice4 = await listFeed(userA.userId);
    assert.equal(feedForAlice4.data.find(item => item.book.id === book7.id), undefined, 'Still not in Feed after edit');

    // 24. Later genuine reread (read -> currently_reading -> read) DOES appear in Feed
    await saveShelf(userB.userId, { bookId: book7.id, status: 'currently_reading' });
    await saveShelf(userB.userId, { bookId: book7.id, status: 'read', finishedOn: '2026-09-22' });

    const bobBook7Acts = await prisma.activity.findMany({
      where: { userId: userB.userId, bookId: book7.id, type: 'finished_reading' },
      orderBy: [{ createdAt: 'asc' }],
    });
    assert.equal(bobBook7Acts.length, 2, 'Two completion activities exist after genuine reread');
    assert.equal(bobBook7Acts[0].historical, true, 'First legacy activity remains historical');
    assert.equal(bobBook7Acts[1].historical, false, 'Genuine reread activity is NOT historical');

    const feedForAlice5 = await listFeed(userA.userId);
    const rereadInFeed = feedForAlice5.data.find(item => item.book.id === book7.id);
    assert.ok(rereadInFeed, 'Genuine reread DOES appear in Friends Feed');

    // 25. Midnight/local-vs-UTC edge in API accepts up to tomorrow UTC, rejects 2 days ahead
    const book8 = await createBook('B8');
    const validTomorrow = maxAllowedFinishedOn();
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book8.id, status: 'read', finishedOn: validTomorrow })
      .expect(200);

    const book9 = await createBook('B9');
    const nowUtc = new Date();
    const invalidFuture = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() + 2))
      .toISOString().slice(0, 10);
    await auth(userA, 'post', '/api/user-books')
      .send({ bookId: book9.id, status: 'read', finishedOn: invalidFuture })
      .expect(400);

    // 26. PostgreSQL UTC backfill semantics: DATE(created_at AT TIME ZONE 'UTC') vs session timezone
    const actForTz = await prisma.activity.create({
      data: {
        userId: userA.userId,
        bookId: book1.id,
        type: 'finished_reading',
        createdAt: new Date('2026-09-14T23:30:00.000Z'),
      },
    });
    // Setting PostgreSQL session timezone to Asia/Tokyo (+09:00):
    // 23:30 UTC on Sep 14 is 08:30 on Sep 15 in Tokyo.
    // Plain DATE(created_at) evaluates to 2026-09-15.
    // Explicit (created_at AT TIME ZONE 'UTC')::DATE evaluates to 2026-09-14.
    await prisma.$executeRawUnsafe("SET timezone = 'Asia/Tokyo'");
    const [tzRow] = await prisma.$queryRawUnsafe(`
      SELECT
        (created_at AT TIME ZONE 'UTC')::DATE::text as utc_date,
        DATE(created_at)::text as session_local_date
      FROM activities
      WHERE id = '${actForTz.id}'::uuid
    `);
    await prisma.$executeRawUnsafe("SET timezone = 'UTC'");
    assert.equal(tzRow.utc_date, '2026-09-14', 'Explicit UTC conversion produces UTC date');
    assert.equal(tzRow.session_local_date, '2026-09-15', 'Plain DATE uses session timezone');
  }
);

