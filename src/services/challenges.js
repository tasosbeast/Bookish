import { prisma } from '../lib/prisma.js';

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const CHALLENGE_GOAL = 3;

/**
 * Returns UTC calendar month boundaries [start, end) for a given date.
 */
export function getUtcMonthBounds(date = new Date()) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const periodStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  const key = `${year}-${String(month + 1).padStart(2, '0')}`;
  const title = `${MONTH_NAMES[month]} ${year} Reading Challenge`;
  return { year, month, key, title, periodStart, periodEnd };
}

function getActivityFinishedDate(act) {
  if (act.finishedOn) {
    if (act.finishedOn instanceof Date) {
      return act.finishedOn.toISOString().slice(0, 10);
    }
    return String(act.finishedOn).slice(0, 10);
  }
  return null;
}

function getActivityFinishedIso(act) {
  if (act.finishedOn) {
    const dateStr = act.finishedOn instanceof Date
      ? act.finishedOn.toISOString().slice(0, 10)
      : String(act.finishedOn).slice(0, 10);
    return `${dateStr}T00:00:00.000Z`;
  }
  return null;
}

function compareActivities(a, b) {
  const dateA = getActivityFinishedDate(a) || '';
  const dateB = getActivityFinishedDate(b) || '';
  if (dateA !== dateB) {
    return dateA.localeCompare(dateB);
  }
  const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (createdA !== createdB) {
    return createdA - createdB;
  }
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * Computes challenge progress and qualifying books from chronological finished_reading activities.
 *
 * @param {Array<{ id?: string, bookId: string, createdAt?: Date|string, finishedOn?: Date|string, book?: object }>} activities
 * @param {number} goal
 */
export function calculateChallengeProgress(activities, goal = CHALLENGE_GOAL) {
  const sorted = activities.slice().sort(compareActivities);
  const seenBookIds = new Set();
  const qualifyingBooks = [];
  let completedAt = null;

  for (const act of sorted) {
    const finishedAtIso = getActivityFinishedIso(act);
    if (!finishedAtIso) continue;
    if (!seenBookIds.has(act.bookId)) {
      seenBookIds.add(act.bookId);
      if (act.book) {
        qualifyingBooks.push({
          id: act.book.id,
          title: act.book.title,
          author: act.book.author,
          coverImageUrl: act.book.coverImageUrl,
          finishedAt: finishedAtIso,
        });
      } else {
        qualifyingBooks.push({
          id: act.bookId,
          finishedAt: finishedAtIso,
        });
      }
      if (qualifyingBooks.length === goal) {
        completedAt = finishedAtIso;
      }
    }
  }

  const progress = qualifyingBooks.length;
  const completed = progress >= goal;
  const sortedBooks = qualifyingBooks.slice().reverse();

  return {
    progress,
    completed,
    completedAt,
    books: sortedBooks,
  };
}

/**
 * Derives earned monthly challenge trophies from chronological finished_reading activities.
 *
 * @param {Array<{ id?: string, bookId: string, createdAt?: Date|string, finishedOn?: Date|string }>} activities
 * @param {number} goal
 */
export function deriveTrophies(activities, goal = CHALLENGE_GOAL) {
  const sorted = activities.slice().sort(compareActivities);
  const monthMap = new Map(); // key -> { year, month, seenBooks: Set(), completedAt: null }

  for (const act of sorted) {
    const dateStr = getActivityFinishedDate(act);
    if (!dateStr) continue;
    const [year, monthNum] = dateStr.split('-').map(Number);
    const month = monthNum - 1; // 0-indexed
    const key = `${year}-${String(monthNum).padStart(2, '0')}`;

    if (!monthMap.has(key)) {
      monthMap.set(key, {
        year,
        month,
        seenBooks: new Set(),
        completedAt: null,
      });
    }

    const monthData = monthMap.get(key);
    if (!monthData.seenBooks.has(act.bookId)) {
      monthData.seenBooks.add(act.bookId);
      if (monthData.seenBooks.size === goal) {
        monthData.completedAt = getActivityFinishedIso(act);
      }
    }
  }

  const trophies = [];
  for (const [key, data] of monthMap.entries()) {
    if (data.seenBooks.size >= goal) {
      trophies.push({
        key,
        title: `${MONTH_NAMES[data.month]} ${data.year} Reading Challenge`,
        goal,
        completedAt: data.completedAt,
        booksRead: data.seenBooks.size,
      });
    }
  }

  // Sort newest month first (e.g. "2026-10" before "2026-09")
  trophies.sort((a, b) => b.key.localeCompare(a.key));

  return trophies;
}

/**
 * Gets the current month reading challenge and progress for a user.
 */
export async function getCurrentChallenge(userId, now = new Date()) {
  const { key, title, periodStart, periodEnd } = getUtcMonthBounds(now);

  const activities = await prisma.activity.findMany({
    where: {
      userId,
      type: 'finished_reading',
      finishedOn: {
        gte: periodStart,
        lt: periodEnd,
      },
    },
    select: {
      id: true,
      bookId: true,
      createdAt: true,
      finishedOn: true,
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
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  });

  const { progress, completed, completedAt, books } = calculateChallengeProgress(activities, CHALLENGE_GOAL);

  return {
    data: {
      key,
      title,
      description: 'Finish 3 different books this month.',
      goal: CHALLENGE_GOAL,
      progress,
      completed,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      completedAt,
      books,
    },
  };
}

/**
 * Gets all completed monthly challenge trophies for a user, newest month first.
 */
export async function getUserTrophies(userId) {
  const activities = await prisma.activity.findMany({
    where: {
      userId,
      type: 'finished_reading',
      finishedOn: { not: null },
    },
    select: {
      id: true,
      bookId: true,
      createdAt: true,
      finishedOn: true,
    },
    orderBy: [
      { finishedOn: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  });

  const trophies = deriveTrophies(activities, CHALLENGE_GOAL);

  return {
    data: trophies,
  };
}
