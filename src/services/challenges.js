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

/**
 * Computes challenge progress and qualifying books from chronological finished_reading activities.
 *
 * @param {Array<{ bookId: string, createdAt: Date|string, book?: object }>} activities
 * @param {number} goal
 */
export function calculateChallengeProgress(activities, goal = CHALLENGE_GOAL) {
  const seenBookIds = new Set();
  const qualifyingBooks = [];
  let completedAt = null;

  for (const act of activities) {
    if (!seenBookIds.has(act.bookId)) {
      seenBookIds.add(act.bookId);
      const createdAtIso = act.createdAt instanceof Date ? act.createdAt.toISOString() : new Date(act.createdAt).toISOString();
      if (act.book) {
        qualifyingBooks.push({
          id: act.book.id,
          title: act.book.title,
          author: act.book.author,
          coverImageUrl: act.book.coverImageUrl,
          finishedAt: createdAtIso,
        });
      } else {
        qualifyingBooks.push({
          id: act.bookId,
          finishedAt: createdAtIso,
        });
      }
      if (qualifyingBooks.length === goal) {
        completedAt = createdAtIso;
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
 * @param {Array<{ bookId: string, createdAt: Date|string }>} activities
 * @param {number} goal
 */
export function deriveTrophies(activities, goal = CHALLENGE_GOAL) {
  const monthMap = new Map(); // key -> { month, seenBooks: Set(), completedAt: null }

  for (const act of activities) {
    const d = act.createdAt instanceof Date ? act.createdAt : new Date(act.createdAt);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;

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
        monthData.completedAt = d.toISOString();
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
      createdAt: {
        gte: periodStart,
        lt: periodEnd,
      },
    },
    select: {
      bookId: true,
      createdAt: true,
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
    },
    select: {
      bookId: true,
      createdAt: true,
    },
    orderBy: [
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
  });

  const trophies = deriveTrophies(activities, CHALLENGE_GOAL);

  return {
    data: trophies,
  };
}
