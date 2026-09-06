import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './hooks/useAuth.js';
import { Loading, EmptyState } from './components/shared.jsx';
import Layout from './components/Layout.jsx';
import Discover from './pages/Discover.jsx';
import BookDetails from './pages/BookDetails.jsx';
import MyBooks from './pages/MyBooks.jsx';
import AuthPage from './pages/AuthPage.jsx';

function RequireAuth({ children }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'restoring') return <div className="container page-space"><Loading /></div>;
  if (!auth.user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

export default function App() {
  return <BrowserRouter><Routes><Route element={<Layout />}><Route index element={<Discover />} /><Route path="books/:id" element={<BookDetails />} /><Route path="my-books" element={<RequireAuth><MyBooks /></RequireAuth>} /><Route path="login" element={<AuthPage key="login" />} /><Route path="signup" element={<AuthPage key="signup" signup />} /><Route path="*" element={<div className="container"><EmptyState title="This page has turned">Use Discover to find your way back to the books.</EmptyState></div>} /></Route></Routes></BrowserRouter>;
}
