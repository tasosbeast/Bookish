import { listBooks, bookDetails } from '../services/books.js';
export async function list(req, res) { res.json(await listBooks(req.validated.query)); }
export async function detail(req, res) { res.json(await bookDetails(req.validated.params.id, req.validated.query)); }
