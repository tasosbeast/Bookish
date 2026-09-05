import { PrismaPg } from '@prisma/adapter-pg';
import generated from '../generated/prisma/index.js';
import { env } from '../config/env.js';

export const { Prisma } = generated;
export const prisma = new generated.PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 10 }),
});
