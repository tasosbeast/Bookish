import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAuthor, matchTitle, matchWork } from '../scripts/catalog/match.js';
import {
  EDITION_SCORE_WEIGHTS,
  MIN_EDITION_SCORE,
  MIN_WINNER_MARGIN,
  evaluateEdition,
  selectEdition,
} from '../scripts/catalog/score-editions.js';

const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';
const ISBN_C = '9780140435962';
const source = { key: 'the-hobbit-jrr-tolkien', title: 'The Hobbit', author: 'J. R. R. Tolkien' };

function work(overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'work_search', providerIds: { workId: 'OL1W', editionId: null },
    title: source.title, subtitle: null, authors: [source.author], ...overrides,
  };
}

function edition(overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'edition', providerIds: { workId: 'OL1W', editionId: 'OL1M' },
    title: source.title, subtitle: null, authors: [source.author], languages: ['eng'], isbn13: [ISBN_A],
    publishers: ['HarperCollins'], formats: ['Paperback'], publicationDates: ['2012'], publicationYears: [2012],
    coverImageUrls: ['https://covers.openlibrary.org/b/id/1-L.jpg?default=false'], descriptions: ['A fantasy classic.'],
    subjects: ['Fantasy'], ...overrides,
  };
}

test('work matching tolerates punctuation, articles, subtitles and author display order', () => {
  const punctuation = matchWork(
    { key: 'pride-and-prejudice-jane-austen', title: 'Pride & Prejudice', author: 'Jane Austen' },
    work({ title: 'The Pride and Prejudice', authors: ['Austen, Jane'] }),
  );
  assert.equal(punctuation.eligible, true);
  assert.equal(punctuation.titleMatch.kind, 'token_exact');
  assert.equal(punctuation.authorMatch.kind, 'exact');

  const subtitle = matchWork(
    { key: 'old-man-and-sea-hemingway', title: 'The Old Man and the Sea: A Novel', author: 'Ernest Hemingway' },
    work({ title: 'A Old Man and the Sea', subtitle: 'The Hemingway Library Edition', authors: ['Ernest Hemingway'] }),
  );
  assert.equal(subtitle.eligible, true);
  assert.equal(subtitle.titleMatch.kind, 'source_subtitle_omitted');
  assert.equal(matchTitle('The Hobbit', 'Hobbit').kind, 'exact');
  assert.equal(matchAuthor('J. Austen', ['Jane Austen']).kind, 'strong_name');

  const strongTokens = matchTitle('A Tale of Two Cities', 'Tale of Two Cities Novel');
  assert.equal(strongTokens.eligible, true);
  assert.equal(strongTokens.kind, 'strong_tokens');
});

test('work matching disqualifies wrong authors, sequels and adaptation variants', () => {
  const sameTitleWrongAuthor = matchWork(source, work({ authors: ['Jane Austen'] }));
  assert.equal(sameTitleWrongAuthor.eligible, false);
  assert.equal(sameTitleWrongAuthor.authorMatch.kind, 'mismatch');

  const sequel = matchWork(
    { key: 'hunger-games-suzanne-collins', title: 'The Hunger Games', author: 'Suzanne Collins' },
    work({ title: 'Catching Fire: The Hunger Games Book 2', authors: ['Suzanne Collins'] }),
  );
  assert.equal(sequel.eligible, false);

  for (const title of ['The Hobbit Study Guides', 'The Hobbit Graphic Novels', 'The Hobbit: A Movie Companion', 'The Hobbit Omnibus']) {
    const result = matchWork(source, work({ title }));
    assert.equal(result.eligible, false, title);
    assert.match(result.reasons[0], /^rejected_/);
  }
});

test('short generic titles require exact title and strong author evidence', () => {
  const shortSource = { key: 'it-stephen-king', title: 'It', author: 'Stephen King' };
  assert.equal(matchWork(shortSource, work({ title: 'It Returns', authors: ['Stephen King'] })).eligible, false);
  assert.equal(matchWork(shortSource, work({ title: 'It', subtitle: 'A Novel', authors: ['Stephen King'] })).eligible, true);
  assert.equal(matchWork(shortSource, work({ title: 'It', authors: ['Alexa Chung'] })).eligible, false);
});

test('edition eligibility hard-rejects invalid identifiers, unsafe variants, audio and non-English editions', () => {
  const cases = [
    [edition({ isbn13: ['invalid'] }), 'rejected_missing_valid_isbn'],
    [edition({ title: 'The Hobbit Study Guide' }), 'rejected_study_guide'],
    [edition({ title: 'The Hobbit Graphic Novel' }), 'rejected_graphic_adaptation'],
    [edition({ formats: ['Audio CD'] }), 'rejected_audio_only'],
    [edition({ languages: ['fre'] }), 'rejected_non_english'],
    [edition({ authors: ['Jane Austen'] }), 'rejected_author_mismatch'],
  ];
  for (const [candidate, reason] of cases) {
    const result = evaluateEdition(source, candidate);
    assert.equal(result.eligible, false, reason);
    assert.equal(result.reasons[0], reason);
  }
});

