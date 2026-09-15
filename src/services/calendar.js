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

  const booksWithReleases = await prisma.book.findMany({
    where: {
      publicationDate: {
        gte: fromDate,
        lt: dayAfterToDate,
      },
    },
    select: {
      id: true,
      title: true,
      author: true,
      coverImageUrl: true,
      publicationDate: true,
    },
    orderBy: [
      { publicationDate: 'asc' },
      { id: 'asc' },
    ],
  });

  const releaseEvents = booksWithReleases.map(book => {
    const dateStr = formatUtcDate(book.publicationDate);
    return {
      id: `release:${book.id}:${dateStr}`,
      type: 'release',
      date: dateStr,
      book: {
        id: book.id,
        title: book.title,
        author: book.author,
        coverImageUrl: book.coverImageUrl,
      },
    };
  });

  return {
    range: {
      from,
      to,
    },
    events: releaseEvents,
  };
}

