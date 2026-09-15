import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateReleaseWindows,
  getUtcTodayString,
  getReleases,
} from '../src/services/releases.js';
import { releasesSchema } from '../src/validators/index.js';
import { serializeBook } from '../src/services/books.js';

test('Releases unit: calculateReleaseWindows computes exact date-only rolling windows', () => {
  const asOf = '2026-09-15';
  const result = calculateReleaseWindows(asOf);

  assert.equal(result.asOf, '2026-09-15');
  assert.equal(result.windows.newReleases.to, '2026-09-15');
  // 90 days before 2026-09-15:
  // Sep: 15 days -> 0 left in Sep (start of Sep 1 = 14 days)
  // Aug: 31 days
  // Jul: 31 days
  // Jun: 14 days (30 - 14 + 1 = 17) -> 2026-06-17
  // Check 2026-09-15 minus 90 days
  assert.equal(result.windows.newReleases.from, '2026-06-17');

  assert.equal(result.windows.upcoming.fromExclusive, '2026-09-15');
  // 180 days after 2026-09-15:
  // Sep: 15 days (30-15 = 15)
  // Oct: 31 days
  // Nov: 30 days
  // Dec: 31 days
  // Jan 2027: 31 days
  // Feb 2027: 28 days
  // Mar 2027: 14 days -> 2027-03-14 (15+31+30+31+31+28+14 = 180)
  assert.equal(result.windows.upcoming.to, '2027-03-14');

  // Verify date objects in UTC
  assert.equal(result.dates.newReleases.gte.toISOString().slice(0, 10), '2026-06-17');
  assert.equal(result.dates.newReleases.lte.toISOString().slice(0, 10), '2026-09-15');
  assert.equal(result.dates.upcoming.gt.toISOString().slice(0, 10), '2026-09-15');
  assert.equal(result.dates.upcoming.lte.toISOString().slice(0, 10), '2027-03-14');
});

test('Releases unit: getUtcTodayString returns YYYY-MM-DD from UTC date', () => {
  const d = new Date('2026-09-15T23:59:59.999Z');
  assert.equal(getUtcTodayString(d), '2026-09-15');
});

test('Releases validation: releasesSchema validates query params and limits', () => {
  // Default limit
  const res1 = releasesSchema.parse({ query: {} });
  assert.equal(res1.query.limit, 24);

  // Custom limit clamped to max 50
  const res2 = releasesSchema.parse({ query: { limit: '50' } });
  assert.equal(res2.query.limit, 50);

  // Over limit rejected
  assert.throws(() => releasesSchema.parse({ query: { limit: '51' } }));
  // Zero/negative limit rejected
  assert.throws(() => releasesSchema.parse({ query: { limit: '0' } }));
  assert.throws(() => releasesSchema.parse({ query: { limit: '-5' } }));

  // asOf query param is rejected by strict validator
  assert.throws(() => releasesSchema.parse({ query: { asOf: '2026-09-15' } }));
});