test('missing optional edition metadata remains eligible without receiving bonuses', () => {
  const candidate = edition({ languages: [], publishers: [], formats: [], publicationDates: [], publicationYears: [], coverImageUrls: [], descriptions: [] });
  const result = evaluateEdition(source, candidate);
  assert.equal(result.eligible, true);
  assert.equal(result.score, EDITION_SCORE_WEIGHTS.titleExact + EDITION_SCORE_WEIGHTS.authorExact);
});

test('preferred ISBN wins comparable editions but cannot bypass hard eligibility', () => {
  const preferredSource = { ...source, preferredIsbn13: ISBN_B };
  const normal = edition({ isbn13: [ISBN_A], providerIds: { editionId: 'normal' } });
  const preferred = edition({ isbn13: [ISBN_B], providerIds: { editionId: 'preferred' } });
  let result = selectEdition(preferredSource, [normal, preferred]);
  assert.equal(result.status, 'selected');
  assert.equal(result.selected.providerIds.editionId, 'preferred');
  assert.equal(result.isbn, ISBN_B);
  assert.ok(result.reasons.includes('preferred_isbn'));

  const wrongPreferred = edition({ isbn13: [ISBN_B], title: 'The Silmarillion', authors: ['Jane Austen'], providerIds: { editionId: 'wrong' } });
  result = selectEdition(preferredSource, [wrongPreferred, normal]);
  assert.equal(result.status, 'selected');
  assert.equal(result.selected.providerIds.editionId, 'normal');
});

test('trade format beats library binding and metadata can create a clear winner', () => {
  const trade = edition({ isbn13: [ISBN_A], providerIds: { editionId: 'trade' } });
  const library = edition({ isbn13: [ISBN_B], formats: ['Library Binding'], providerIds: { editionId: 'library' } });
  let result = selectEdition(source, [library, trade]);
  assert.equal(result.status, 'selected');
  assert.equal(result.selected.providerIds.editionId, 'trade');
  assert.ok(result.margin >= MIN_WINNER_MARGIN);

  const complete = edition({ isbn13: [ISBN_A], providerIds: { editionId: 'complete' } });
  const sparse = edition({ isbn13: [ISBN_B], coverImageUrls: [], descriptions: [], providerIds: { editionId: 'sparse' } });
  result = selectEdition(source, [sparse, complete]);
  assert.equal(result.status, 'selected');
  assert.equal(result.selected.providerIds.editionId, 'complete');
  assert.equal(result.margin, EDITION_SCORE_WEIGHTS.cover + EDITION_SCORE_WEIGHTS.description);
});

test('close valid editions require review and deterministic ties use ISBN ascending', () => {
  const covered = edition({ isbn13: [ISBN_B], providerIds: { editionId: 'covered' } });
  const noCover = edition({ isbn13: [ISBN_A], coverImageUrls: [], providerIds: { editionId: 'no-cover' } });
  let result = selectEdition(source, [covered, noCover]);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reason, 'ambiguous_winner');
  assert.equal(result.margin, EDITION_SCORE_WEIGHTS.cover);

  const first = edition({ isbn13: [ISBN_A], providerIds: { editionId: 'a' } });
  const second = edition({ isbn13: [ISBN_C], providerIds: { editionId: 'c' } });
  const forward = selectEdition(source, [second, first]);
  const reverse = selectEdition(source, [first, second]);
  assert.equal(forward.status, 'needs_review');
  assert.equal(forward.topCandidate.isbn13[0], ISBN_C);
  assert.equal(reverse.topCandidate.isbn13[0], ISBN_C);
});

test('selection distinguishes no match, below threshold and clear winner', () => {
  const invalid = edition({ formats: ['Audiobook'] });
  assert.equal(selectEdition(source, [invalid]).status, 'no_match');

  const weak = edition({ authors: [], languages: [], publishers: [], formats: [], publicationDates: [], publicationYears: [], coverImageUrls: [], descriptions: [] });
  const review = selectEdition(source, [weak]);
  assert.equal(review.status, 'needs_review');
  assert.equal(review.reason, 'below_minimum_score');
  assert.ok(review.score < MIN_EDITION_SCORE);

  const clear = selectEdition(source, [edition()]);
  assert.equal(clear.status, 'selected');
  assert.equal(clear.reason, 'clear_winner');
  assert.equal(clear.selected.isbn13[0], ISBN_A);
  assert.equal(MIN_EDITION_SCORE, 55);
  assert.equal(MIN_WINNER_MARGIN, 8);
});
