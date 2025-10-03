"use client";
import React, { useMemo, useState } from 'react';
import { useLogs } from '../lib/hooks';
import { useApiKey } from './ApiKeyContext';
import { callTool } from '../lib/mcpClient';
import toast from 'react-hot-toast';
import dayjs from 'dayjs';

export default function HistoryList({ projectId, readOnly = false }) {
  const { apiKey } = useApiKey();
  const { data, error, isLoading, mutate } = useLogs(apiKey, projectId);
  const [busyHashes, setBusyHashes] = useState(() => new Set());
  const [sortOrder, setSortOrder] = useState('desc'); // 'desc' puts newest on top (default)

  const logs = useMemo(() => data?.logs || [], [data]);
  const sortedLogs = useMemo(() => {
    const getTs = (x) => {
      const t = new Date(x?.created_at || 0).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    const arr = [...logs];
    arr.sort((a, b) => {
      const da = getTs(a), db = getTs(b);
      return sortOrder === 'desc' ? (db - da) : (da - db);
    });
    return arr;
  }, [logs, sortOrder]);

  async function onRevert(hash) {
    if (!hash) return;
    const short = hash.slice(0, 8);
    const ok = window.confirm(`Revert project to commit ${short}?\n\nThis restores AGENTS.md and tasks to that snapshot.\nThis action cannot be undone.`);
    if (!ok) return;
    setBusyHashes(prev => new Set(prev).add(hash));
    try {
      await callTool(apiKey, 'revert_project', { project_id: projectId, hash });
      toast.success(`Reverted to ${short}`);
      // Refresh history after revert
      mutate();
    } catch (e) {
      toast.error(`Revert failed: ${e?.message || e}`);
    } finally {
      setBusyHashes(prev => { const next = new Set(prev); next.delete(hash); return next; });
    }
  }
  return (
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'0.5rem'}}>
        <h3 style={{marginTop:0,marginBottom:0}}>Commit History</h3>
        <button
          onClick={() => setSortOrder(s => s === 'desc' ? 'asc' : 'desc')}
          title={sortOrder === 'desc' ? 'Newest first' : 'Oldest first'}
          style={{background:'var(--panel)',color:'var(--text)',border:'1px solid var(--border)',padding:'0.25rem 0.6rem',borderRadius:6,cursor:'pointer',fontSize:'0.75rem',fontWeight:600}}
        >Sort: {sortOrder === 'desc' ? 'Newest ↓' : 'Oldest ↑'}</button>
      </div>
      {isLoading && <p>Loading history...</p>}
      {error && <p style={{color:'tomato'}}>Error: {error.message}</p>}
      <ul style={{listStyle:'none',padding:0,margin:0,display:'flex',flexDirection:'column',gap:'0.4rem'}}>
        {sortedLogs.map(l => {
          const short = l.hash.slice(0,8);
          const busy = busyHashes.has(l.hash);
          return (
            <li key={l.hash} style={{background:'var(--panel)',border:'1px solid var(--border)',padding:'0.5rem',borderRadius:6,fontSize:'0.8rem'}}>
              <div style={{display:'flex',justifyContent:'space-between',gap:'0.5rem',alignItems:'center'}}>
                <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                  <code style={{opacity:0.8}}>{short}</code>
                  <span style={{opacity:0.6}}>{dayjs(l.created_at).format('MM-DD HH:mm')}</span>
                </div>
                {!readOnly && (
                  <button
                    onClick={() => onRevert(l.hash)}
                    disabled={busy}
                    title={`Revert to ${short}`}
                    style={{background:'var(--accent)',color:'#fff',border:'1px solid var(--accent-hover)',padding:'0.25rem 0.6rem',borderRadius:6,cursor:busy?'wait':'pointer',fontSize:'0.75rem',fontWeight:600}}
                  >{busy ? 'Reverting…' : 'Revert'}</button>
                )}
              </div>
              <div style={{marginTop:'0.3rem'}}>{l.message}</div>
              {l.modified_by && <div style={{marginTop:'0.3rem',opacity:0.5}}>by {l.modified_by}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