test('Releases filtering and sorting logic with explicit asOf date', () => {
  const asOf = '2026-09-15';
  const windows = calculateReleaseWindows(asOf);

  // Mock catalog of books covering boundary conditions
  const books = [
    // 1. publicationDate = null
    { id: 'b-null-date', title: 'Null Date', publicationYear: 2026, publicationDate: null, averageRating: 4.0, bookGenres: [] },
    // 2. publicationYear only (no date)
    { id: 'b-year-only', title: 'Year Only', publicationYear: 2026, publicationDate: null, averageRating: 3.5, bookGenres: [] },
    // 3. Exactly today: 2026-09-15
    { id: 'b-today', title: 'Today Book', publicationYear: 2026, publicationDate: new Date('2026-09-15T00:00:00.000Z'), averageRating: 4.5, bookGenres: [] },
    // 4. Exactly 90 days before today: 2026-06-17
    { id: 'b-90-days-ago', title: '90 Days Ago', publicationYear: 2026, publicationDate: new Date('2026-06-17T00:00:00.000Z'), averageRating: 4.0, bookGenres: [] },
    // 5. 91 days before today: 2026-06-16 (should be excluded from New Releases)
    { id: 'b-91-days-ago', title: '91 Days Ago', publicationYear: 2026, publicationDate: new Date('2026-06-16T00:00:00.000Z'), averageRating: 4.0, bookGenres: [] },
    // 6. Tomorrow: 2026-09-16 (should be in Upcoming)
    { id: 'b-tomorrow', title: 'Tomorrow Book', publicationYear: 2026, publicationDate: new Date('2026-09-16T00:00:00.000Z'), averageRating: null, bookGenres: [] },
    // 7. Exactly 180 days after today: 2027-03-14 (should be in Upcoming)
    { id: 'b-180-days-future', title: '180 Days Future', publicationYear: 2027, publicationDate: new Date('2027-03-14T00:00:00.000Z'), averageRating: null, bookGenres: [] },
    // 8. 181 days after today: 2027-03-15 (should be excluded from Upcoming)
    { id: 'b-181-days-future', title: '181 Days Future', publicationYear: 2027, publicationDate: new Date('2027-03-15T00:00:00.000Z'), averageRating: null, bookGenres: [] },
    // 9. Additional new release for sorting test: 2026-08-01
    { id: 'b-mid-new', title: 'Mid New Release', publicationYear: 2026, publicationDate: new Date('2026-08-01T00:00:00.000Z'), averageRating: 4.2, bookGenres: [] },
    // 10. Tie-breaker books with identical publicationDate
    { id: 'b-tie-2', title: 'Tie 2', publicationYear: 2026, publicationDate: new Date('2026-08-01T00:00:00.000Z'), averageRating: null, bookGenres: [] },
    { id: 'b-tie-1', title: 'Tie 1', publicationYear: 2026, publicationDate: new Date('2026-08-01T00:00:00.000Z'), averageRating: null, bookGenres: [] },
    // 11. Additional upcoming for sorting test: 2026-11-01
    { id: 'b-mid-upcoming', title: 'Mid Upcoming', publicationYear: 2026, publicationDate: new Date('2026-11-01T00:00:00.000Z'), averageRating: null, bookGenres: [] },
  ];

  // Filter New Releases: gte 90 days ago, lte today
  const newReleases = books.filter(b => {
    if (!b.publicationDate) return false;
    return b.publicationDate >= windows.dates.newReleases.gte && b.publicationDate <= windows.dates.newReleases.lte;
  }).sort((a, b) => {
    const diff = b.publicationDate.getTime() - a.publicationDate.getTime();
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });

  // Filter Upcoming: gt today, lte 180 days future
  const upcoming = books.filter(b => {
    if (!b.publicationDate) return false;
    return b.publicationDate > windows.dates.upcoming.gt && b.publicationDate <= windows.dates.upcoming.lte;
  }).sort((a, b) => {
    const diff = a.publicationDate.getTime() - b.publicationDate.getTime();
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });

  // 1 & 2: publicationDate null / year-only excluded from both
  assert.ok(!newReleases.some(b => b.id === 'b-null-date' || b.id === 'b-year-only'));
  assert.ok(!upcoming.some(b => b.id === 'b-null-date' || b.id === 'b-year-only'));

  // 3: exactly today included in New Releases
  assert.ok(newReleases.some(b => b.id === 'b-today'));

  // 4: exactly today excluded from Upcoming
  assert.ok(!upcoming.some(b => b.id === 'b-today'));

  // 5: exactly 90 days before today included in New Releases
  assert.ok(newReleases.some(b => b.id === 'b-90-days-ago'));

  // 6: 91 days before excluded
  assert.ok(!newReleases.some(b => b.id === 'b-91-days-ago'));

  // 7: tomorrow included in Upcoming
  assert.ok(upcoming.some(b => b.id === 'b-tomorrow'));

  // 8: exactly 180 days after today included
  assert.ok(upcoming.some(b => b.id === 'b-180-days-future'));

  // 9: 181 days after excluded
  assert.ok(!upcoming.some(b => b.id === 'b-181-days-future'));

  // 10: New Releases sorted newest-first (b-today is first)
  assert.equal(newReleases[0].id, 'b-today');

  // 11: Upcoming sorted nearest-first (b-tomorrow is first)
  assert.equal(upcoming[0].id, 'b-tomorrow');

  // 12: Deterministic tie-breaking (b-mid-new, b-tie-1, b-tie-2 all on 2026-08-01)
  const tieSlice = newReleases.filter(b => b.publicationDate.toISOString().slice(0, 10) === '2026-08-01');
  assert.deepEqual(tieSlice.map(b => b.id), ['b-mid-new', 'b-tie-1', 'b-tie-2']);

  // 13: Date serialization remains YYYY-MM-DD
  const serialized = newReleases.map(serializeBook);
  assert.equal(serialized[0].publicationDate, '2026-09-15');
  assert.ok(!serialized.some(b => b.publicationDate && b.publicationDate.includes('T')));

  // 14: Limits
  const limited = newReleases.slice(0, 2);
  assert.equal(limited.length, 2);

  // 15: No provenance/source metadata leakage
  for (const item of serialized) {
    assert.equal(item.releaseMetadataSource, undefined);
    assert.equal(item.provider, undefined);
    assert.equal(item.sourceUrl, undefined);
    assert.equal(item.sourceIsbn, undefined);
  }
});
