import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../hooks/useResource.js';
import { Icon, ErrorNotice, Loading } from '../components/shared.jsx';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function getLocalCurrentMonthString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function getLocalTodayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseMonthParam(param) {
  if (typeof param === 'string' && /^\d{4}-\d{2}$/.test(param)) {
    const [y, m] = param.split('-').map(Number);
    if (m >= 1 && m <= 12 && y >= 1900 && y <= 2100) {
      return { year: y, month: m, str: param };
    }
  }
  const current = getLocalCurrentMonthString();
  const [y, m] = current.split('-').map(Number);
  return { year: y, month: m, str: current };
}

export function getAdjacentMonth(year, month, delta) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function computeMonthGrid(year, month) {
  const d1 = new Date(Date.UTC(year, month - 1, 1));
  const mondayOffset = (d1.getUTCDay() + 6) % 7; // 0 for Monday, 6 for Sunday
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(Date.UTC(year, month - 1, 1 - mondayOffset + i));
    const y = cellDate.getUTCFullYear();
    const m = cellDate.getUTCMonth() + 1;
    const d = cellDate.getUTCDate();
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isCurrentMonth = y === year && m === month;
    cells.push({
      dateStr,
      dayNumber: d,
      isCurrentMonth,
      year: y,
      month: m,
    });
  }
  const from = cells[0].dateStr;
  const to = cells[41].dateStr;
  return { cells, from, to };
}

export function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const monthName = MONTH_NAMES[m - 1];
  return `${monthName} ${d}, ${y}`;
}

