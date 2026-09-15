import { prisma } from '../lib/prisma.js';
import { genres, serializeBook } from './books.js';

export function getUtcTodayString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function calculateReleaseWindows(asOf = getUtcTodayString()) {
  const [year, month, day] = asOf.split('-').map(Number);
  const asOfDate = new Date(Date.UTC(year, month - 1, day));
  const fromNewDate = new Date(Date.UTC(year, month - 1, day - 90));
  const toUpcomingDate = new Date(Date.UTC(year, month - 1, day + 180));

  const fromNew = fromNewDate.toISOString().slice(0, 10);
  const toNew = asOf;
  const fromUpcomingExclusive = asOf;
  const toUpcoming = toUpcomingDate.toISOString().slice(0, 10);

  return {
    asOf,
    windows: {
      newReleases: {
        from: fromNew,
        to: toNew,
      },
      upcoming: {
        fromExclusive: fromUpcomingExclusive,
        to: toUpcoming,
      },
    },
    dates: {
      newReleases: {
        gte: fromNewDate,
        lte: asOfDate,
      },
      upcoming: {
        gt: asOfDate,
        lte: toUpcomingDate,
      },
    },
  };
}

export async function getReleases({ limit = 24, asOf = getUtcTodayString() } = {}) {
  const effectiveLimit = Math.min(50, Math.max(1, Number(limit) || 24));
  const { asOf: resolvedAsOf, windows, dates } = calculateReleaseWindows(asOf);

  const [newReleases, upcoming] = await prisma.$transaction([
    prisma.book.findMany({
      where: {
        publicationDate: {
          gte: dates.newReleases.gte,
          lte: dates.newReleases.lte,
        },
      },
      include: genres,
      orderBy: [
        { publicationDate: 'desc' },
        { id: 'asc' },
      ],
      take: effectiveLimit,
    }),
    prisma.book.findMany({
      where: {
        publicationDate: {
          gt: dates.upcoming.gt,
          lte: dates.upcoming.lte,
        },
      },
      include: genres,
      orderBy: [
        { publicationDate: 'asc' },
        { id: 'asc' },
      ],
      take: effectiveLimit,
    }),
  ], { isolationLevel: 'RepeatableRead' });

  return {
    asOf: resolvedAsOf,
    windows,
    newReleases: newReleases.map(serializeBook),
    upcoming: upcoming.map(serializeBook),
  };
}
