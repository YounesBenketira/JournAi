import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import SyncCard from '../src/components/settings/SyncCard';
import SharedTodos from '../src/components/calendar/SharedTodos';
import '../src/App.css';
import '../src/styles/calendar.css';

createRoot(document.getElementById('root')!).render(<ThemeProvider>
  <main style={{ maxWidth: 640, margin: '24px auto', padding: 16, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'system-ui' }}>
    <SyncCard /><SharedTodos date="2026-10-23" />
  </main>
</ThemeProvider>);
