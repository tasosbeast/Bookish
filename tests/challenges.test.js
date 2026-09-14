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
  assert.equal(boundsSep.title, 'September 2026 Reading Challenge');
  assert.equal(boundsSep.periodStart.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(boundsSep.periodEnd.toISOString(), '2026-10-01T00:00:00.000Z');

  // Leap year February (2024)
  const boundsFebLeap = getUtcMonthBounds(new Date('2024-02-10T08:00:00.000Z'));
  assert.equal(boundsFebLeap.key, '2024-02');
  assert.equal(boundsFebLeap.title, 'February 2024 Reading Challenge');
  assert.equal(boundsFebLeap.periodStart.toISOString(), '2024-02-01T00:00:00.000Z');
  assert.equal(boundsFebLeap.periodEnd.toISOString(), '2024-03-01T00:00:00.000Z');

  // December to January year transition
  const boundsDec = getUtcMonthBounds(new Date('2025-12-31T23:59:59.999Z'));
  assert.equal(boundsDec.key, '2025-12');
  assert.equal(boundsDec.title, 'December 2025 Reading Challenge');
  assert.equal(boundsDec.periodStart.toISOString(), '2025-12-01T00:00:00.000Z');
  assert.equal(boundsDec.periodEnd.toISOString(), '2026-01-01T00:00:00.000Z');

  // Boundary timestamp: exactly at month start
  const boundsStart = getUtcMonthBounds(new Date('2026-09-01T00:00:00.000Z'));
  assert.equal(boundsStart.key, '2026-09');
  assert.equal(boundsStart.title, 'September 2026 Reading Challenge');
  assert.equal(boundsStart.periodStart.toISOString(), '2026-09-01T00:00:00.000Z');

  // Same calendar month in different years produces distinct titles while keys remain YYYY-MM
  const boundsSep2027 = getUtcMonthBounds(new Date('2027-09-15T15:30:00.000Z'));
  assert.equal(boundsSep2027.key, '2027-09');
  assert.equal(boundsSep2027.title, 'September 2027 Reading Challenge');
  assert.notEqual(boundsSep.title, boundsSep2027.title);
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
    finishedOn: new Date('2026-09-02T00:00:00.000Z'),
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
    finishedOn: new Date('2026-09-05T00:00:00.000Z'),
    createdAt: new Date('2026-09-05T12:00:00Z'),
    book: { id: 'b1', title: 'Book 1', author: 'Author 1', coverImageUrl: null },
  };
  const rRepeat = calculateChallengeProgress([act1, act1Repeat]);
  assert.equal(rRepeat.progress, 1);
  assert.equal(rRepeat.completed, false);
  assert.equal(rRepeat.completedAt, null);
  assert.equal(rRepeat.books.length, 1);
  assert.equal(rRepeat.books[0].finishedAt, '2026-09-02T00:00:00.000Z');

  // 4. Three distinct books completes challenge and records 3rd book timestamp as completedAt
  const act2 = {
    bookId: 'b2',
    finishedOn: new Date('2026-09-04T00:00:00.000Z'),
    createdAt: new Date('2026-09-04T10:00:00Z'),
    book: { id: 'b2', title: 'Book 2', author: 'Author 2', coverImageUrl: null },
  };
  const act3 = {
    bookId: 'b3',
    finishedOn: new Date('2026-09-10T00:00:00.000Z'),
    createdAt: new Date('2026-09-10T14:00:00Z'),
    book: { id: 'b3', title: 'Book 3', author: 'Author 3', coverImageUrl: null },
  };
  const r3 = calculateChallengeProgress([act1, act2, act3]);
  assert.equal(r3.progress, 3);
  assert.equal(r3.completed, true);
  assert.equal(r3.completedAt, '2026-09-10T00:00:00.000Z');
  // Displayed books sorted newest first
  assert.equal(r3.books[0].id, 'b3');
  assert.equal(r3.books[1].id, 'b2');
  assert.equal(r3.books[2].id, 'b1');

  // 5. Four/five books: progress continues past goal, but completedAt remains 3rd book timestamp
  const act4 = {
    bookId: 'b4',
    finishedOn: new Date('2026-09-15T00:00:00.000Z'),
    createdAt: new Date('2026-09-15T18:00:00Z'),
    book: { id: 'b4', title: 'Book 4', author: 'Author 4', coverImageUrl: null },
  };
  const act5 = {
    bookId: 'b5',
    finishedOn: new Date('2026-09-20T00:00:00.000Z'),
    createdAt: new Date('2026-09-20T20:00:00Z'),
    book: { id: 'b5', title: 'Book 5', author: 'Author 5', coverImageUrl: null },
  };
  const r5 = calculateChallengeProgress([act1, act2, act3, act4, act5]);
  assert.equal(r5.progress, 5);
  assert.equal(r5.completed, true);
  assert.equal(r5.completedAt, '2026-09-10T00:00:00.000Z');
  assert.equal(r5.books.length, 5);
  assert.equal(r5.books[0].id, 'b5');
  assert.equal(r5.books[4].id, 'b1');

  // 6. Activity with finishedOn: null does NOT count toward challenge progress
  const actNoFinishedOn = {
    bookId: 'b-no-finish',
    finishedOn: null,
    createdAt: new Date('2026-09-02T10:00:00Z'),
    book: { id: 'b-no-finish', title: 'No finish' },
  };
  const rNoFinish = calculateChallengeProgress([actNoFinishedOn]);
  assert.equal(rNoFinish.progress, 0);
  assert.equal(rNoFinish.completed, false);
  assert.equal(rNoFinish.completedAt, null);
  assert.deepEqual(rNoFinish.books, []);
});

