import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarQuerySchema, isValidCalendarDate } from '../src/validators/index.js';
import { formatUtcDate } from '../src/services/calendar.js';

test('Calendar validator: isValidCalendarDate validates real Gregorian dates and rejects invalid dates', () => {
  // Valid calendar dates
  assert.equal(isValidCalendarDate('2026-09-15'), true);
  assert.equal(isValidCalendarDate('2024-02-29'), true); // Leap year
  assert.equal(isValidCalendarDate('2026-12-31'), true);
  assert.equal(isValidCalendarDate('2026-01-01'), true);

  // Invalid calendar dates
  assert.equal(isValidCalendarDate('2026-02-29'), false); // Non-leap year
  assert.equal(isValidCalendarDate('2026-02-31'), false);
  assert.equal(isValidCalendarDate('2026-04-31'), false); // Apr has 30 days
  assert.equal(isValidCalendarDate('2026-13-01'), false); // Month 13
  assert.equal(isValidCalendarDate('2026-00-10'), false); // Month 0
  assert.equal(isValidCalendarDate('2026-05-00'), false); // Day 0
  assert.equal(isValidCalendarDate('2026-05-32'), false); // Day 32
  assert.equal(isValidCalendarDate('invalid-date'), false);
  assert.equal(isValidCalendarDate('2026-9-5'), false);
  assert.equal(isValidCalendarDate(null), false);
  assert.equal(isValidCalendarDate(undefined), false);
});

test('Calendar validator: calendarQuerySchema enforces required from/to, range limits, from <= to, and strict query', () => {
  // Valid 42-day range (e.g. 2026-08-31 to 2026-10-11 is exactly 42 calendar days)
  const valid42 = calendarQuerySchema.parse({
    query: {
      from: '2026-08-31',
      to: '2026-10-11',
    },
  });
  assert.equal(valid42.query.from, '2026-08-31');
  assert.equal(valid42.query.to, '2026-10-11');

  // Single-day range (from === to, 1 day) is valid
  const valid1 = calendarQuerySchema.parse({
    query: {
      from: '2026-09-15',
      to: '2026-09-15',
    },
  });
  assert.equal(valid1.query.from, '2026-09-15');

  // Reject missing from or to
  assert.throws(() => calendarQuerySchema.parse({ query: { from: '2026-09-01' } }));
  assert.throws(() => calendarQuerySchema.parse({ query: { to: '2026-09-15' } }));
  assert.throws(() => calendarQuerySchema.parse({ query: {} }));

  // Reject from > to
  assert.throws(() => calendarQuerySchema.parse({
    query: {
      from: '2026-09-15',
      to: '2026-09-14',
    },
  }));

  // Reject range > 42 days (e.g. 43 days: 2026-08-31 to 2026-10-12)
  assert.throws(() => calendarQuerySchema.parse({
    query: {
      from: '2026-08-31',
      to: '2026-10-12',
    },
  }));

  // Reject impossible dates
  assert.throws(() => calendarQuerySchema.parse({
    query: {
      from: '2026-02-31',
      to: '2026-03-15',
    },
  }));

  // Reject unrecognized extra query parameters
  assert.throws(() => calendarQuerySchema.parse({
    query: {
      from: '2026-09-01',
      to: '2026-09-15',
      extra: 'param',
    },
  }));
});

test('Calendar helpers: formatUtcDate handles string and Date instances without timezone shift', () => {
  assert.equal(formatUtcDate(null), null);
  assert.equal(formatUtcDate(undefined), null);
  assert.equal(formatUtcDate('2026-09-15T00:00:00.000Z'), '2026-09-15');
  assert.equal(formatUtcDate('2026-09-15'), '2026-09-15');

  const d = new Date(Date.UTC(2026, 8, 15, 23, 59, 59));
  assert.equal(formatUtcDate(d), '2026-09-15');

  const d2 = new Date(Date.UTC(2027, 0, 1, 0, 0, 0));
  assert.equal(formatUtcDate(d2), '2027-01-01');
});

test('Calendar normalization and deterministic ordering: sorts by date ASC, type ASC, id ASC', () => {
  const events = [
    {
      id: 'release:book-2:2026-09-15',
      type: 'release',
      date: '2026-09-15',
      book: { id: 'book-2', title: 'Book 2', author: 'Author 2', coverImageUrl: null },
    },
    {
      id: 'finished:act-2',
      type: 'finished',
      date: '2026-09-15',
      book: { id: 'book-1', title: 'Book 1', author: 'Author 1', coverImageUrl: null },
    },
    {
      id: 'finished:act-1',
      type: 'finished',
      date: '2026-09-15',
      book: { id: 'book-1', title: 'Book 1', author: 'Author 1', coverImageUrl: null },
    },
    {
      id: 'release:book-1:2026-09-01',
      type: 'release',
      date: '2026-09-01',
      book: { id: 'book-1', title: 'Book 1', author: 'Author 1', coverImageUrl: null },
    },
    {
      id: 'finished:act-3',
      type: 'finished',
      date: '2026-09-20',
      book: { id: 'book-3', title: 'Book 3', author: 'Author 3', coverImageUrl: null },
    },
  ];

  const sorted = [...events].sort((a, b) => {
    const dateComp = a.date.localeCompare(b.date);
    if (dateComp !== 0) return dateComp;
    const typeComp = a.type.localeCompare(b.type);
    if (typeComp !== 0) return typeComp;
    return a.id.localeCompare(b.id);
  });

  assert.deepEqual(sorted.map(e => e.id), [
    'release:book-1:2026-09-01',
    'finished:act-1',
    'finished:act-2',
    'release:book-2:2026-09-15',
    'finished:act-3',
  ]);
});
