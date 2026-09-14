import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/lib/prisma.js';
import { serializePublicationDate } from '../src/services/books.js';

export async function checkReleaseDataReadiness(db = prisma) {
  const targetYears = [2022, 2023, 2024, 2025, 2026, 2027];

  const total = await db.book.count();

  const publicationYearCounts = {};
  for (const year of targetYears) {
    publicationYearCounts[year] = await db.book.count({
      where: { publicationYear: year },
    });
  }

  const publicationYearNull = await db.book.count({
    where: { publicationYear: null },
  });

  const latestBook = await db.book.findFirst({
    where: { publicationYear: { not: null } },
    orderBy: { publicationYear: 'desc' },
    select: { publicationYear: true },
  });
  const latestPublicationYear = latestBook?.publicationYear ?? null;

  let publicationDateNonNull = 0;
  let recentCount = 0;
  let upcomingCount = 0;
  let hasPublicationDateColumn = true;

  try {
    publicationDateNonNull = await db.book.count({
      where: { publicationDate: { not: null } },
    });

    recentCount = await db.book.count({
      where: {
        publicationDate: {
          gte: new Date('2026-06-15T00:00:00.000Z'),
          lte: new Date('2026-09-15T23:59:59.999Z'),
        },
      },
    });

    upcomingCount = await db.book.count({
      where: {
        publicationDate: {
          gt: new Date('2026-09-15T23:59:59.999Z'),
        },
      },
    });
  } catch (err) {
    if (err?.meta?.driverAdapterError?.cause?.originalCode === '42703' || err?.code === 'P2022') {
      hasPublicationDateColumn = false;
    } else {
      throw err;
    }
  }

  let top30Raw;
  if (hasPublicationDateColumn) {
    top30Raw = await db.book.findMany({
      where: { publicationYear: { not: null } },
      orderBy: [
        { publicationYear: 'desc' },
        { title: 'asc' },
      ],
      take: 30,
      select: {
        title: true,
        author: true,
        isbn: true,
        publicationYear: true,
        publicationDate: true,
      },
    });
  } else {
    top30Raw = await db.book.findMany({
      where: { publicationYear: { not: null } },
      orderBy: [
        { publicationYear: 'desc' },
        { title: 'asc' },
      ],
      take: 30,
      select: {
        title: true,
        author: true,
        isbn: true,
        publicationYear: true,
      },
    });
  }

  const top30 = top30Raw.map(b => ({
    title: b.title,
    author: b.author,
    isbn: b.isbn ?? null,
    publicationYear: b.publicationYear,
    publicationDate: serializePublicationDate(b.publicationDate),
  }));

  return {
    totalBooks: total,
    publicationYearCounts,
    publicationYearNull,
    latestPublicationYear,
    publicationDateNonNull,
    recentCount,
    upcomingCount,
    top30,
  };
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  try {
    const summary = await checkReleaseDataReadiness(prisma);
    console.log('=== RELEASE DATA READINESS START ===\n');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\n=== RELEASE DATA READINESS END ===');
  } catch (error) {
    console.error('Failed to run release data readiness check:', error?.message || error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}