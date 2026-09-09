import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSourceManifest } from '../scripts/catalog/contracts.js';
import { normalizeAuthorName, normalizeTitle } from '../scripts/catalog/normalize.js';

const sourcePath = new URL('../scripts/catalog-source.json', import.meta.url);

const productionPins = [
  ['pride-and-prejudice-jane-austen', '9780141439518'],
  ['wuthering-heights-emily-bronte', '9780141439556'],
  ['jane-eyre-charlotte-bronte', '9780141441146'],
  ['a-tale-of-two-cities-charles-dickens', '9780141439600'],
  ['the-great-gatsby-f-scott-fitzgerald', '9780743273565'],
  ['to-kill-a-mockingbird-harper-lee', '9780061120084'],
  ['1984-george-orwell', '9780451524935'],
  ['animal-farm-george-orwell', '9780451526342'],
  ['the-hobbit-j-r-r-tolkien', '9780547928227'],
  ['dune-frank-herbert', '9780441172719'],
  ['neuromancer-william-gibson', '9780441569595'],
  ['the-hitchhikers-guide-to-the-galaxy-douglas-adams', '9780345391803'],
  ['enders-game-orson-scott-card', '9780812550702'],
  ['brave-new-world-aldous-huxley', '9780060850524'],
  ['the-shining-stephen-king', '9780307743657'],
  ['and-then-there-were-none-agatha-christie', '9780062073488'],
  ['the-alchemist-paulo-coelho', '9780062315007'],
  ['one-hundred-years-of-solitude-gabriel-garcia-marquez', '9781400034710'],
  ['beloved-toni-morrison', '9781400033416'],
  ['the-handmaids-tale-margaret-atwood', '9780385490818'],
  ['the-odyssey-homer', '9780140449136'],
  ['the-count-of-monte-cristo-alexandre-dumas', '9780140449266'],
  ['meditations-marcus-aurelius', '9780140449334'],
  ['a-brief-history-of-time-stephen-hawking', '9780553380163'],
  ['sapiens-yuval-noah-harari', '9780062316097'],
  ['the-power-of-habit-charles-duhigg', '9780812981605'],
  ['thinking-fast-and-slow-daniel-kahneman', '9780143110439'],
  ['matilda-roald-dahl', '9780140328721'],
  ['charlottes-web-e-b-white', '9780061124952'],
  ['the-little-prince-antoine-de-saint-exupery', '9780156012195'],
];

const changedCurrentEditions = [
  ['pride-and-prejudice-jane-austen', '9780140435962'],
  ['wuthering-heights-emily-bronte', '9798687166393'],
  ['1984-george-orwell', '9780241436493'],
  ['animal-farm-george-orwell', '9780451510280'],
  ['the-hobbit-j-r-r-tolkien', '9780812415834'],
  ['dune-frank-herbert', '9780425064344'],
  ['neuromancer-william-gibson', '9781473217379'],
  ['enders-game-orson-scott-card', '9780812532531'],
  ['and-then-there-were-none-agatha-christie', '9781906141011'],
  ['the-alchemist-paulo-coelho', '9780061122415'],
  ['one-hundred-years-of-solitude-gabriel-garcia-marquez', '9780060883287'],
  ['the-handmaids-tale-margaret-atwood', '9781408802953'],
  ['the-odyssey-homer', '9780393417937'],
  ['the-count-of-monte-cristo-alexandre-dumas', '9780593081501'],
  ['a-brief-history-of-time-stephen-hawking', '9780553175219'],
  ['sapiens-yuval-noah-harari', '9780062316103'],
  ['thinking-fast-and-slow-daniel-kahneman', '9780385676533'],
  ['matilda-roald-dahl', '9780142410370'],
  ['charlottes-web-e-b-white', '9780140347227'],
  ['the-little-prince-antoine-de-saint-exupery', '9780152048044'],
];

function sourceEntries() {
  return JSON.parse(readFileSync(sourcePath, 'utf8'));
}

test('catalog source manifest is a deterministic, valid set of 250 unique works', () => {
  const entries = sourceEntries();
  const normalized = validateSourceManifest(entries);

  assert.equal(normalized.length, 250);
  assert.equal(new Set(normalized.map(entry => entry.key)).size, 250);
  assert.equal(new Set(normalized.map(entry => entry.preferredIsbn13)).size, 250);
  assert.equal(new Set(normalized.map(entry => `${normalizeTitle(entry.title)}\u0000${normalizeAuthorName(entry.author)}`)).size, 250);
  assert.deepEqual(normalized.slice(0, productionPins.length).map(entry => entry.key), productionPins.map(([key]) => key));
});

test('all 30 production book identities remain pinned to their imported ISBNs', () => {
  const byKey = new Map(validateSourceManifest(sourceEntries()).map(entry => [entry.key, entry]));

  assert.equal(productionPins.length, 30);
  for (const [key, isbn] of productionPins) assert.equal(byKey.get(key)?.preferredIsbn13, isbn, key);
});

test('known later edition replacements cannot replace production ISBN pins', () => {
  const byKey = new Map(validateSourceManifest(sourceEntries()).map(entry => [entry.key, entry]));
  const productionIsbns = new Map(productionPins);

  for (const [key, laterIsbn] of changedCurrentEditions) {
    assert.notEqual(productionIsbns.get(key), laterIsbn, `${key} must retain its production edition`);
    assert.equal(byKey.get(key)?.preferredIsbn13, productionIsbns.get(key), key);
  }
});
