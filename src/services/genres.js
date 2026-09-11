import { prisma } from '../lib/prisma.js';

export async function listGenres() {
  const genres = await prisma.genre.findMany({
    where: { bookGenres: { some: {} } },
    select: { id: true, name: true, slug: true },
    orderBy: [{ name: 'asc' }, { slug: 'asc' }],
  });
  return { data: genres };
}
