import { normalizeIsbn13 } from './normalize.js';
import { workIdentity, compatibleIdentity } from './work-identity.js';
import { serializePublicationDate } from '../../src/services/books.js';
import { PrhClient, PrhApiError } from '../../src/services/prh-api.js';
import { mapPrhCategoriesToGenres } from './prh-genre-map.js';
import {
  importReleaseCatalog,
  deriveReleaseProvider,
  isValidCalendarDate,
  isValidHttpsUrl,
} from './release-catalog.js';

export class PrhSyncError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PrhSyncError';
    this.code = code;
    this.details = details;
  }
}

export function calculateDefaultDateWindow(asOf) {
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  if (Number.isNaN(asOfDate.getTime())) {
    throw new PrhSyncError('invalid_as_of', `Invalid asOf date: "${asOf}". Expected YYYY-MM-DD.`);
  }
  const fromDate = new Date(asOfDate.getTime() - 90 * 24 * 60 * 60 * 1000);
  const toDate = new Date(asOfDate.getTime() + 180 * 24 * 60 * 60 * 1000);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
  };
}

export function formatPreferenceRank(formatObj, formatDescriptionStr = '') {
  const code = (formatObj?.code || '').toUpperCase();
  const desc = (formatObj?.description || formatDescriptionStr || '').toLowerCase();

  // Excluded formats
  if (
    code === 'EB' || code === 'EC' ||
    desc.includes('e-book') || desc.includes('ebook') || desc.includes('electronic') || desc.includes('digital')
  ) {
    return -1; // eBook
  }
  if (
    code === 'AB' || code === 'CD' || code === 'AD' || code === 'AU' ||
    desc.includes('audio') || desc.includes('cd')
  ) {
    return -1; // Audio
  }
  if (desc.includes('large print')) {
    return -1; // Large print
  }
  if (desc.includes('box') || desc.includes('set') || desc.includes('pack') || desc.includes('collection')) {
    return -1; // Boxed set
  }
  if (
    desc.includes('calendar') || desc.includes('card') || desc.includes('deck') ||
    desc.includes('diary') || desc.includes('journal') || desc.includes('postcard') ||
    desc.includes('puzzle') || desc.includes('toy') || desc.includes('game')
  ) {
    return -1; // Non-book
  }

  // Preferred print formats
  if (code === 'HC' || desc.includes('hardcover')) {
    return 1;
  }
  if (code === 'TR' || desc.includes('trade paperback')) {
    return 2;
  }
  if (code === 'PB' || code === 'MM' || desc.includes('paperback') || desc.includes('mass market')) {
    return 3;
  }
  return 4; // other ordinary print
}

export function isEnglishPrhLanguage(titleOrLang) {
  if (titleOrLang === null || titleOrLang === undefined) {
    return true;
  }

  let langVal;
  let descVal;

  if (typeof titleOrLang === 'object') {
    langVal = titleOrLang.language;
    descVal = titleOrLang.languageDescription;
  } else if (typeof titleOrLang === 'string') {
    langVal = titleOrLang;
    descVal = undefined;
  }

  let rawLang = '';
  if (typeof langVal === 'string') {
    rawLang = langVal.trim();
  } else if (langVal && typeof langVal === 'object') {
    if (typeof langVal.code === 'string') {
      rawLang = langVal.code.trim();
    }
    if (!descVal && typeof langVal.description === 'string') {
      descVal = langVal.description;
    }
  }

  let rawDesc = '';
  if (typeof descVal === 'string') {
    rawDesc = descVal.trim();
  }

  // Missing or blank language data: ACCEPT (absence should not reject)
  if (!rawLang && !rawDesc) {
    return true;
  }

  function matchesEnglish(val) {
    if (!val) return false;
    const upper = val.toUpperCase();
    if (upper === 'E' || upper === 'EN' || upper === 'ENG') {
      return true;
    }
    const lower = val.toLowerCase();
    if (lower === 'english' || lower.startsWith('english')) {
      return true;
    }
    return false;
  }

  // Prefer checking language code first if present
  if (rawLang) {
    return matchesEnglish(rawLang);
  }

  // Fall back to checking language description
  if (rawDesc) {
    return matchesEnglish(rawDesc);
  }

  return false;
}

