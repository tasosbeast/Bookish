import { prisma } from '../lib/prisma.js';
import { genres, serializeBook } from './books.js';

export async function getTopPicks(userId, limit = 6) {
  const ratedUserBooks = await prisma.userBook.findMany({
    where: { userId, userRating: { not: null } },
    include: { book: { include: genres } },
  });

  const ratedBooks = ratedUserBooks.length;
  if (ratedBooks < 3) {
    return {
      data: [],
      meta: {
        personalized: false,
        ratedBooks,
        minimumRatings: 3,
      },
    };
  }

  const genreAffinityByGenreId = {};
  const authorAffinityByNormalizedAuthor = {};

  for (const ub of ratedUserBooks) {
    const rating = ub.userRating;
    const genrePts = rating === 5 ? 2 : rating === 4 ? 1 : 0;
    const authorPts = rating === 5 ? 3 : rating === 4 ? 2 : rating === 3 ? 0 : rating === 2 ? -2 : rating === 1 ? -3 : 0;

    if (genrePts > 0) {
      for (const bg of ub.book.bookGenres) {
        const gId = bg.genre.id;
        genreAffinityByGenreId[gId] = (genreAffinityByGenreId[gId] || 0) + genrePts;
      }
    }

    const normAuthor = ub.book.author.trim().toLowerCase();
    authorAffinityByNormalizedAuthor[normAuthor] = (authorAffinityByNormalizedAuthor[normAuthor] || 0) + authorPts;
  }

  const allUserBooks = await prisma.userBook.findMany({
    where: { userId },
    select: { bookId: true },
  });
  const excludedBookIds = new Set(allUserBooks.map(ub => ub.bookId));

  const candidateBooks = await prisma.book.findMany({
    where: {
      id: { notIn: Array.from(excludedBookIds) },
    },
    include: genres,
  });

  const scoredCandidates = [];

  for (const book of candidateBooks) {
    const normAuthor = book.author.trim().toLowerCase();
    const authorScore = authorAffinityByNormalizedAuthor[normAuthor] || 0;

    let genreAffinity = 0;
    let highestGenrePts = -1;
    let winningGenreName = null;

    for (const bg of book.bookGenres) {
      const pts = genreAffinityByGenreId[bg.genre.id] || 0;
      genreAffinity += pts;
      if (pts > 0) {
        if (pts > highestGenrePts || (pts === highestGenrePts && (!winningGenreName || bg.genre.name < winningGenreName))) {
          highestGenrePts = pts;
          winningGenreName = bg.genre.name;
        }
      }
    }

    const personalizationScore = genreAffinity + authorScore;
    if (personalizationScore <= 0) {
      continue;
    }

    scoredCandidates.push({
      book,
      personalizationScore,
      authorScore,
      winningGenreName,
    });
  }

  scoredCandidates.sort((a, b) => {
    if (b.personalizationScore !== a.personalizationScore) {
      return b.personalizationScore - a.personalizationScore;
    }
    if (b.book.ratingsCount !== a.book.ratingsCount) {
      return b.book.ratingsCount - a.book.ratingsCount;
    }
    const avgA = a.book.averageRating === null ? -Infinity : Number(a.book.averageRating);
    const avgB = b.book.averageRating === null ? -Infinity : Number(b.book.averageRating);
    if (avgB !== avgA) {
      return avgB - avgA;
    }
    const yearA = a.book.publicationYear === null ? -Infinity : a.book.publicationYear;
    const yearB = b.book.publicationYear === null ? -Infinity : b.book.publicationYear;
    if (yearB !== yearA) {
      return yearB - yearA;
    }
    return a.book.id.localeCompare(b.book.id);
  });

  const authorCounts = {};
  const recommendations = [];

  for (const item of scoredCandidates) {
    const normAuthor = item.book.author.trim().toLowerCase();
    const count = authorCounts[normAuthor] || 0;
    if (count >= 2) {
      continue;
    }
    authorCounts[normAuthor] = count + 1;

    let reason;
    if (item.authorScore > 0) {
      reason = { type: 'author', label: item.book.author };
    } else {
      reason = { type: 'genre', label: item.winningGenreName };
    }

    recommendations.push({
      ...serializeBook(item.book),
      reason,
    });

    if (recommendations.length >= limit) {
      break;
    }
  }

  return {
    data: recommendations,
    meta: {
      personalized: true,
      ratedBooks,
      minimumRatings: 3,
    },
  };
}
