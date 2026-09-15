import { prisma } from '../lib/prisma.js';

export function formatUtcDate(date) {
  if (!date) return null;
  if (typeof date === 'string') return date.slice(0, 10);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function getCalendarEvents({ userId, from, to }) {
  const [fromY, fromM, fromD] = from.split('-').map(Number);
  const [toY, toM, toD] = to.split('-').map(Number);
  const fromDate = new Date(Date.UTC(fromY, fromM - 1, fromD));
  const dayAfterToDate = new Date(Date.UTC(toY, toM - 1, toD + 1));

  const [booksWithReleases, finishedActivities] = await prisma.$transaction([
    prisma.book.findMany({
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
    }),
    prisma.activity.findMany({
      where: {
        userId,
        type: 'finished_reading',
        finishedOn: {
          gte: fromDate,
          lt: dayAfterToDate,
          not: null,
        },
      },
      include: {
        book: {
          select: {
            id: true,
            title: true,
            author: true,
            coverImageUrl: true,
          },
        },
      },
      orderBy: [
        { finishedOn: 'asc' },
        { id: 'asc' },
      ],
    }),
  ], { isolationLevel: 'RepeatableRead' });

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

  const finishedEvents = finishedActivities.map(activity => {
    const dateStr = formatUtcDate(activity.finishedOn);
    return {
      id: `finished:${activity.id}`,
      type: 'finished',
      date: dateStr,
      book: {
        id: activity.book.id,
        title: activity.book.title,
        author: activity.book.author,
        coverImageUrl: activity.book.coverImageUrl,
      },
    };
  });

  // Deterministic sorting:
  // 1. date ASC
  // 2. type ASC ('finished' < 'release')
  // 3. id ASC
  const allEvents = [...releaseEvents, ...finishedEvents].sort((a, b) => {
    const dateComp = a.date.localeCompare(b.date);
    if (dateComp !== 0) return dateComp;
    const typeComp = a.type.localeCompare(b.type);
    if (typeComp !== 0) return typeComp;
    return a.id.localeCompare(b.id);
  });

  return {
    range: {
      from,
      to,
    },
    events: allEvents,
  };
}
