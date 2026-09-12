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

  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const fetchSeqRef = useRef(0);
  const abortControllerRef = useRef(null);

  const fetchNotifications = async () => {
    const currentUserId = userIdRef.current;
    if (!currentUserId) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const seq = ++fetchSeqRef.current;

    try {
      setError(null);
      const res = await api('/notifications?limit=10', { auth: 'required', signal: controller.signal });
      if (fetchSeqRef.current === seq && userIdRef.current === currentUserId) {
        setNotificationsData(res);
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // Background fetch errors ignored silently
    }
  };

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setOpen(false);
    setNotificationsData({ data: [], unreadCount: 0 });
    setError(null);
    if (userId) {
      fetchNotifications();
    }
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
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
    const currentUserId = userIdRef.current;
    try {
      setError(null);
      await api('/notifications/read-all', { method: 'PUT', auth: 'required' });
      if (userIdRef.current === currentUserId) {
        setNotificationsData(prev => ({
          unreadCount: 0,
          data: prev.data.map(item => ({ ...item, readAt: item.readAt || new Date().toISOString() }))
        }));
      }
    } catch (err) {
      if (userIdRef.current === currentUserId) {
        setError(err);
      }
    }
  };

  const handleItemClick = (item) => {
    const currentUserId = userIdRef.current;
    if (!item.readAt) {
      api(`/notifications/${item.id}/read`, { method: 'PUT', auth: 'required' }).catch(() => {});
      if (userIdRef.current === currentUserId) {
        setNotificationsData(prev => ({
          unreadCount: Math.max(0, prev.unreadCount - 1),
          data: prev.data.map(n => n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)
        }));
      }
    }
    setOpen(false);
    if (item.type === 'friend_request') {
      navigate('/friends?tab=requests');
    } else {
      navigate(`/books/${item.review.bookId}?reviewId=${item.review.id}#review-${item.review.id}`, {
        state: { jump: Date.now() }
      });
    }
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
                        {item.type === 'friend_request' ? (
                          <>
                            <strong>{actorName}</strong> sent you a friend request
                          </>
                        ) : (
                          <>
                            <strong>{actorName}</strong> liked your review of <em>{bookTitle}</em>
                          </>
                        )}
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
