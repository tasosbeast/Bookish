import { listBooks, bookDetails } from '../services/books.js';
export async function list(req, res) { res.json(await listBooks(req.validated.query)); }
export async function detail(req, res) {
  res.set('Cache-Control', 'no-store');
  res.vary('Authorization');
  res.json(await bookDetails(req.validated.params.id, req.validated.query, req.auth?.userId));
}
