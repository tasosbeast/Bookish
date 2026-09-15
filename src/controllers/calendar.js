import { getCalendarEvents } from '../services/calendar.js';

export async function getCalendar(req, res) {
  const { from, to } = req.validated.query;
  const result = await getCalendarEvents({ userId: req.auth.userId, from, to });
  res.json(result);
}
