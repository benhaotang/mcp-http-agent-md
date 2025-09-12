"use client";
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const ApiKeyContext = createContext(null);

export function ApiKeyProvider({ children }) {
  const [apiKey, setApiKey] = useState(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('mcp_api_key');
      if (stored) setApiKey(stored);
    } catch {}
  }, []);

  const save = useCallback((key) => {
    console.log('[ApiKey] saving key length', key?.length);
    setApiKey(key);
    try { localStorage.setItem('mcp_api_key', key); } catch {}
  }, []);

  const clear = useCallback(() => {
    setApiKey(null);
    try { localStorage.removeItem('mcp_api_key'); } catch {}
  }, []);

  return (
    <ApiKeyContext.Provider value={{ apiKey, setApiKey: save, clearApiKey: clear }}>
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKey() {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) throw new Error('useApiKey must be used within ApiKeyProvider');
  return ctx;
}
