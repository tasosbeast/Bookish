import { prisma } from '../lib/prisma.js';

export function formatUtcDate(date) {
  if (!date) return null;
  if (typeof date === 'string') return date.slice(0, 10);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function getCalendarEvents({ from, to }) {
  const [fromY, fromM, fromD] = from.split('-').map(Number);
  const [toY, toM, toD] = to.split('-').map(Number);
  const fromDate = new Date(Date.UTC(fromY, fromM - 1, fromD));
  const dayAfterToDate = new Date(Date.UTC(toY, toM - 1, toD + 1));

  const metadataSources = await prisma.releaseMetadataSource.findMany({
    where: {
      verifiedPublicationDate: {
        gte: fromDate,
        lt: dayAfterToDate,
      },
      book: {
        publicationDate: {
          not: null,
        },
      },
    },
    select: {
      verifiedPublicationDate: true,
      book: {
        select: {
          id: true,
          title: true,
          author: true,
          coverImageUrl: true,
          publicationDate: true,
        },
      },
    },
    orderBy: [
      { verifiedPublicationDate: 'asc' },
      { bookId: 'asc' },
    ],
  });

  const releaseEvents = [];
  for (const source of metadataSources) {
    if (!source.book?.publicationDate) continue;
    const verifiedDateStr = formatUtcDate(source.verifiedPublicationDate);
    const bookDateStr = formatUtcDate(source.book.publicationDate);

    // Strict calendar date equality between verified date and Book.publicationDate
    if (verifiedDateStr !== bookDateStr) continue;

    releaseEvents.push({
      id: `release:${source.book.id}:${verifiedDateStr}`,
      type: 'release',
      date: verifiedDateStr,
      book: {
        id: source.book.id,
        title: source.book.title,
        author: source.book.author,
        coverImageUrl: source.book.coverImageUrl,
      },
    });
  }

  releaseEvents.sort((a, b) => {
    const dateComp = a.date.localeCompare(b.date);
    if (dateComp !== 0) return dateComp;
    return a.book.id.localeCompare(b.book.id);
  });

  return {
    range: {
      from,
      to,
    },
    events: releaseEvents,
  };
}