export default function Calendar() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawMonth = searchParams.get('month');
  const parsedMonth = useMemo(() => parseMonthParam(rawMonth), [rawMonth]);

  const [selectedDate, setSelectedDate] = useState(null);

  useEffect(() => {
    setSelectedDate(null);
  }, [parsedMonth.str]);

  const { cells, from, to } = useMemo(
    () => computeMonthGrid(parsedMonth.year, parsedMonth.month),
    [parsedMonth.year, parsedMonth.month]
  );

  const resource = useResource(`/calendar?from=${from}&to=${to}`, 'required');
  const todayStr = getLocalTodayString();

  const eventsByDate = useMemo(() => {
    const map = new Map();
    if (resource.data?.events) {
      for (const event of resource.data.events) {
        if (!map.has(event.date)) map.set(event.date, []);
        map.get(event.date).push(event);
      }
    }
    return map;
  }, [resource.data?.events]);

  function goToMonth(monthStr) {
    setSearchParams({ month: monthStr });
  }

  const selectedEvents = selectedDate ? eventsByDate.get(selectedDate) || [] : [];
  const selectedReleases = selectedEvents.filter(e => e.type === 'release');
  const selectedFinished = selectedEvents.filter(e => e.type === 'finished');

  return (
    <div className="container calendar-page">
      <header className="calendar-page-header">
        <div>
          <p className="eyebrow">Reading Schedule</p>
          <h1>Calendar</h1>
          <p className="calendar-subtitle">Your reading life, one month at a time.</p>
        </div>
        <div className="calendar-legend" aria-label="Calendar legend">
          <span className="legend-item legend-release">
            <Icon name="book" size={13} />
            <span>Book release</span>
          </span>
          <span className="legend-item legend-finished">
            <Icon name="check" size={13} />
            <span>Finished reading</span>
          </span>
        </div>
      </header>

      {resource.error && (
        <ErrorNotice error={resource.error} retry={resource.reload} />
      )}

      <div className="calendar-controls">
        <div className="calendar-nav-group">
          <button
            type="button"
            className="button secondary compact"
            aria-label="Previous month"
            onClick={() => goToMonth(getAdjacentMonth(parsedMonth.year, parsedMonth.month, -1))}
          >
            Previous
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label="Current month"
            onClick={() => goToMonth(getLocalCurrentMonthString())}
          >
            Today
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label="Next month"
            onClick={() => goToMonth(getAdjacentMonth(parsedMonth.year, parsedMonth.month, 1))}
          >
            Next
          </button>
        </div>

        <h2 className="calendar-month-title" aria-live="polite">
          {MONTH_NAMES[parsedMonth.month - 1]} {parsedMonth.year}
        </h2>
      </div>

      <div className="calendar-wrapper">
        {resource.loading && !resource.data && (
          <div className="calendar-loading-overlay">
            <Loading />
          </div>
        )}

        <div className="calendar-grid" role="grid" aria-label={`${MONTH_NAMES[parsedMonth.month - 1]} ${parsedMonth.year}`}>
          <div className="calendar-weekdays-row" role="row">
            {WEEKDAYS.map(day => (
              <div key={day} className="calendar-weekday-header" role="columnheader">
                {day}
              </div>
            ))}
          </div>

          <div className="calendar-cells-grid">
            {cells.map(cell => {
              const dayEvents = eventsByDate.get(cell.dateStr) || [];
              const visibleEvents = dayEvents.slice(0, 2);
              const overflowCount = Math.max(0, dayEvents.length - 2);
              const isToday = cell.dateStr === todayStr;
              const isSelected = cell.dateStr === selectedDate;

              return (
                <div
                  key={cell.dateStr}
                  className={`calendar-cell${cell.isCurrentMonth ? '' : ' outside-month'}${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`}
                  role="gridcell"
                  tabIndex={0}
                  aria-label={`${cell.dateStr}: ${dayEvents.length} events`}
                  onClick={() => setSelectedDate(cell.dateStr)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedDate(cell.dateStr);
                    }
                  }}
                >
                  <div className="calendar-cell-header">
                    <span className={`calendar-day-number${isToday ? ' today-badge' : ''}`}>
                      {cell.dayNumber}
                    </span>
                  </div>

                  <div className="calendar-cell-events">
                    {visibleEvents.map(event => (
                      <Link
                        key={event.id}
                        to={`/books/${event.book.id}`}
                        className={`calendar-event-badge event-${event.type}`}
                        aria-label={`${event.type === 'release' ? 'Release' : 'Finished'}: ${event.book.title}`}
                        onClick={e => e.stopPropagation()}
                      >
                        <Icon name={event.type === 'release' ? 'book' : 'check'} size={12} />
                        <span className="calendar-event-title">{event.book.title}</span>
                      </Link>
                    ))}

                    {overflowCount > 0 && (
                      <button
                        type="button"
                        className="calendar-more-button text-button"
                        aria-label={`View ${dayEvents.length} events on ${cell.dateStr}`}
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedDate(cell.dateStr);
                        }}
                      >
                        +{overflowCount} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selectedDate && (
        <section className="calendar-day-details" aria-labelledby="selected-day-heading">
          <div className="day-details-header">
            <div>
              <p className="eyebrow">Selected date</p>
              <h3 id="selected-day-heading">{formatDisplayDate(selectedDate)}</h3>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => setSelectedDate(null)}
            >
              Close details
            </button>
          </div>

          {selectedEvents.length === 0 ? (
            <p className="muted small">No events recorded on this date.</p>
          ) : (
            <div className="day-details-content">
              {selectedReleases.length > 0 && (
                <div className="day-details-group">
                  <h4>Book releases ({selectedReleases.length})</h4>
                  <ul className="day-events-list">
                    {selectedReleases.map(event => (
                      <li key={event.id} className="day-event-item">
                        <Icon name="book" size={16} />
                        <div className="day-event-info">
                          <Link to={`/books/${event.book.id}`} className="day-event-book-title">
                            {event.book.title}
                          </Link>
                          <span className="day-event-author">by {event.book.author}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedFinished.length > 0 && (
                <div className="day-details-group">
                  <h4>Finished reading ({selectedFinished.length})</h4>
                  <ul className="day-events-list">
                    {selectedFinished.map(event => (
                      <li key={event.id} className="day-event-item">
                        <Icon name="check" size={16} />
                        <div className="day-event-info">
                          <Link to={`/books/${event.book.id}`} className="day-event-book-title">
                            {event.book.title}
                          </Link>
                          <span className="day-event-author">by {event.book.author}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
