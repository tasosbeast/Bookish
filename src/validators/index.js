import { z } from 'zod';

const uuid = z.string().uuid();
const rating = z.number().int().min(1).max(5);
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).refine(v => Buffer.byteLength(v, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes');
const pagination = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const signupSchema = z.object({ body: z.object({
  username: z.string().trim().toLowerCase().min(3).max(30).regex(/^[a-z0-9_]+$/),
  email, password,
}).strict() });
export const loginSchema = z.object({ body: z.object({ email, password }).strict() });
export const booksSchema = z.object({ query: z.object({
  ...pagination,
  genre: z.string().trim().min(1).max(100).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  author: z.string().trim().min(1).max(200).optional(),
  sort: z.enum(['rating', 'publicationYear']).default('rating'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict() });
export const bookSchema = z.object({ params: z.object({ id: uuid }), query: z.object(pagination).strict() });
export const shelvesQuerySchema = z.object({ query: z.object({
  ...pagination,
  status: z.enum(['want_to_read', 'currently_reading', 'read']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
}).strict() });
export const shelfSchema = z.object({ body: z.object({
  bookId: uuid,
  status: z.enum(['want_to_read', 'currently_reading', 'read']).optional(),
  userRating: rating.nullable().optional(),
}).strict().refine(v => v.status !== undefined || v.userRating !== undefined, 'Provide status or userRating') });
export const reviewSchema = z.object({ body: z.object({
  bookId: uuid, rating, reviewText: z.string().trim().max(10000).nullable().optional(),
}).strict() });
export const likeSchema = z.object({ params: z.object({ id: uuid }) });
export const personalBookSchema = z.object({ params: z.object({ bookId: uuid }), query: z.object({}).strict() });
export const removeShelfSchema = z.object({ params: z.object({ bookId: uuid }), query: z.object({ deleteReview: z.enum(['true', 'false']).optional() }).strict() });

const bioSchema = z.union([
  z.string().transform(s => s.trim()).pipe(z.string().max(500)).transform(s => (s === '' ? null : s)),
  z.null(),
]).optional();

const profilePictureSchema = z.union([
  z.string()
    .transform(s => s.trim())
    .pipe(z.string().max(2048))
    .transform(s => (s === '' ? null : s))
    .refine(
      val => {
        if (val === null) return true;
        try {
          const url = new URL(val);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'Must be a valid http:// or https:// URL' }
    ),
  z.null(),
]).optional();

export const updateProfileSchema = z.object({
  body: z.object({
    bio: bioSchema,
    profilePicture: profilePictureSchema,
  }).strict().refine(data => data.bio !== undefined || data.profilePicture !== undefined, 'Provide at least one editable field'),
});

