"use client";
import React from 'react';
import { useLogs } from '../lib/hooks';
import { useApiKey } from './ApiKeyContext';
import dayjs from 'dayjs';

export default function HistoryList({ projectId }) {
  const { apiKey } = useApiKey();
  const { data, error, isLoading } = useLogs(apiKey, projectId);
  return (
    <div>
      <h3 style={{marginTop:0}}>Commit History</h3>
      {isLoading && <p>Loading history...</p>}
      {error && <p style={{color:'tomato'}}>Error: {error.message}</p>}
      <ul style={{listStyle:'none',padding:0,margin:0,display:'flex',flexDirection:'column',gap:'0.4rem'}}>
        {data?.logs?.map(l => (
          <li key={l.hash} style={{background:'var(--panel)',border:'1px solid var(--border)',padding:'0.5rem',borderRadius:6,fontSize:'0.8rem'}}>
            <div style={{display:'flex',justifyContent:'space-between',gap:'0.5rem'}}>
              <code style={{opacity:0.8}}>{l.hash.slice(0,8)}</code>
              <span style={{opacity:0.6}}>{dayjs(l.created_at).format('MM-DD HH:mm')}</span>
            </div>
            <div style={{marginTop:'0.3rem'}}>{l.message}</div>
            {l.modified_by && <div style={{marginTop:'0.3rem',opacity:0.5}}>by {l.modified_by}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
