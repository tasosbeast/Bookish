import { listGenres } from '../services/genres.js';

export async function list(req, res) {
  res.json(await listGenres());
}
