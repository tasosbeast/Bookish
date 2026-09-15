import { Link } from 'react-router-dom';
import { Cover, Rating, Genres, Icon } from './shared.jsx';

export function formatReleaseDate(dateString, type = 'new') {
  if (!dateString) return '';
  const [year, month, day] = dateString.slice(0, 10).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[month - 1];
  const prefix = type === 'upcoming' ? 'Coming' : 'Released';
  return `${prefix} ${monthName} ${day}, ${year}`;
}

export function ReleaseCard({ book, type = 'new', onSelectAuthor, onSelectGenre }) {
  return (
    <article className="book-card" key={book.id}>
      <Link to={`/books/${book.id}`} className="cover-link" aria-label={`Read about ${book.title}`}>
        <Cover book={book} />
        <span className="cover-open"><Icon name="arrow" /></span>
      </Link>
      <div className="book-card-meta">
        <span className="release-date">{formatReleaseDate(book.publicationDate, type)}</span>
        <Rating value={book.averageRating} />
        <h3><Link to={`/books/${book.id}`}>{book.title}</Link></h3>
        <p className="author-name">
          {onSelectAuthor ? (
            <button type="button" className="author-filter" onClick={() => onSelectAuthor(book.author)}>
              {book.author}
            </button>
          ) : (
            book.author
          )}
        </p>
        <Genres genres={book.genres} onSelect={onSelectGenre} />
      </div>
    </article>
  );
}
