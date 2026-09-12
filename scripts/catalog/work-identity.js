import { normalizeAuthorName, normalizeTitle } from './normalize.js';

export function titleForWorkIdentity(title) {
  const suffix = title.match(/\s*\(([^()]*)\)\s*$/);
  if (!suffix || /\b(audio|audiobook|graphic|guide|study|summary|companion|omnibus|collection|box set|movie|film|adaptation)\b/i.test(suffix[1])) {
    return normalizeTitle(title);
  }
  return normalizeTitle(title.slice(0, suffix.index));
}

export function workIdentity(book) {
  return `${titleForWorkIdentity(book.title)}\u0000${normalizeAuthorName(book.author)}`;
}

export function compatibleIdentity(book, entry) {
  return workIdentity(book) === workIdentity(entry);
}
