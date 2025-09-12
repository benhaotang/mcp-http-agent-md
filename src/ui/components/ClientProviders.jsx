"use client";
import { ApiKeyProvider } from './ApiKeyContext';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Toaster } from 'react-hot-toast';

const ThemeContext = createContext({ theme:'system', resolved:'dark', setTheme:()=>{} });

export function useTheme() { return useContext(ThemeContext); }

function resolve(themePref) {
  if (themePref === 'light') return 'light';
  if (themePref === 'dark') return 'dark';
  if (typeof window !== 'undefined') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light';
  }
  return 'dark';
}

export default function ClientProviders({ children }) {
  const [theme, setTheme] = useState('system');
  const [resolved, setResolved] = useState('dark');

  // Load persisted
  useEffect(() => {
    try { const t = localStorage.getItem('ui_theme_pref'); if (t) setTheme(t); } catch {}
  }, []);

  // Resolve on change
  useEffect(() => {
    function apply() {
      const r = resolve(theme);
      setResolved(r);
      if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', r === 'dark' ? 'dark':'light');
      }
    }
    apply();
    if (theme === 'system' && typeof window !== 'undefined') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => apply();
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  function updateTheme(next) {
    setTheme(next);
    try { localStorage.setItem('ui_theme_pref', next); } catch {}
  }

  return (
    <ApiKeyProvider>
      <ThemeContext.Provider value={{ theme, resolved, setTheme: updateTheme }}>
        <Toaster position="top-right" />
        {children}
      </ThemeContext.Provider>
    </ApiKeyProvider>
  );
}
