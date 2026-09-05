import { saveShelf } from '../services/ratings.js';
export async function save(req, res) { res.json({ data: await saveShelf(req.auth.userId, req.validated.body) }); }
