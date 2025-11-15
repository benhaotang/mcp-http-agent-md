"use client";
import React, { useState } from 'react';
import { callTool } from '../lib/mcpClient';
import { useApiKey } from './ApiKeyContext';
import toast from 'react-hot-toast';

export default function TaskAddForm({ projectId, onAdded, readOnly }) {
  const { apiKey } = useApiKey();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);

  function shortUserFromKey(key) {
    if (!key) return 'user';
    return 'user-' + key.slice(0,4);
  }

  async function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    if (readOnly) { toast.error('Read-only'); return; }
    setAdding(true);
    try {
      const taskInfo = text.trim();
      const comment = `${shortUserFromKey(apiKey)} created task: ${taskInfo}`;
      const result = await callTool(apiKey, 'progress_add', { project_id: projectId, item: taskInfo, comment });
      const generatedId = result.generated_task_ids?.[0] || 'unknown';
      toast.success(`Task added (${generatedId})`);
      setText('');
      onAdded?.();
    } catch (err) {
      toast.error('Add failed: ' + err.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <form onSubmit={submit} style={{display:'flex',gap:'0.5rem',marginBottom:'0.75rem'}}>
      <input value={text} onChange={e=>setText(e.target.value)} placeholder="New task description" style={{flex:1,padding:'0.5rem',borderRadius:4,border:'1px solid var(--border)',background:'var(--panel-alt)',color:'var(--text)'}} />
      <button disabled={adding || readOnly} style={{background:'var(--accent)',color:'#fff',border:'1px solid var(--accent-hover)',padding:'0.5rem 0.9rem',borderRadius:4,fontWeight:600,cursor: readOnly? 'not-allowed':'pointer'}}>Add</button>
    </form>
  );
}
