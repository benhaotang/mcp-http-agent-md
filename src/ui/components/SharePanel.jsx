"use client";
import React, { useEffect, useState } from 'react';
import { useApiKey } from './ApiKeyContext';
import toast from 'react-hot-toast';

async function fetchStatus(apiKey, projectId) {
  const res = await fetch(`/project/status?project_id=${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error('status ' + res.status);
  return res.json();
}

async function share(apiKey, body) {
  const res = await fetch('/project/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('share ' + res.status);
  return res.json();
}

export default function SharePanel({ projectId }) {
  const { apiKey } = useApiKey();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState('');
  const [perm, setPerm] = useState('ro');
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try { setStatus(await fetchStatus(apiKey, projectId)); } catch (e) { toast.error('Load failed: ' + e.message);} finally { setLoading(false);} }

  useEffect(()=>{ load(); }, [apiKey, projectId]);

  async function doShare(e) {
    e.preventDefault();
    if (!target.trim()) return;
    setBusy(true);
    try {
      await share(apiKey, { project_id: projectId, target_user_id: target.trim(), permission: perm });
      toast.success('Updated sharing');
      setTarget('');
      load();
    } catch (e) {
      toast.error('Share failed: ' + e.message);
    } finally { setBusy(false); }
  }

  async function revoke(id) {
    setBusy(true);
    try { await share(apiKey, { project_id: projectId, target_user_id: id, revoke: true }); toast.success('Revoked'); load(); } catch(e){ toast.error('Revoke failed: '+e.message);} finally { setBusy(false);} }

  return (
    <div>
      <h3 style={{marginTop:0}}>Sharing</h3>
      {loading && <p>Loading...</p>}
      {status && (
        <div style={{display:'flex',flexDirection:'column',gap:'0.75rem'}}>
          <div style={{fontSize:'0.85rem'}}><strong>Owner:</strong> {status.owner?.name || status.owner?.id}</div>
          {status.shared_read_write && (
            <div>
              <div style={{fontWeight:600,fontSize:'0.75rem',opacity:0.7}}>Read/Write</div>
              <ul style={{listStyle:'none',padding:0,margin:0,display:'flex',flexWrap:'wrap',gap:'0.4rem'}}>
                {status.shared_read_write.map(u => (
                  <li key={u.id} style={{background:'#161b22',border:'1px solid #30363d',padding:'0.25rem 0.5rem',borderRadius:4}}>
                    {u.name || u.id} <button onClick={()=>revoke(u.id)} style={{marginLeft:4,background:'transparent',color:'#f85149',border:'none',cursor:'pointer'}}>✕</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {status.shared_read && (
            <div>
              <div style={{fontWeight:600,fontSize:'0.75rem',opacity:0.7}}>Read Only</div>
              <ul style={{listStyle:'none',padding:0,margin:0,display:'flex',flexWrap:'wrap',gap:'0.4rem'}}>
                {status.shared_read.map(u => (
                  <li key={u.id} style={{background:'#161b22',border:'1px solid #30363d',padding:'0.25rem 0.5rem',borderRadius:4}}>
                    {u.name || u.id} <button onClick={()=>revoke(u.id)} style={{marginLeft:4,background:'transparent',color:'#f85149',border:'none',cursor:'pointer'}}>✕</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <form onSubmit={doShare} style={{marginTop:'1rem',display:'flex',flexDirection:'column',gap:'0.5rem',maxWidth:420}}>
        <div style={{display:'flex',gap:'0.5rem'}}>
          <input value={target} onChange={e=>setTarget(e.target.value)} placeholder="Target user id" style={{flex:1,padding:'0.5rem',borderRadius:4,border:'1px solid #30363d',background:'#0d1117',color:'#c9d1d9'}} />
          <select value={perm} onChange={e=>setPerm(e.target.value)} style={{padding:'0.5rem',borderRadius:4,border:'1px solid #30363d',background:'#161b22',color:'#c9d1d9'}}>
            <option value="ro">ro</option>
            <option value="rw">rw</option>
          </select>
        </div>
        <button disabled={busy} style={{background:'#1f6feb',color:'#fff',border:'1px solid #2f81f7',padding:'0.55rem 0.9rem',borderRadius:4,fontWeight:600,cursor:'pointer'}}>Share / Update</button>
      </form>
    </div>
  );
}