test('Challenges unit: deriveTrophies groups by month, requires >= 3 distinct books, and sorts newest first', () => {
  // Empty activities -> no trophies
  assert.deepEqual(deriveTrophies([]), []);

  // Month with only 2 distinct books -> no trophy
  const month1Activities = [
    { bookId: 'b1', finishedOn: new Date('2026-07-02T00:00:00Z'), createdAt: new Date('2026-07-02T10:00:00Z') },
    { bookId: 'b2', finishedOn: new Date('2026-07-15T00:00:00Z'), createdAt: new Date('2026-07-15T10:00:00Z') },
    { bookId: 'b2', finishedOn: new Date('2026-07-20T00:00:00Z'), createdAt: new Date('2026-07-20T10:00:00Z') }, // repeat of b2
  ];
  assert.deepEqual(deriveTrophies(month1Activities), []);

  // Multiple months: July (2 books - no trophy), August (3 books - 1 trophy), September (4 books - 1 trophy)
  const augustActivities = [
    { bookId: 'b1', finishedOn: new Date('2026-08-01T00:00:00Z'), createdAt: new Date('2026-08-01T10:00:00Z') },
    { bookId: 'b2', finishedOn: new Date('2026-08-10T00:00:00Z'), createdAt: new Date('2026-08-10T10:00:00Z') },
    { bookId: 'b3', finishedOn: new Date('2026-08-25T00:00:00Z'), createdAt: new Date('2026-08-25T15:30:00Z') },
  ];
  const septemberActivities = [
    { bookId: 'b1', finishedOn: new Date('2026-09-02T00:00:00Z'), createdAt: new Date('2026-09-02T10:00:00Z') }, // Same book in later month counts!
    { bookId: 'b4', finishedOn: new Date('2026-09-05T00:00:00Z'), createdAt: new Date('2026-09-05T10:00:00Z') },
    { bookId: 'b5', finishedOn: new Date('2026-09-12T00:00:00Z'), createdAt: new Date('2026-09-12T12:00:00Z') },
    { bookId: 'b6', finishedOn: new Date('2026-09-22T00:00:00Z'), createdAt: new Date('2026-09-22T16:00:00Z') },
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
  assert.equal(trophies[0].title, 'September 2026 Reading Challenge');
  assert.equal(trophies[0].goal, 3);
  assert.equal(trophies[0].booksRead, 4); // includes books beyond 3
  assert.equal(trophies[0].completedAt, '2026-09-12T00:00:00.000Z'); // 3rd distinct book timestamp

  assert.equal(trophies[1].key, '2026-08');
  assert.equal(trophies[1].title, 'August 2026 Reading Challenge');
  assert.equal(trophies[1].goal, 3);
  assert.equal(trophies[1].booksRead, 3);
  assert.equal(trophies[1].completedAt, '2026-08-25T00:00:00.000Z');

  // Multi-year: same calendar month in different years produces distinct titles with keys YYYY-MM
  const multiYearActivities = [
    { bookId: 'b1', finishedOn: new Date('2026-09-02T00:00:00Z'), createdAt: new Date('2026-09-02T10:00:00Z') },
    { bookId: 'b2', finishedOn: new Date('2026-09-05T00:00:00Z'), createdAt: new Date('2026-09-05T10:00:00Z') },
    { bookId: 'b3', finishedOn: new Date('2026-09-12T00:00:00Z'), createdAt: new Date('2026-09-12T12:00:00Z') },
    { bookId: 'b1', finishedOn: new Date('2027-09-03T00:00:00Z'), createdAt: new Date('2027-09-03T10:00:00Z') },
    { bookId: 'b2', finishedOn: new Date('2027-09-06T00:00:00Z'), createdAt: new Date('2027-09-06T10:00:00Z') },
    { bookId: 'b3', finishedOn: new Date('2027-09-15T00:00:00Z'), createdAt: new Date('2027-09-15T12:00:00Z') },
  ];
  const multiYearTrophies = deriveTrophies(multiYearActivities);
  assert.equal(multiYearTrophies.length, 2);
  assert.equal(multiYearTrophies[0].key, '2027-09');
  assert.equal(multiYearTrophies[0].title, 'September 2027 Reading Challenge');
  assert.equal(multiYearTrophies[1].key, '2026-09');
  assert.equal(multiYearTrophies[1].title, 'September 2026 Reading Challenge');
  assert.notEqual(multiYearTrophies[0].title, multiYearTrophies[1].title);

  // Activity with finishedOn: null does NOT count toward trophies
  const trophyNoFinish = deriveTrophies([
    { bookId: 'b1', finishedOn: null, createdAt: new Date('2026-08-01T10:00:00Z') },
    { bookId: 'b2', finishedOn: null, createdAt: new Date('2026-08-10T10:00:00Z') },
    { bookId: 'b3', finishedOn: null, createdAt: new Date('2026-08-25T15:30:00Z') },
  ]);
  assert.deepEqual(trophyNoFinish, []);
});

test('Challenges unit: finishedOn drives challenge progress, month grouping, and UTC midnight completedAt', () => {
  // Case 15: activity created in September but finishedOn in August belongs to August
  const actAugFinished = {
    id: 'act-1',
    bookId: 'b1',
    finishedOn: '2026-08-29',
    createdAt: new Date('2026-09-14T18:00:00Z'),
  };
  const trophiesAug = deriveTrophies([actAugFinished], 1);
  assert.equal(trophiesAug.length, 1);
  assert.equal(trophiesAug[0].key, '2026-08');

  // Case 17: same book twice in same finishedOn month counts once
  const actSepRepeat1 = { id: 'act-2', bookId: 'b1', finishedOn: '2026-09-05', createdAt: new Date('2026-09-05T10:00:00Z') };
  const actSepRepeat2 = { id: 'act-3', bookId: 'b1', finishedOn: '2026-09-15', createdAt: new Date('2026-09-15T10:00:00Z') };
  const progRepeat = calculateChallengeProgress([actSepRepeat1, actSepRepeat2]);
  assert.equal(progRepeat.progress, 1);
  assert.equal(progRepeat.books.length, 1);

  // Case 18: same book in different finishedOn months counts in both
  const actSep1 = { id: 'act-4', bookId: 'b1', finishedOn: '2026-09-02', createdAt: new Date('2026-09-02T10:00:00Z') };
  const actSep2 = { id: 'act-5', bookId: 'b2', finishedOn: '2026-09-10', createdAt: new Date('2026-09-10T10:00:00Z') };
  const actSep3 = { id: 'act-6', bookId: 'b3', finishedOn: '2026-09-18', createdAt: new Date('2026-09-18T10:00:00Z') };
  const actOct1 = { id: 'act-7', bookId: 'b1', finishedOn: '2026-10-05', createdAt: new Date('2026-10-05T10:00:00Z') };
  const actOct2 = { id: 'act-8', bookId: 'b4', finishedOn: '2026-10-10', createdAt: new Date('2026-10-10T10:00:00Z') };
  const actOct3 = { id: 'act-9', bookId: 'b5', finishedOn: '2026-10-15', createdAt: new Date('2026-10-15T10:00:00Z') };

  const trophiesMulti = deriveTrophies([actSep1, actSep2, actSep3, actOct1, actOct2, actOct3]);
  assert.equal(trophiesMulti.length, 2);
  assert.equal(trophiesMulti[0].key, '2026-10');
  assert.equal(trophiesMulti[1].key, '2026-09');

  // Case 20: completedAt is third distinct finish date at UTC midnight
  const progCompleted = calculateChallengeProgress([actSep1, actSep2, actSep3]);
  assert.equal(progCompleted.completed, true);
  assert.equal(progCompleted.completedAt, '2026-09-18T00:00:00.000Z');

  // Deterministic tie breaking when multiple books have identical finishedOn
  const tieAct1 = { id: 'act-c', bookId: 'b1', finishedOn: '2026-09-18', createdAt: new Date('2026-09-18T12:00:00Z') };
  const tieAct2 = { id: 'act-a', bookId: 'b2', finishedOn: '2026-09-18', createdAt: new Date('2026-09-18T08:00:00Z') };
  const tieAct3 = { id: 'act-b', bookId: 'b3', finishedOn: '2026-09-18', createdAt: new Date('2026-09-18T08:00:00Z') };
  // Expected order: tieAct2 (createdAt 08:00, id act-a), tieAct3 (createdAt 08:00, id act-b), tieAct1 (createdAt 12:00)
  // 3rd qualifying distinct book is tieAct1, completedAt is '2026-09-18T00:00:00.000Z'
  const progTies = calculateChallengeProgress([tieAct1, tieAct2, tieAct3]);
  assert.equal(progTies.completed, true);
  assert.equal(progTies.completedAt, '2026-09-18T00:00:00.000Z');
  assert.equal(progTies.books[0].id, 'b1'); // newest first
  assert.equal(progTies.books[1].id, 'b3');
  assert.equal(progTies.books[2].id, 'b2');
});
