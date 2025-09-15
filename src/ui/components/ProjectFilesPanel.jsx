"use client";
import React, { useState, useRef } from 'react';
import toast from 'react-hot-toast';
import { useApiKey } from './ApiKeyContext';
import { useProjectFiles } from '../lib/hooks';

function formatTimestamp(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function ProjectFilesPanel({ projectId, readOnly }) {
  const { apiKey } = useApiKey();
  const { data, error, mutate, isLoading } = useProjectFiles(apiKey, projectId);
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [busyFiles, setBusyFiles] = useState(() => new Set());
  const inputRef = useRef(null);

  const files = data?.files || [];
  const effectiveReadOnly = readOnly || data?.permission === 'ro';

  function resetInput() {
    setSelectedFile(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }

  async function handleUpload(e) {
    e.preventDefault();
    if (!selectedFile) {
      toast.error('Choose a file first');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('project_id', projectId);
      form.append('file', selectedFile);
      const res = await fetch('/project/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        let msg = `status ${res.status}`;
        try {
          const payload = await res.json();
          msg = payload?.message || payload?.error || msg;
        } catch {}
        throw new Error(msg);
      }
      toast.success('File uploaded');
      resetInput();
      mutate();
    } catch (err) {
      toast.error(`Upload failed: ${err.message || err}`);
    } finally {
      setUploading(false);
    }
  }

  function setFileBusy(fileId, busy) {
    setBusyFiles(prev => {
      const next = new Set(prev);
      if (busy) next.add(fileId); else next.delete(fileId);
      return next;
    });
  }

  async function handleDelete(file) {
    if (!window.confirm(`Delete ${file.original_name}?`)) return;
    setFileBusy(file.file_id, true);
    try {
      const res = await fetch(`/project/files/${encodeURIComponent(file.file_id)}?project_id=${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        let msg = `status ${res.status}`;
        try {
          const payload = await res.json();
          msg = payload?.message || payload?.error || msg;
        } catch {}
        throw new Error(msg);
      }
      toast.success('File deleted');
      mutate();
    } catch (err) {
      toast.error(`Delete failed: ${err.message || err}`);
    } finally {
      setFileBusy(file.file_id, false);
    }
  }

  return (
    <div style={{display:'flex',flexDirection:'column',gap:'1.25rem'}}>
      {!effectiveReadOnly && (
        <form onSubmit={handleUpload} style={{display:'flex',flexWrap:'wrap',gap:'0.75rem',alignItems:'center',background:'var(--panel)',border:'1px solid var(--border)',padding:'0.75rem',borderRadius:8}}>
          <div style={{flex:'1 1 220px'}}>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.md,.txt"
              onChange={e => setSelectedFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
              style={{width:'100%',background:'var(--panel-alt)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:6,padding:'0.5rem'}}
            />
            <small style={{opacity:0.6,display:'block',marginTop:'0.35rem'}}>Allowed: pdf, md, txt. Files replace previous uploads with the same name.</small>
          </div>
          <button
            type="submit"
            disabled={uploading || !selectedFile}
            style={{background:'var(--accent)',color:'#fff',border:'1px solid var(--accent-hover)',padding:'0.6rem 1.1rem',borderRadius:6,fontWeight:600,cursor:uploading?'wait':'pointer'}}
          >{uploading ? 'Uploading…' : 'Upload'}</button>
        </form>
      )}
      {effectiveReadOnly && (
        <p style={{margin:0,fontSize:'0.85rem',opacity:0.7}}>Read-only access: you can view file metadata but cannot upload or delete files.</p>
      )}
      {error && <p style={{color:'var(--danger-border)'}}>Error: {error.message}</p>}
      {isLoading ? (
        <p>Loading files…</p>
      ) : (
        files.length === 0 ? (
          <p style={{opacity:0.7}}>No files yet.</p>
        ) : (
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',minWidth:520}}>
              <thead>
                <tr style={{background:'var(--panel)',color:'var(--muted)',textAlign:'left'}}>
                  <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)'}}>Name</th>
                  <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)'}}>Type</th>
                  <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)'}}>Uploaded By</th>
                  <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)'}}>Updated</th>
                  {!effectiveReadOnly && <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)',textAlign:'right'}}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {files.map(f => {
                  const busy = busyFiles.has(f.file_id);
                  return (
                    <tr key={f.file_id} style={{borderBottom:'1px solid var(--panel-alt)'}}>
                      <td style={{padding:'0.6rem 0.5rem',wordBreak:'break-word'}}>{f.original_name}</td>
                      <td style={{padding:'0.6rem 0.5rem'}}>{f.file_type || '—'}</td>
                      <td style={{padding:'0.6rem 0.5rem'}}>
                        {f.uploaded_by ? (
                          <span>{f.uploaded_by.name || f.uploaded_by.id} <span style={{opacity:0.55,fontSize:'0.7rem'}}>({f.uploaded_by.id})</span></span>
                        ) : 'Unknown'}
                      </td>
                      <td style={{padding:'0.6rem 0.5rem'}}>{formatTimestamp(f.updated_at)}</td>
                      {!effectiveReadOnly && (
                        <td style={{padding:'0.6rem 0.5rem',textAlign:'right'}}>
                          <button
                            onClick={() => handleDelete(f)}
                            disabled={busy}
                            style={{background:'var(--danger)',color:'#fff',border:'1px solid var(--danger-border)',padding:'0.35rem 0.75rem',borderRadius:6,cursor:busy?'wait':'pointer'}}
                          >{busy ? 'Deleting…' : 'Delete'}</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
