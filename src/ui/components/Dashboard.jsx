"use client";
import React, { useState, useEffect } from 'react';
import { useProjects } from '../lib/hooks';
import { ProjectListSkeleton } from './LoadingSkeletons';
import { callTool } from '../lib/mcpClient';
import { useApiKey } from './ApiKeyContext';
import toast from 'react-hot-toast';
import { useTheme } from './ClientProviders';

export default function Dashboard({ onSelectProject }) {
  const { apiKey, clearApiKey } = useApiKey();
  const { data, error, mutate, isLoading } = useProjects(apiKey);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyProjectIds, setBusyProjectIds] = useState(new Set());
  const [lastProjectId, setLastProjectId] = useState(null);
  const fileInputRef = React.useRef(null);

  useEffect(() => {
    try { const lp = localStorage.getItem('ui_last_project'); if (lp) setLastProjectId(lp); } catch {}
  }, []);

  async function createProject(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await callTool(apiKey, 'init_project', { name: newName.trim() });
      toast.success('Project created');
      setNewName('');
      mutate();
    } catch (err) {
      toast.error('Create failed: ' + err.message);
    } finally {
      setCreating(false);
    }
  }

  function triggerImport() {
    if (importing) return;
    if (fileInputRef.current) fileInputRef.current.click();
  }

  function sanitizeName(name) {
    const s = String(name || '').replace(/\s+/g, ' ').trim();
    // Allow letters, digits, space, . _ -
    return s.replace(/[^A-Za-z0-9._\- ]/g, '').slice(0, 100) || 'Imported Project';
  }

  const MAX_PROJECT_COPY_ITERATIONS = 1000;

  function uniqueProjectName(baseName) {
    const existing = new Set((data?.projects || []).map(p => String(p.name || '')));
    let name = baseName;
    if (!existing.has(name)) return name;
    let i = 1;
    while (existing.has(`${baseName}_copy${i}`) && i < MAX_PROJECT_COPY_ITERATIONS) i++;
    return `${baseName}_copy${i}`;
  }

  async function onImportFileChange(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      toast('Importing snapshot: only latest AGENTS.md + tasks are applied.');
      const text = await file.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('Invalid JSON file'); }
      const nameRaw = json?.name || json?.project_name || '';
      const agent = typeof json?.agent_md === 'string' ? json.agent_md : '';
      const tasks = Array.isArray(json?.tasks) ? json.tasks : [];
      const safeBase = sanitizeName(nameRaw || 'Imported Project');
      const finalName = uniqueProjectName(safeBase);
      // Validate tasks shape lightly; server will fully validate
      const normalizedTasks = tasks.map(t => ({
        task_id: String(t?.task_id || '').trim(),
        task_info: String(t?.task_info || '').trim(),
        parent_id: t?.parent_id ? String(t.parent_id).trim() : undefined,
        status: t?.status,
        extra_note: typeof t?.extra_note === 'undefined' ? undefined : String(t.extra_note),
      }));
      const res = await callTool(apiKey, 'init_project', { name: finalName, agent, progress: normalizedTasks });
      if (res?.error) throw new Error(res.message || 'Import failed');
      toast.success(`Imported latest snapshot as "${finalName}"`);
      setNewName('');
      mutate();
    } catch (err) {
      toast.error('Import failed: ' + (err?.message || err));
    } finally {
      setImporting(false);
    }
  }

  function beginRename(p) {
    setRenamingId(p.id);
    setRenameValue(p.name.replace(/ \(Read-Only\)$/,'') || '');
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameValue('');
  }

  async function submitRename(p) {
    const newVal = renameValue.trim();
    if (!newVal || newVal === p.name) { cancelRename(); return; }
    const next = new Set(busyProjectIds); next.add(p.id); setBusyProjectIds(next);
    try {
      await callTool(apiKey, 'rename_project', { project_id: p.id, newName: newVal, comment: 'rename via UI' });
      toast.success('Renamed');
      cancelRename();
      mutate();
    } catch (e) {
      toast.error('Rename failed: ' + e.message);
    } finally {
      const n2 = new Set(busyProjectIds); n2.delete(p.id); setBusyProjectIds(n2);
    }
  }

  async function deleteProject(p) {
    if (!p || p.permission !== 'owner') return;
    if (!window.confirm(`Delete project "${p.name}"? This cannot be undone.`)) return;
    if (!window.confirm('Are you absolutely sure? All history will be removed.')) return;
    const next = new Set(busyProjectIds); next.add(p.id); setBusyProjectIds(next);
    try {
      await callTool(apiKey, 'delete_project', { project_id: p.id });
      toast.success('Deleted');
      mutate();
    } catch (e) {
      toast.error('Delete failed: ' + e.message);
    } finally {
      const n2 = new Set(busyProjectIds); n2.delete(p.id); setBusyProjectIds(n2);
    }
  }

  const { theme, resolved, setTheme } = useTheme();

  function exportProject(p) {
    exportProjectHelper(apiKey, p, setBusyProjectIds, busyProjectIds);
  }

  function cycleTheme() {
    setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light');
  }

  function themeLabel() {
    if (theme === 'system') return `System (${resolved})`;
    return theme.charAt(0).toUpperCase() + theme.slice(1);
  }

  return (
    <div>
      <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'1rem'}}>
        <h1 style={{margin:0,fontSize:'1.4rem'}}>Projects</h1>
        <div style={{display:'flex',gap:'0.5rem',alignItems:'center'}}>
          <button onClick={cycleTheme} title="Toggle theme (light → dark → system)" style={{background:'var(--panel-alt)',color:'var(--text)',border:'1px solid var(--border)',padding:'0.3rem 0.6rem',borderRadius:4,cursor:'pointer',fontSize:'0.65rem'}}>{themeLabel()}</button>
          <code style={{fontSize:'0.7rem',opacity:0.7}}>{apiKey.slice(0,4)}...{apiKey.slice(-4)}</code>
          <button onClick={clearApiKey} style={{background:'var(--btn-muted-bg)',color:'var(--text)',border:'1px solid var(--btn-muted-border)',padding:'0.3rem 0.6rem',borderRadius:4,cursor:'pointer'}}>Logout</button>
        </div>
      </header>
      <form onSubmit={createProject} style={{display:'flex',gap:'0.5rem',marginBottom:'1rem'}}>
        <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New project name" style={{flex:1,padding:'0.5rem',borderRadius:4,border:'1px solid var(--border)',background:'var(--panel-alt)',color:'var(--text)'}} />
        <button disabled={creating} style={{background:'var(--success)',color:'#fff',border:'1px solid var(--success-border)',padding:'0.5rem 0.9rem',borderRadius:4,cursor:'pointer',fontWeight:600}}>Create</button>
        <input ref={fileInputRef} type="file" accept="application/json" style={{display:'none'}} onChange={onImportFileChange} />
        <button type="button" onClick={triggerImport} disabled={importing} title="Import snapshot (latest AGENTS.md + tasks only)" style={{background:'var(--btn-muted-bg)',color:'var(--text)',border:'1px solid var(--btn-muted-border)',padding:'0.5rem 0.9rem',borderRadius:4,cursor:importing?'not-allowed':'pointer',fontWeight:600}}>{importing ? 'Importing…' : 'Import'}</button>
      </form>
  {isLoading && <ProjectListSkeleton />}
      {error && <p style={{color:'tomato'}}>Error: {error.message}</p>}
      <ul style={{listStyle:'none',padding:0,margin:0,display:'grid',gap:'0.5rem'}}>
        {data?.projects?.map(p => {
          const busy = busyProjectIds.has(p.id);
          const canEditMeta = p.permission === 'owner';
          const isRenaming = renamingId === p.id;
          return (
            <li key={p.id} className="project-item" style={{position:'relative',border:'1px solid var(--border)',borderRadius:6,padding:'0.75rem 0.75rem',background:'var(--panel)',display:'flex',justifyContent:'space-between',alignItems:'center',gap:'0.75rem'}}>
              <div style={{flex:1,minWidth:0}}>
                {!isRenaming && (
                  <strong
                    style={{cursor:'pointer',wordBreak:'break-word',textDecoration: lastProjectId===p.id? 'underline':''}}
                    onClick={()=>onSelectProject(p.id)}
                  >{p.name}</strong>
                )}
                {isRenaming && (
                  <form onSubmit={(e)=>{e.preventDefault(); submitRename(p);}} style={{display:'flex',gap:'0.4rem',alignItems:'center'}}>
                    <input autoFocus value={renameValue} onChange={e=>setRenameValue(e.target.value)} style={{flex:1,padding:'0.3rem 0.4rem',border:'1px solid var(--border)',borderRadius:4,background:'var(--panel-alt)',color:'var(--text)',fontSize:'0.8rem'}} />
                    <button type="submit" disabled={busy || !renameValue.trim()} style={{background:'var(--success)',color:'#fff',border:'1px solid var(--success-border)',padding:'0.3rem 0.6rem',borderRadius:4,cursor:'pointer',fontSize:'0.65rem'}}>Save</button>
                    <button type="button" onClick={cancelRename} style={{background:'var(--btn-muted-bg)',color:'var(--text)',border:'1px solid var(--btn-muted-border)',padding:'0.3rem 0.6rem',borderRadius:4,cursor:'pointer',fontSize:'0.65rem'}}>Cancel</button>
                  </form>
                )}
                {p.read_only && !isRenaming && <span style={{marginLeft:'0.5rem',fontSize:'0.6rem',background:'var(--pill-bg)',padding:'0.15rem 0.4rem',borderRadius:4,border:'1px solid var(--pill-border)'}}>RO</span>}
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:'0.25rem'}}>
                <small style={{opacity:0.55,fontSize:'0.6rem'}}>{busy? '...' : p.permission}</small>
                <div className="proj-actions" style={{display:'flex',gap:'0.3rem',opacity:0,transition:'opacity .18s ease'}}>
                  <IconBtn label="Open" onClick={()=>onSelectProject(p.id)} disabled={busy} variant="open" />
                  <IconBtn label="Export latest snapshot (AGENTS.md + tasks)" onClick={()=>exportProject(p)} disabled={busy} variant="export" />
                  {canEditMeta && !isRenaming && <IconBtn label="Rename" onClick={()=>beginRename(p)} disabled={busy} variant="rename" />}
                  {canEditMeta && <IconBtn label="Delete" onClick={()=>deleteProject(p)} disabled={busy} variant="delete" />}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IconBtn({ label, onClick, disabled, variant }) {
  const { bg, border, svg } = iconVariantStyles(variant);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="icon-btn"
      style={{background:bg,border:'1px solid '+border,color:'#fff',padding:'0.3rem',borderRadius:4,cursor:disabled?'not-allowed':'pointer',display:'inline-flex',alignItems:'center',justifyContent:'center',width:26,height:26}}
    >
      {svg}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function iconVariantStyles(v) {
  switch (v) {
    case 'export':
      return { bg:'#0b7f5c', border:'#2ea043', svg: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      ) };
    case 'rename':
      return { bg:'#6639ba', border:'#6f42c1', svg: (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>) };
    case 'delete':
      return { bg:'#8f1d25', border:'#f85149', svg: (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>) };
    default: // open (folder icon)
      return { bg:'#1f6feb', border:'#388bfd', svg: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
          <path d="M3 7h4l2 2h11" />
          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 1.94-1.5L23 11H9l-2 2H3" />
        </svg>
      ) };
  }
}

async function exportProjectHelper(apiKey, project, setBusyProjectIds, busyProjectIds) {
  const next = new Set(busyProjectIds); next.add(project.id); setBusyProjectIds(next);
  try {
    const name = String(project.name || '').replace(/ \(Read-Only\)$/,'');
    const agent = await callTool(apiKey, 'read_agent', { project_id: project.id });
    const active = await callTool(apiKey, 'read_progress', { project_id: project.id });
    const archived = await callTool(apiKey, 'read_progress', { project_id: project.id, only: 'archived' });
    const tasks = ([]).concat((active?.tasks || []), (archived?.tasks || []));
    const snapshot = { version: 1, name, agent_md: typeof agent === 'string' ? agent : '', tasks };
    const pretty = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([pretty], { type: 'application/json;charset=utf-8' });
    const safe = name.replace(/[^A-Za-z0-9._\- ]/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80) || 'project';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safe}.snapshot.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast.success('Exported latest project snapshot');
  } catch (err) {
    toast.error('Export failed: ' + (err?.message || err));
  } finally {
    const n2 = new Set(busyProjectIds); n2.delete(project.id); setBusyProjectIds(n2);
  }
}
