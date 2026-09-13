import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getUtcMonthBounds,
  calculateChallengeProgress,
  deriveTrophies,
  CHALLENGE_GOAL,
} from '../src/services/challenges.js';

test('Challenges unit: getUtcMonthBounds computes exact UTC boundaries and keys', () => {
  // September 2026
  const boundsSep = getUtcMonthBounds(new Date('2026-09-15T15:30:00.000Z'));
  assert.equal(boundsSep.year, 2026);
  assert.equal(boundsSep.month, 8); // 0-indexed
  assert.equal(boundsSep.key, '2026-09');
  assert.equal(boundsSep.title, 'September Reading Challenge');
  assert.equal(boundsSep.periodStart.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(boundsSep.periodEnd.toISOString(), '2026-10-01T00:00:00.000Z');

  // Leap year February (2024)
  const boundsFebLeap = getUtcMonthBounds(new Date('2024-02-10T08:00:00.000Z'));
  assert.equal(boundsFebLeap.key, '2024-02');
  assert.equal(boundsFebLeap.title, 'February Reading Challenge');
  assert.equal(boundsFebLeap.periodStart.toISOString(), '2024-02-01T00:00:00.000Z');
  assert.equal(boundsFebLeap.periodEnd.toISOString(), '2024-03-01T00:00:00.000Z');

  // December to January year transition
  const boundsDec = getUtcMonthBounds(new Date('2025-12-31T23:59:59.999Z'));
  assert.equal(boundsDec.key, '2025-12');
  assert.equal(boundsDec.title, 'December Reading Challenge');
  assert.equal(boundsDec.periodStart.toISOString(), '2025-12-01T00:00:00.000Z');
  assert.equal(boundsDec.periodEnd.toISOString(), '2026-01-01T00:00:00.000Z');

  // Boundary timestamp: exactly at month start
  const boundsStart = getUtcMonthBounds(new Date('2026-09-01T00:00:00.000Z'));
  assert.equal(boundsStart.key, '2026-09');
  assert.equal(boundsStart.periodStart.toISOString(), '2026-09-01T00:00:00.000Z');
});

test('Challenges unit: calculateChallengeProgress handles distinct books, duplicates, and completion', () => {
  // 1. Zero books
  const r0 = calculateChallengeProgress([]);
  assert.equal(r0.progress, 0);
  assert.equal(r0.completed, false);
  assert.equal(r0.completedAt, null);
  assert.deepEqual(r0.books, []);

  // 2. One distinct book
  const act1 = {
    bookId: 'b1',
    createdAt: new Date('2026-09-02T10:00:00Z'),
    book: { id: 'b1', title: 'Book 1', author: 'Author 1', coverImageUrl: null },
  };
  const r1 = calculateChallengeProgress([act1]);
  assert.equal(r1.progress, 1);
  assert.equal(r1.completed, false);
  assert.equal(r1.completedAt, null);
  assert.equal(r1.books.length, 1);
  assert.equal(r1.books[0].id, 'b1');

  // 3. Same book finished twice in same month counts only once
  const act1Repeat = {
    bookId: 'b1',
    createdAt: new Date('2026-09-05T12:00:00Z'),
    book: { id: 'b1', title: 'Book 1', author: 'Author 1', coverImageUrl: null },
  };
  const rRepeat = calculateChallengeProgress([act1, act1Repeat]);
  assert.equal(rRepeat.progress, 1);
  assert.equal(rRepeat.completed, false);
  assert.equal(rRepeat.completedAt, null);
  assert.equal(rRepeat.books.length, 1);
  assert.equal(rRepeat.books[0].finishedAt, act1.createdAt.toISOString());

  // 4. Three distinct books completes challenge and records 3rd book timestamp as completedAt
  const act2 = {
    bookId: 'b2',
    createdAt: new Date('2026-09-04T10:00:00Z'),
    book: { id: 'b2', title: 'Book 2', author: 'Author 2', coverImageUrl: null },
  };
  const act3 = {
    bookId: 'b3',
    createdAt: new Date('2026-09-10T14:00:00Z'),
    book: { id: 'b3', title: 'Book 3', author: 'Author 3', coverImageUrl: null },
  };
  const r3 = calculateChallengeProgress([act1, act2, act3]);
  assert.equal(r3.progress, 3);
  assert.equal(r3.completed, true);
  assert.equal(r3.completedAt, act3.createdAt.toISOString());
  // Displayed books sorted newest first
  assert.equal(r3.books[0].id, 'b3');
  assert.equal(r3.books[1].id, 'b2');
  assert.equal(r3.books[2].id, 'b1');

  // 5. Four/five books: progress continues past goal, but completedAt remains 3rd book timestamp
  const act4 = {
    bookId: 'b4',
    createdAt: new Date('2026-09-15T18:00:00Z'),
    book: { id: 'b4', title: 'Book 4', author: 'Author 4', coverImageUrl: null },
  };
  const act5 = {
    bookId: 'b5',
    createdAt: new Date('2026-09-20T20:00:00Z'),
    book: { id: 'b5', title: 'Book 5', author: 'Author 5', coverImageUrl: null },
  };
  const r5 = calculateChallengeProgress([act1, act2, act3, act4, act5]);
  assert.equal(r5.progress, 5);
  assert.equal(r5.completed, true);
  assert.equal(r5.completedAt, act3.createdAt.toISOString());
  assert.equal(r5.books.length, 5);
  assert.equal(r5.books[0].id, 'b5');
  assert.equal(r5.books[4].id, 'b1');
});

test('Challenges unit: deriveTrophies groups by month, requires >= 3 distinct books, and sorts newest first', () => {
  // Empty activities -> no trophies
  assert.deepEqual(deriveTrophies([]), []);

  // Month with only 2 distinct books -> no trophy
  const month1Activities = [
    { bookId: 'b1', createdAt: new Date('2026-07-02T10:00:00Z') },
    { bookId: 'b2', createdAt: new Date('2026-07-15T10:00:00Z') },
    { bookId: 'b2', createdAt: new Date('2026-07-20T10:00:00Z') }, // repeat of b2
  ];
  assert.deepEqual(deriveTrophies(month1Activities), []);

  // Multiple months: July (2 books - no trophy), August (3 books - 1 trophy), September (4 books - 1 trophy)
  const augustActivities = [
    { bookId: 'b1', createdAt: new Date('2026-08-01T10:00:00Z') },
    { bookId: 'b2', createdAt: new Date('2026-08-10T10:00:00Z') },
    { bookId: 'b3', createdAt: new Date('2026-08-25T15:30:00Z') },
  ];
  const septemberActivities = [
    { bookId: 'b1', createdAt: new Date('2026-09-02T10:00:00Z') }, // Same book in later month counts!
    { bookId: 'b4', createdAt: new Date('2026-09-05T10:00:00Z') },
    { bookId: 'b5', createdAt: new Date('2026-09-12T12:00:00Z') },
    { bookId: 'b6', createdAt: new Date('2026-09-22T16:00:00Z') },
  ];

  const allActivities = [
    ...month1Activities,
    ...augustActivities,
    ...septemberActivities,
  ];

  const trophies = deriveTrophies(allActivities);
  assert.equal(trophies.length, 2);

  // Newest month first: September before August
  assert.equal(trophies[0].key, '2026-09');
  assert.equal(trophies[0].title, 'September Reading Challenge');
  assert.equal(trophies[0].goal, 3);
  assert.equal(trophies[0].booksRead, 4); // includes books beyond 3
  assert.equal(trophies[0].completedAt, '2026-09-12T12:00:00.000Z'); // 3rd distinct book timestamp

  assert.equal(trophies[1].key, '2026-08');
  assert.equal(trophies[1].title, 'August Reading Challenge');
  assert.equal(trophies[1].goal, 3);
  assert.equal(trophies[1].booksRead, 3);
  assert.equal(trophies[1].completedAt, '2026-08-25T15:30:00.000Z');
});