export async function syncPrhReleases(db, options = {}) {
  const apply = Boolean(options.apply);

  const asOf = options.asOf || new Date().toISOString().slice(0, 10);
  if (!isValidCalendarDate(asOf)) {
    throw new PrhSyncError('invalid_as_of', `Invalid asOf date: "${asOf}". Expected YYYY-MM-DD.`);
  }

  const defaultWindow = calculateDefaultDateWindow(asOf);
  const from = options.from || defaultWindow.from;
  const to = options.to || defaultWindow.to;

  if (!isValidCalendarDate(from)) {
    throw new PrhSyncError('invalid_from', `Invalid from date: "${from}". Expected YYYY-MM-DD.`);
  }
  if (!isValidCalendarDate(to)) {
    throw new PrhSyncError('invalid_to', `Invalid to date: "${to}". Expected YYYY-MM-DD.`);
  }
  if (from > to) {
    throw new PrhSyncError('invalid_date_range', `from date (${from}) cannot be after to date (${to})`);
  }

  const rawMaxNew = options.maxNew ?? 20;
  const maxNew = Math.min(Math.max(1, parseInt(rawMaxNew, 10) || 20), 50);

  const client = options.client || new PrhClient({
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
  });

  const refresh = {
    managedSources: 0,
    unchanged: 0,
    dateChanged: 0,
    localDivergence: 0,
    identityConflicts: 0,
    remoteMissing: 0,
    remoteInvalid: 0,
    verified: 0,
    updated: 0,
  };

  const discovery = {
    remoteTitlesFetched: 0,
    eligiblePrintTitles: 0,
    duplicateEditionsRemoved: 0,
    duplicateWorksRemoved: 0,
    alreadyInBookish: 0,
    workCollisions: 0,
    unmappedGenres: 0,
    invalidCandidates: 0,
    safeCandidates: 0,
    deferredByLimit: 0,
    plannedNew: 0,
    created: 0,
  };

  const details = {
    refresh: {
      unchanged: [],
      dateChanged: [],
      localDivergence: [],
      identityConflicts: [],
      remoteMissing: [],
      remoteInvalid: [],
    },
    discovery: {
      invalidCandidates: [],
      workCollisions: [],
      unmappedGenres: [],
      deferredByLimit: [],
      plannedNew: [],
    },
  };

  // ==========================================
  // PHASE A — REFRESH EXISTING PRH BOOKS
  // ==========================================
  const managedSources = await db.releaseMetadataSource.findMany({
    where: { provider: 'prh' },
    include: {
      book: {
        select: {
          id: true,
          isbn: true,
          title: true,
          author: true,
          publicationDate: true,
          publicationYear: true,
        },
      },
    },
  });
  refresh.managedSources = managedSources.length;

  const plannedRefreshChanged = [];
  const plannedRefreshUnchanged = [];

  for (const source of managedSources) {
    if (!source.book) continue;

    let remoteTitle;
    try {
      remoteTitle = await client.getTitleByIsbn(source.sourceIsbn);
    } catch (err) {
      refresh.remoteInvalid++;
      details.refresh.remoteInvalid.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        reason: `PRH API fetch error: ${err.message}`,
      });
      continue;
    }

    if (!remoteTitle) {
      refresh.remoteMissing++;
      details.refresh.remoteMissing.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        reason: 'PRH returned 404 or missing title for ISBN',
      });
      continue;
    }

    // Validate returned ISBN
    let normalizedRemoteIsbn = null;
    try {
      normalizedRemoteIsbn = normalizeIsbn13(String(remoteTitle.isbn || remoteTitle.isbnHyphenated || ''));
    } catch {}

    if (!normalizedRemoteIsbn || normalizedRemoteIsbn !== source.sourceIsbn) {
      refresh.identityConflicts++;
      details.refresh.identityConflicts.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        reason: `Returned remote ISBN "${normalizedRemoteIsbn}" does not match sourceIsbn "${source.sourceIsbn}"`,
      });
      continue;
    }

    if (source.book.isbn !== source.sourceIsbn) {
      refresh.identityConflicts++;
      details.refresh.identityConflicts.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        reason: `Book ISBN "${source.book.isbn}" does not match sourceIsbn "${source.sourceIsbn}"`,
      });
      continue;
    }

    // Check title/author identity compatibility
    if (!compatibleIdentity(source.book, { title: remoteTitle.title || '', author: remoteTitle.author || '' })) {
      refresh.identityConflicts++;
      details.refresh.identityConflicts.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        reason: `Remote title/author ("${remoteTitle.title}" by "${remoteTitle.author}") incompatible with Book ("${source.book.title}" by "${source.book.author}")`,
      });
      continue;
    }

    // Validate remote onsale date
    const rawRemoteOnsale = remoteTitle.onsale ? String(remoteTitle.onsale).slice(0, 10) : '';
    if (!rawRemoteOnsale || !isValidCalendarDate(rawRemoteOnsale)) {
      refresh.remoteInvalid++;
      details.refresh.remoteInvalid.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        reason: `Malformed or missing remote onsale date: "${remoteTitle.onsale}"`,
      });
      continue;
    }

    // Local-Divergence Rule
    const bookDateStr = serializePublicationDate(source.book.publicationDate);
    const verifiedDateStr = serializePublicationDate(source.verifiedPublicationDate);

    if (bookDateStr !== verifiedDateStr) {
      refresh.localDivergence++;
      details.refresh.localDivergence.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        bookPublicationDate: bookDateStr,
        verifiedPublicationDate: verifiedDateStr,
        reason: `Book.publicationDate (${bookDateStr}) differs from verifiedPublicationDate (${verifiedDateStr}) - local divergence protected`,
      });
      continue;
    }

    // Classify unchanged vs dateChanged
    if (rawRemoteOnsale === verifiedDateStr) {
      refresh.unchanged++;
      details.refresh.unchanged.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        publicationDate: verifiedDateStr,
      });
      plannedRefreshUnchanged.push({
        source,
        book: source.book,
        verifiedDateStr,
      });
    } else {
      refresh.dateChanged++;
      details.refresh.dateChanged.push({
        isbn: source.sourceIsbn,
        title: source.book.title,
        previousDate: verifiedDateStr,
        remoteOnsale: rawRemoteOnsale,
      });
      plannedRefreshChanged.push({
        source,
        book: source.book,
        oldDateStr: verifiedDateStr,
        newDateStr: rawRemoteOnsale,
      });
    }
  }

  // Refresh Apply: Atomic conditional mutations
  if (apply && (plannedRefreshChanged.length > 0 || plannedRefreshUnchanged.length > 0)) {
    await db.$transaction(async tx => {
      for (const item of plannedRefreshChanged) {
        const oldDateObj = new Date(`${item.oldDateStr}T00:00:00.000Z`);
        const newDateObj = new Date(`${item.newDateStr}T00:00:00.000Z`);
        const newYear = parseInt(item.newDateStr.slice(0, 4), 10);

        const bookRes = await tx.book.updateMany({
          where: {
            id: item.book.id,
            isbn: item.source.sourceIsbn,
            publicationDate: oldDateObj,
          },
          data: {
            publicationDate: newDateObj,
            publicationYear: newYear,
          },
        });
        if (bookRes.count !== 1) {
          throw new PrhSyncError(
            'stale_preflight',
            `Stale preflight: Book ${item.source.sourceIsbn} publicationDate was modified concurrently`
          );
        }

        const sourceRes = await tx.releaseMetadataSource.updateMany({
          where: {
            id: item.source.id,
            provider: 'prh',
            sourceIsbn: item.source.sourceIsbn,
            verifiedPublicationDate: oldDateObj,
          },
          data: {
            verifiedPublicationDate: newDateObj,
            lastVerifiedAt: new Date(),
          },
        });
        if (sourceRes.count !== 1) {
          throw new PrhSyncError(
            'stale_preflight',
            `Stale preflight: ReleaseMetadataSource ${item.source.sourceIsbn} was modified concurrently`
          );
        }
      }

      for (const item of plannedRefreshUnchanged) {
        const verifiedDateObj = new Date(`${item.verifiedDateStr}T00:00:00.000Z`);
        const sourceRes = await tx.releaseMetadataSource.updateMany({
          where: {
            id: item.source.id,
            provider: 'prh',
            sourceIsbn: item.source.sourceIsbn,
            verifiedPublicationDate: verifiedDateObj,
          },
          data: {
            lastVerifiedAt: new Date(),
          },
        });
        if (sourceRes.count !== 1) {
          throw new PrhSyncError(
            'stale_preflight',
            `Stale preflight: ReleaseMetadataSource ${item.source.sourceIsbn} was modified concurrently`
          );
        }
      }
    });

    refresh.updated = plannedRefreshChanged.length;
    refresh.verified = plannedRefreshUnchanged.length;
  }

  // ==========================================
  // PHASE B — DISCOVERY
  // ==========================================
  let start = 0;
  const rows = 100;
  const allRemoteTitles = [];

  while (true) {
    let page;
    try {
      page = await client.listTitlesByOnSaleRange({ from, to, start, rows });
    } catch (err) {
      throw new PrhSyncError('discovery_fetch_failed', `Failed to fetch PRH titles: ${err.message}`, { originalError: err });
    }
    const pageTitles = page.titles || [];
    allRemoteTitles.push(...pageTitles);

    if (pageTitles.length < rows || (page.recordCount && (start + pageTitles.length >= page.recordCount))) {
      break;
    }
    start += pageTitles.length;
  }
  discovery.remoteTitlesFetched = allRemoteTitles.length;

  // Filter raw titles into candidate objects
  const rawCandidates = [];

  for (const t of allRemoteTitles) {
    const titleText = (t.title || '').trim();
    const authorText = (t.author || '').trim();
    const rawIsbn = String(t.isbn || t.isbnHyphenated || '').trim();
    const onsale = t.onsale ? String(t.onsale).slice(0, 10) : '';

    // Language check if language data present
    if (!isEnglishPrhLanguage(t)) {
      discovery.invalidCandidates++;
      const langReport = typeof t.language === 'object'
        ? JSON.stringify(t.language)
        : (t.language || t.languageDescription || 'Non-English');
      details.discovery.invalidCandidates.push({
        isbn: rawIsbn,
        title: titleText,
        reason: `Non-English language: "${langReport}"`,
      });
      continue;
    }

    // Format filter
    const rank = formatPreferenceRank(t.format, t.formatDescription);
    if (rank <= 0) {
      continue; // eBook, audiobook, boxed set, non-book, large print
    }
    discovery.eligiblePrintTitles++;

    // Basic validity
    let normalizedIsbn;
    try {
      normalizedIsbn = normalizeIsbn13(rawIsbn);
    } catch {
      discovery.invalidCandidates++;
      details.discovery.invalidCandidates.push({
        isbn: rawIsbn,
        title: titleText,
        reason: `Invalid ISBN-13: "${rawIsbn}"`,
      });
      continue;
    }

    if (!titleText || !authorText) {
      discovery.invalidCandidates++;
      details.discovery.invalidCandidates.push({
        isbn: normalizedIsbn,
        title: titleText,
        reason: 'Empty title or author',
      });
      continue;
    }

    if (!onsale || !isValidCalendarDate(onsale)) {
      discovery.invalidCandidates++;
      details.discovery.invalidCandidates.push({
        isbn: normalizedIsbn,
        title: titleText,
        reason: `Invalid onsale date: "${t.onsale}"`,
      });
      continue;
    }

    // Source URL
    const seoPath = (t.seoFriendlyUrl || '').trim();
    const sourceUrl = seoPath ? `https://www.penguinrandomhouse.com${seoPath.startsWith('/') ? '' : '/'}${seoPath}` : null;
    if (!sourceUrl || !isValidHttpsUrl(sourceUrl)) {
      discovery.invalidCandidates++;
      details.discovery.invalidCandidates.push({
        isbn: normalizedIsbn,
        title: titleText,
        reason: `Missing or invalid official PRH seoFriendlyUrl: "${t.seoFriendlyUrl}"`,
      });
      continue;
    }

    let provider = null;
    try {
      provider = deriveReleaseProvider(sourceUrl);
    } catch (err) {
      discovery.invalidCandidates++;
      details.discovery.invalidCandidates.push({
        isbn: normalizedIsbn,
        title: titleText,
        reason: `Unsupported sourceUrl: ${err.message}`,
      });
      continue;
    }
    if (provider !== 'prh') {
      discovery.invalidCandidates++;
      continue;
    }

    // Cover image URL
    const iconLink = (t._links || []).find(link => link.rel === 'icon');
    const coverUrl = (iconLink?.href || '').trim();
    if (!coverUrl || !isValidHttpsUrl(coverUrl) || /placeholder|no-cover/i.test(coverUrl)) {
      discovery.invalidCandidates++;
      details.discovery.invalidCandidates.push({
        isbn: normalizedIsbn,
        title: titleText,
        reason: 'Missing or placeholder cover image',
      });
      continue;
    }

    rawCandidates.push({
      title: titleText,
      author: authorText,
      isbn: normalizedIsbn,
      onsale,
      coverImageUrl: coverUrl,
      sourceUrl,
      provider,
      workId: t.workId ? String(t.workId) : null,
      rank,
      categories: t.categories || [],
      rawTitle: t,
    });
  }

  // Work Deduplication & Preferred Edition Selection
  const candidatesByWork = new Map();
  for (const cand of rawCandidates) {
    const key = cand.workId ? `prh:${cand.workId}` : `work:${workIdentity(cand)}`;
    if (!candidatesByWork.has(key)) {
      candidatesByWork.set(key, []);
    }
    candidatesByWork.get(key).push(cand);
  }

  const singleEditionPerWork = [];
  for (const editions of candidatesByWork.values()) {
    // Sort editions by format rank (1 < 2 < 3 < 4), tie-breaker lower ISBN
    editions.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.isbn.localeCompare(b.isbn);
    });
    singleEditionPerWork.push(editions[0]);
    if (editions.length > 1) {
      discovery.duplicateEditionsRemoved += editions.length - 1;
    }
  }

  // Cross-work identity deduplication
  const chosenByWorkIdentity = new Map();
  for (const cand of singleEditionPerWork) {
    const wid = workIdentity(cand);
    const existing = chosenByWorkIdentity.get(wid);
    if (!existing) {
      chosenByWorkIdentity.set(wid, cand);
    } else {
      discovery.duplicateWorksRemoved++;
      if (cand.rank < existing.rank || (cand.rank === existing.rank && cand.isbn < existing.isbn)) {
        chosenByWorkIdentity.set(wid, cand);
      }
    }
  }
  const deduplicatedCandidates = Array.from(chosenByWorkIdentity.values());

  // Existing Database Deduplication
  const allDbBooks = await db.book.findMany({
    select: { id: true, isbn: true, title: true, author: true },
  });
  const dbIsbns = new Set(allDbBooks.map(b => b.isbn).filter(Boolean));
  const dbWorks = new Map();
  for (const b of allDbBooks) {
    dbWorks.set(workIdentity(b), b);
  }

  const allDbSources = await db.releaseMetadataSource.findMany({
    select: { provider: true, sourceIsbn: true },
  });
  const dbSourceIsbns = new Set(
    allDbSources.filter(s => s.provider === 'prh').map(s => s.sourceIsbn)
  );

  const survivingCandidates = [];
  for (const cand of deduplicatedCandidates) {
    if (dbIsbns.has(cand.isbn) || dbSourceIsbns.has(cand.isbn)) {
      discovery.alreadyInBookish++;
      continue;
    }

    const collision = dbWorks.get(workIdentity(cand));
    if (collision) {
      discovery.workCollisions++;
      details.discovery.workCollisions.push({
        isbn: cand.isbn,
        title: cand.title,
        author: cand.author,
        collidingBookId: collision.id,
        collidingIsbn: collision.isbn,
        reason: `Work collision with existing Book "${collision.title}" by "${collision.author}"`,
      });
      continue;
    }

    survivingCandidates.push(cand);
  }

  // Genre Mapping
  const safeCandidates = [];
  for (const cand of survivingCandidates) {
    let categories = cand.categories;
    if (!categories || categories.length === 0) {
      try {
        categories = await client.getTitleCategories(cand.isbn);
      } catch {
        categories = [];
      }
    }

    const mappedSlugs = mapPrhCategoriesToGenres(categories);
    if (mappedSlugs.length === 0) {
      discovery.unmappedGenres++;
      details.discovery.unmappedGenres.push({
        isbn: cand.isbn,
        title: cand.title,
        reason: 'PRH categories could not be confidently mapped to canonical Bookish genres',
      });
      continue;
    }

    cand.genres = mappedSlugs;
    safeCandidates.push(cand);
  }
  discovery.safeCandidates = safeCandidates.length;

  // Controlled Growth: Deterministic sorting
  // 1. Upcoming (onsale > asOf) ascending by difference to asOf
  // 2. Recent (onsale <= asOf) descending by date (newest first)
  const upcoming = safeCandidates.filter(c => c.onsale > asOf);
  const recent = safeCandidates.filter(c => c.onsale <= asOf);

  upcoming.sort((a, b) => {
    if (a.onsale !== b.onsale) return a.onsale.localeCompare(b.onsale);
    if (a.title !== b.title) return a.title.localeCompare(b.title);
    return a.isbn.localeCompare(b.isbn);
  });

  recent.sort((a, b) => {
    if (a.onsale !== b.onsale) return b.onsale.localeCompare(a.onsale);
    if (a.title !== b.title) return a.title.localeCompare(b.title);
    return a.isbn.localeCompare(b.isbn);
  });

  const sortedCandidates = [...upcoming, ...recent];
  const candidateSlice = sortedCandidates.slice(0, maxNew);
  const deferred = sortedCandidates.slice(maxNew);

  // Preflight planned candidates through release-catalog importer in dry-run mode
  // as the final preflight authority before reporting them as plannedNew.
  const plannedNew = [];
  if (candidateSlice.length > 0) {
    const preflightRecords = candidateSlice.map(c => ({
      title: c.title,
      author: c.author,
      isbn: c.isbn,
      publicationDate: c.onsale,
      coverImageUrl: c.coverImageUrl,
      genres: c.genres,
      sourceUrl: c.sourceUrl,
    }));

    const preflightResult = await importReleaseCatalog(db, {
      records: preflightRecords,
      apply: false,
    });

    const approvedIsbns = new Set((preflightResult.details.newBooks || []).map(b => b.isbn));

    for (const cand of candidateSlice) {
      if (approvedIsbns.has(cand.isbn)) {
        plannedNew.push(cand);
      } else {
        discovery.invalidCandidates++;
        const missingG = (preflightResult.details.missingGenres || []).find(m => m.isbn === cand.isbn);
        const exactC = (preflightResult.details.exactIsbnConflicts || []).find(m => m.isbn === cand.isbn);
        const workC = (preflightResult.details.existingWorkCollisions || []).find(m => m.isbn === cand.isbn);
        const provC = (preflightResult.details.provenanceConflicts || []).find(m => m.isbn === cand.isbn);
        const reason = missingG?.message || exactC?.message || workC?.message || provC?.message || 'Rejected by release-catalog importer preflight';
        details.discovery.invalidCandidates.push({
          isbn: cand.isbn,
          title: cand.title,
          reason,
        });
      }
    }
  }

  discovery.plannedNew = plannedNew.length;
  discovery.deferredByLimit = deferred.length;

  for (const cand of plannedNew) {
    details.discovery.plannedNew.push({
      isbn: cand.isbn,
      title: cand.title,
      author: cand.author,
      publicationDate: cand.onsale,
      genres: cand.genres,
      sourceUrl: cand.sourceUrl,
    });
  }

  for (const cand of deferred) {
    details.discovery.deferredByLimit.push({
      isbn: cand.isbn,
      title: cand.title,
      author: cand.author,
      publicationDate: cand.onsale,
      reason: `Deferred by max-new limit (${maxNew})`,
    });
  }

  // Discovery Import via Release Importer
  if (apply && plannedNew.length > 0) {
    const recordsToImport = plannedNew.map(c => ({
      title: c.title,
      author: c.author,
      isbn: c.isbn,
      publicationDate: c.onsale,
      coverImageUrl: c.coverImageUrl,
      genres: c.genres,
      sourceUrl: c.sourceUrl,
    }));

    const importResult = await importReleaseCatalog(db, {
      records: recordsToImport,
      apply: true,
    });

    discovery.created = importResult.summary.created;
  }

  const summary = {
    asOf,
    from,
    to,
    refresh,
    discovery,
  };

  return { summary, details };
}
