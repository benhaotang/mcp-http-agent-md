"use client";
import React, { useMemo, useState } from 'react';
import { callTool } from '../lib/mcpClient';
import { useApiKey } from './ApiKeyContext';
import toast from 'react-hot-toast';

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' }
];

export default function TaskPropertyModal({ open, onClose, taskId, allTasks, projectId, readOnly, onUpdated }) {
  const { apiKey } = useApiKey();
  const task = useMemo(() => allTasks.find(t => t.task_id === taskId), [taskId, allTasks]);
  const [name, setName] = useState(task?.task_info || '');
  const [status, setStatus] = useState(task?.status || 'pending');
  const [parentId, setParentId] = useState(task?.parent_id || '');
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (task) {
      setName(task.task_info || '');
      setStatus(task.status || 'pending');
      setParentId(task.parent_id || '');
    }
  }, [task]);

  const descendants = useMemo(() => {
    // Build descendant set so we can disallow selecting a child as new parent
    const map = new Map();
    allTasks.forEach(t => { if (t.parent_id) { (map.get(t.parent_id) || map.set(t.parent_id, []).get(t.parent_id)).push(t); } });
    const res = new Set();
    function dfs(id) {
      const kids = map.get(id) || [];
      for (const k of kids) { if (!res.has(k.task_id)) { res.add(k.task_id); dfs(k.task_id); } }
    }
    if (task) dfs(task.task_id);
    return res;
  }, [task, allTasks]);

  const candidateParents = useMemo(() => {
    return allTasks
      .filter(t => t.task_id !== taskId && !descendants.has(t.task_id))
      .filter(t => !filter.trim() || t.task_info.toLowerCase().includes(filter.toLowerCase()) || t.task_id.includes(filter))
      .slice(0, 200); // safety cap
  }, [allTasks, taskId, descendants, filter]);

  function shortUserFromKey(key) { return key ? 'user-' + key.slice(0,4) : 'user'; }

  async function save(e) {
    e.preventDefault();
    if (!task || readOnly) return;
    const changed = {};
    if (name !== task.task_info) changed.task_info = name.trim();
    if (status !== task.status) changed.state = status;
    const normalizedParent = parentId.trim() || undefined;
    if ((task.parent_id || undefined) !== normalizedParent) changed.parent_id = normalizedParent || null; // backend treats null removal
    if (!Object.keys(changed).length) { toast('No changes'); onClose?.(); return; }
    setSaving(true);
    try {
      const fields = Object.keys(changed).join(', ');
      const comment = `${shortUserFromKey(apiKey)} updated task ${task.task_id}: ${fields}`;
      await callTool(apiKey, 'progress_set_new_state', { project_id: projectId, match: [task.task_id], ...changed, comment });
      toast.success('Task updated');
      onUpdated?.();
      onClose?.();
    } catch (err) {
      toast.error('Update failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!open || !task) return null;

  return (
    <div style={{position:'fixed',inset:0,zIndex:2000,display:'flex',alignItems:'flex-start',justifyContent:'center',paddingTop:'5vh',background:'rgba(0,0,0,0.5)'}} onMouseDown={(e)=>{ if (e.target === e.currentTarget) onClose?.(); }}>
      <form onSubmit={save} style={{width:'420px',maxWidth:'90vw',background:'var(--panel-alt)',border:'1px solid var(--border)',borderRadius:8,padding:'1rem',boxShadow:'0 4px 16px rgba(0,0,0,0.6)'}} onMouseDown={e=>e.stopPropagation()}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.75rem'}}>
          <h4 style={{margin:0,fontSize:'0.95rem'}}>Edit Task</h4>
          <button type="button" onClick={()=>onClose?.()} style={{background:'none',border:'none',color:'var(--muted)',cursor:'pointer',fontSize:'0.9rem'}}>✕</button>
        </div>
        <div style={{fontSize:'0.7rem',opacity:0.6,marginBottom:'0.5rem'}}>{task.task_id}</div>
        <label style={{display:'block',fontSize:'0.7rem',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>Name</label>
  <textarea value={name} onChange={e=>setName(e.target.value)} rows={3} disabled={readOnly} style={{width:'100%',background:'var(--panel)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:4,padding:'0.4rem',fontSize:'0.8rem',marginBottom:'0.75rem',resize:'vertical'}} />

        <label style={{display:'block',fontSize:'0.7rem',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>Status</label>
  <select value={status} onChange={e=>setStatus(e.target.value)} disabled={readOnly} style={{width:'100%',background:'var(--panel)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:4,padding:'0.35rem',fontSize:'0.8rem',marginBottom:'0.75rem'}}>
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <label style={{display:'block',fontSize:'0.7rem',textTransform:'uppercase',letterSpacing:'.05em',marginBottom:4}}>Parent</label>
        <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Search parent..." style={{width:'100%',background:'var(--panel)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:4,padding:'0.35rem',fontSize:'0.75rem',marginBottom:4}} />
        <div style={{maxHeight:120,overflow:'auto',border:'1px solid var(--border)',borderRadius:4,background:'var(--panel-alt)',marginBottom:'0.6rem'}}>
          <div style={{padding:'0.35rem',fontSize:'0.7rem',cursor:'pointer',background:!parentId?'var(--pill-bg)':'transparent'}} onClick={()=>setParentId('')}>No parent (root)</div>
          {candidateParents.map(p => (
            <div key={p.task_id} style={{padding:'0.35rem',fontSize:'0.7rem',cursor:'pointer',background: parentId===p.task_id ? 'var(--pill-bg)':'transparent'}} onClick={()=>setParentId(p.task_id)}>
              <span style={{opacity:0.65}}>{p.task_id}</span> {p.task_info?.slice(0,50) || ''}
            </div>
          ))}
          {candidateParents.length === 0 && <div style={{padding:'0.35rem',fontSize:'0.65rem',opacity:0.5}}>No matches</div>}
        </div>

        <div style={{display:'flex',justifyContent:'flex-end',gap:'0.5rem',marginTop:'0.5rem'}}>
          <button type="button" onClick={()=>onClose?.()} disabled={saving} style={{background:'var(--btn-muted-bg)',border:'1px solid var(--btn-muted-border)',color:'var(--text)',padding:'0.4rem 0.75rem',borderRadius:4,cursor:'pointer',fontSize:'0.75rem'}}>Cancel</button>
          <button type="submit" disabled={saving || readOnly} style={{background:'var(--success)',border:'1px solid var(--success-border)',color:'#fff',padding:'0.45rem 0.9rem',borderRadius:4,cursor: readOnly? 'not-allowed':'pointer',fontSize:'0.75rem'}}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
