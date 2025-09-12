"use client";
import { ApiKeyProvider } from './ApiKeyContext';
import { Toaster } from 'react-hot-toast';

export default function ClientProviders({ children }) {
  return (
    <ApiKeyProvider>
      <Toaster position="top-right" />
      {children}
    </ApiKeyProvider>
  );
}
