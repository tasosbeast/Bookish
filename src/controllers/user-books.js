import { saveShelf } from '../services/ratings.js';
import { listShelves } from '../services/user-books.js';
export async function list(req, res) {
  res.set('Cache-Control', 'no-store').json(await listShelves(req.auth.userId, req.validated.query));
}
export async function save(req, res) { res.json({ data: await saveShelf(req.auth.userId, req.validated.body) }); }
