import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Icon } from './shared.jsx';

export function NotificationBell({ userId }) {
  const [open, setOpen] = useState(false);
  const [notificationsData, setNotificationsData] = useState({ data: [], unreadCount: 0 });
  const [error, setError] = useState(null);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  const fetchNotifications = async () => {
    try {
      setError(null);
      const res = await api('/notifications?limit=10', { auth: 'required' });
      setNotificationsData(res);
    } catch {
      // Background fetch errors ignored silently
    }
  };

  useEffect(() => {
    setOpen(false);
    setNotificationsData({ data: [], unreadCount: 0 });
    setError(null);
    if (userId) {
      fetchNotifications();
    }
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      fetchNotifications();
    }
    setOpen(prev => !prev);
  };

  const handleMarkAllRead = async () => {
    try {
      setError(null);
      await api('/notifications/read-all', { method: 'PUT', auth: 'required' });
      setNotificationsData(prev => ({
        unreadCount: 0,
        data: prev.data.map(item => ({ ...item, readAt: item.readAt || new Date().toISOString() }))
      }));
    } catch (err) {
      setError(err);
    }
  };

  const handleItemClick = (item) => {
    if (!item.readAt) {
      api(`/notifications/${item.id}/read`, { method: 'PUT', auth: 'required' }).catch(() => {});
      setNotificationsData(prev => ({
        unreadCount: Math.max(0, prev.unreadCount - 1),
        data: prev.data.map(n => n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)
      }));
    }
    setOpen(false);
    navigate(`/books/${item.review.bookId}#review`);
  };

  const unreadCount = notificationsData.unreadCount;
  const badgeText = unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount.toString()) : null;

  return (
    <div className="notification-bell-container" ref={dropdownRef}>
      <button
        type="button"
        className="bell-button"
        aria-label="Notifications"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={toggle}
      >
        <Icon name="bell" size={20} />
        {badgeText && <span className="unread-badge">{badgeText}</span>}
      </button>

      {open && (
        <div className="notification-dropdown" role="dialog" aria-label="Notifications">
          <div className="notification-header">
            <h3>Notifications</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                className="text-button small-action"
                onClick={handleMarkAllRead}
              >
                Mark all as read
              </button>
            )}
          </div>

          {error && (
            <div className="notification-error" role="alert">
              Failed to mark notifications as read.
            </div>
          )}

          <div className="notification-list">
            {notificationsData.data.length === 0 ? (
              <p className="notification-empty">No notifications yet.</p>
            ) : (
              notificationsData.data.map(item => {
                const isUnread = !item.readAt;
                const bookTitle = item.review?.book?.title ?? 'a book';
                const actorName = item.actor?.username ?? 'Someone';
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`notification-item ${isUnread ? 'unread' : ''}`}
                    onClick={() => handleItemClick(item)}
                  >
                    <span className="avatar notification-avatar">
                      {actorName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="notification-content">
                      <p className="notification-text">
                        <strong>{actorName}</strong> liked your review of <em>{bookTitle}</em>
                      </p>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </time>
                    </div>
                    {isUnread && <span className="unread-dot" aria-hidden="true" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
