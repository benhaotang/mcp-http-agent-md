"use client";
import React, { useState, useRef } from 'react';
import toast from 'react-hot-toast';
import { useApiKey } from './ApiKeyContext';
import { useProjectFiles } from '../lib/hooks';
// No MCP tools required for summarization anymore.

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
  const [description, setDescription] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const inputRef = useRef(null);
  const [externalAi, setExternalAi] = useState(false);
  const [summarizingFiles, setSummarizingFiles] = useState(() => new Set());
  const [processingFiles, setProcessingFiles] = useState(() => new Set());

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch('/env/public');
        if (!mounted) return;
        if (!res.ok) { setExternalAi(false); return; }
        const json = await res.json().catch(() => ({}));
        setExternalAi(Boolean(json?.USE_EXTERNAL_AI));
      } catch {
        setExternalAi(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const files = data?.files || [];
  const effectiveReadOnly = readOnly || data?.permission === 'ro';

  function resetInput() {
    setSelectedFile(null);
    setDescription('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }

  async function summarizeFileDirect(file) {
    try {
      if (!externalAi) return;
      setSummarizingFiles(prev => new Set(prev).add(file.file_id));
      const res = await fetch(`/project/files/${encodeURIComponent(file.file_id)}/summarize?project_id=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ save: true })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      mutate();
      toast.success('Summary generated');
    } catch (err) {
      toast.error(`Summarize failed: ${err?.message || err}`);
    } finally {
      setSummarizingFiles(prev => { const next = new Set(prev); next.delete(file.file_id); return next; });
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
      if (description.trim()) {
        form.append('description', description.trim());
      }
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
      const payload = await res.json().catch(() => null);
      toast.success('File uploaded');
      const uploadedFile = payload?.file;
      resetInput();
      mutate();
      if (!description.trim() && externalAi && uploadedFile) {
        summarizeFileDirect(uploadedFile);
      }
    } catch (err) {
      toast.error(`Upload failed: ${err.message || err}`);
    } finally {
      setUploading(false);
    }
  }

  async function processPdf(file, { force = false } = {}) {
    try {
      if (file.has_ocr && !force) {
        const ok = window.confirm('This will overwrite the previous OCR result and re-run OCR. Continue?');
        if (!ok) return;
        force = true;
      }
      setProcessingFiles(prev => new Set(prev).add(file.file_id));
      const res = await fetch(`/project/files/${encodeURIComponent(file.file_id)}/process?project_id=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ force })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      toast.success('OCR processed');
      // Optimistic update to show OCRed state immediately
      mutate(prev => {
        if (!prev || !prev.files) return prev;
        const next = { ...prev, files: prev.files.map(it => it.file_id === file.file_id ? { ...it, has_ocr: true } : it) };
        return next;
      }, false);
    } catch (err) {
      toast.error(`Process failed: ${err?.message || err}`);
    } finally {
      setProcessingFiles(prev => { const next = new Set(prev); next.delete(file.file_id); return next; });
    }
  }


  function toggleExpanded(fileId) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId); else next.add(fileId);
      return next;
    });
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
          <div style={{flex:'1 1 220px'}}>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={externalAi ? "Optional descriptions for yourself and agents. Leave blank to auto‑summarize with AI on upload." : "Optional descriptions for yourself and agents"}
              rows={3}
              style={{width:'100%',background:'var(--panel-alt)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:6,padding:'0.5rem',resize:'vertical',minHeight:'60px'}}
            />
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
                  <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)'}}>Description</th>
                  <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)'}}>Updated</th>
                  {!effectiveReadOnly && <th style={{padding:'0.5rem',borderBottom:'1px solid var(--border)',textAlign:'right'}}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {files.map(f => {
                  const busy = busyFiles.has(f.file_id);
                  const descriptionText = f.description || '';
                  const isExpanded = expanded.has(f.file_id);
                  const long = descriptionText.length > 200;
                  const shownDescription = (!long || isExpanded) ? descriptionText : `${descriptionText.slice(0,200)}…`;
                  return (
                    <tr key={f.file_id} style={{borderBottom:'1px solid var(--panel-alt)'}}>
                      <td style={{padding:'0.6rem 0.5rem',wordBreak:'break-word'}}>{f.original_name}</td>
                      <td style={{padding:'0.6rem 0.5rem'}}>{f.file_type || '—'}</td>
                      <td style={{padding:'0.6rem 0.5rem'}}>
                        {f.uploaded_by ? (
                          <span>{f.uploaded_by.name || f.uploaded_by.id} <span style={{opacity:0.55,fontSize:'0.7rem'}}>({f.uploaded_by.id})</span></span>
                        ) : 'Unknown'}
                      </td>
                      <td style={{padding:'0.6rem 0.5rem',maxWidth:320,wordBreak:'break-word'}}>
                        {descriptionText ? (
                          <div style={{display:'flex',flexDirection:'column',gap:'0.25rem'}}>
                            <span>{shownDescription}</span>
                            {long && (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(f.file_id)}
                                style={{alignSelf:'flex-start',background:'transparent',border:'none',color:'var(--accent)',cursor:'pointer',padding:0,fontSize:'0.75rem'}}
                              >{isExpanded ? 'Collapse' : 'Expand'}</button>
                            )}
                          </div>
                        ) : (
                          <span style={{opacity:0.6}}>No description</span>
                        )}
                      </td>
                      <td style={{padding:'0.6rem 0.5rem'}}>{formatTimestamp(f.updated_at)}</td>
                      {!effectiveReadOnly && (
                        <td style={{padding:'0.6rem 0.5rem',textAlign:'right'}}>
                          {externalAi && (() => {
                            const isSummarizing = summarizingFiles.has(f.file_id);
                            return (
                            <button
                              onClick={() => summarizeFileDirect(f)}
                              disabled={busy || isSummarizing}
                                style={{background:'var(--accent)',opacity:(busy||isSummarizing)?0.6:1,color:'#fff',border:'1px solid var(--accent-hover)',padding:'0.35rem 0.75rem',borderRadius:6,marginRight:8,cursor:(busy||isSummarizing)?'wait':'pointer'}}
                              >{isSummarizing ? 'Processing…' : 'Summarize'}</button>
                            );
                          })()}
                          {String(f.file_type || '').toLowerCase() === 'application/pdf' && (() => {
                            const isProcessing = processingFiles.has(f.file_id);
                            return (
                              <button
                                onClick={() => processPdf(f)}
                                disabled={busy || isProcessing}
                                title={f.has_ocr ? 'OCRed — click to re-run' : 'Run OCR'}
                                style={{background:'var(--accent)',opacity:(busy||isProcessing)?0.6:1,color:'#fff',border:'1px solid var(--accent-hover)',padding:'0.35rem 0.75rem',borderRadius:6,marginRight:8,cursor:(busy||isProcessing)?'wait':'pointer'}}
                              >{isProcessing ? 'Processing…' : (f.has_ocr ? 'OCRed' : 'OCR')}</button>
                            );
                          })()}
                          <button
                            onClick={() => handleDelete(f)}
                            disabled={busy}
                            className="icon-btn"
                            title="Delete"
                            aria-label="Delete file"
                            style={{background:'transparent',border:'none',padding:0,marginLeft:4,cursor:busy?'wait':'pointer'}}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={busy? 'var(--muted)':'var(--danger-border)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6"></polyline>
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                              <path d="M10 11v6"></path>
                              <path d="M14 11v6"></path>
                              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
                            </svg>
                            <span className="sr-only">Delete</span>
                          </button>
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
