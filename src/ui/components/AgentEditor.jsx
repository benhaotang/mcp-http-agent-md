"use client";
import React, { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), { ssr: false });
import { useAgent } from '../lib/hooks';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(relativeTime);
import { callTool } from '../lib/mcpClient';
import { useApiKey } from './ApiKeyContext';
import toast from 'react-hot-toast';
import { AgentEditorSkeleton } from './LoadingSkeletons';

export default function AgentEditor({ projectId, readOnly }) {
  const { apiKey } = useApiKey();
  const { data, error, isLoading, mutate } = useAgent(apiKey, projectId);
  const [value, setValue] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const saveTimer = useRef(null);
  const autosaveDelay = 1800; // ms
  const [autosaveEnabled, setAutosaveEnabled] = useState(true);

  useEffect(() => {
    if (typeof data === 'string') { // server may return plain text
      setValue(data);
      setDirty(false);
    }
  }, [data]);

  function shortUserFromKey(key) { return key ? 'user-' + key.slice(0,4) : 'user'; }

  const save = useCallback(async (opts = { silent:false, manual:false }) => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      let comment;
      if (opts.manual) {
        // Prompt user for optional commit message
        let msg = window.prompt('Optional commit message (leave blank for default):', '');
        if (msg && msg.trim()) {
          comment = `${shortUserFromKey(apiKey)} edit agents.md: ${msg.trim()}`;
        } else {
          comment = `${shortUserFromKey(apiKey)} edit agents.md (manual save)`;
        }
      } else {
        comment = `${shortUserFromKey(apiKey)} edit agents.md (autosave)`;
      }
      await callTool(apiKey, 'write_agent', { project_id: projectId, mode: 'full', content: value, comment });
      setDirty(false);
      setLastSaved(Date.now());
      mutate();
      if (!opts.silent) toast.success('Saved AGENTS.md');
    } catch (err) {
      toast.error('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, apiKey, projectId, value, mutate]);

  // Debounced autosave
  useEffect(() => {
  if (!dirty || !autosaveEnabled) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { save({ silent: true }); }, autosaveDelay);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [dirty, value, save, autosaveEnabled]);

  // Warn user if navigating away with unsaved changes (best-effort)
  useEffect(() => {
    function beforeUnload(e) {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  return (
    <div data-color-mode="dark" suppressHydrationWarning>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.5rem'}}>
        <h3 style={{margin:0}}>AGENTS.md</h3>
        <div style={{display:'flex',gap:'0.6rem',alignItems:'center'}}>
          {dirty && <span style={{fontSize:'0.65rem',background:'#9e6a03',padding:'0.2rem 0.45rem',borderRadius:4}}>Unsaved changes</span>}
          {lastSaved && !dirty && <span style={{fontSize:'0.6rem',opacity:0.6}}>Saved {dayjs(lastSaved).fromNow()}</span>}
          <label style={{display:'flex',alignItems:'center',gap:4,fontSize:'0.6rem',opacity:0.85,cursor:'pointer'}}>
            <input type="checkbox" checked={autosaveEnabled} onChange={e=>setAutosaveEnabled(e.target.checked)} style={{margin:0}} />
            Autosave
          </label>
          <button disabled={saving || readOnly || !dirty} onClick={() => save({ manual:true })} style={{background: readOnly? '#444':'#238636',color:'#fff',border:'1px solid #2ea043',padding:'0.4rem 0.8rem',borderRadius:4,cursor: readOnly? 'not-allowed':'pointer'}}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
  {isLoading && <AgentEditorSkeleton />}
      {error && <p style={{color:'tomato'}}>Error loading: {error.message}</p>}
      <MDEditor
        value={value}
        onChange={(v)=>{ setValue(v || ''); setDirty(true); }}
        height={500}
        preview='edit'
        visibleDragbar={false}
        readOnly={readOnly}
      />
    </div>
  );
}
