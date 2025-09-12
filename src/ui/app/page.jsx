"use client";
import LoginScreen from '../components/LoginScreen';
import { useApiKey } from '../components/ApiKeyContext';
import Dashboard from '../components/Dashboard';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  // All hooks MUST remain unconditionally invoked in the same order on every render.
  const { apiKey } = useApiKey();
  const [selected, setSelected] = useState(null);
  const router = useRouter();

  // Debug log (safe; does not change render path)
  useEffect(() => {
    console.log('[Home] apiKey state', apiKey ? apiKey.slice(0,4)+'...' : 'NONE');
  }, [apiKey]);

  // Handle navigation side-effect when a project is chosen
  useEffect(() => {
    if (selected) {
      router.push(`/projects/${selected}`); // basePath '/ui' auto-prepended by Next
    }
  }, [selected, router]);

  // Decide what to render AFTER hooks are declared to avoid conditional hook order.
  let content;
  if (!apiKey) {
    content = <LoginScreen />;
  } else if (selected) {
    // While navigation is occurring, keep a stable placeholder (same hooks count)
    content = (
      <div style={{padding:'2rem',fontFamily:'system-ui,sans-serif'}}>
        <p style={{opacity:0.7}}>Opening project…</p>
      </div>
    );
  } else {
    content = (
      <div key={apiKey} style={{padding:'1rem',fontFamily:'system-ui,sans-serif'}}>
        <Dashboard onSelectProject={setSelected} />
      </div>
    );
  }

  return content;
}
