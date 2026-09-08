import { removeShelf, saveShelf } from '../services/ratings.js';
import { listShelves, personalBook } from '../services/user-books.js';
export async function detail(req, res) {
  res.set('Cache-Control', 'no-store').json(await personalBook(req.auth.userId, req.validated.params.bookId));
}
export async function list(req, res) {
  res.set('Cache-Control', 'no-store').json(await listShelves(req.auth.userId, req.validated.query));
}
export async function save(req, res) { res.json({ data: await saveShelf(req.auth.userId, req.validated.body) }); }
export async function remove(req, res) { res.json({ data: await removeShelf(req.auth.userId, req.validated.params.bookId) }); }
