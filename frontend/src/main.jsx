import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { session } from './lib/api.js';
import './styles.css';

void session.initialize();
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
