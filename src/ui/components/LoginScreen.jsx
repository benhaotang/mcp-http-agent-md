"use client";
import React, { useState } from 'react';
import { useApiKey } from './ApiKeyContext';
import toast from 'react-hot-toast';

export default function LoginScreen() {
  const { setApiKey } = useApiKey();
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);

  function submit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error('API key required');
      return;
    }
    setApiKey(trimmed);
  console.log('[Login] setApiKey called');
    toast.success('API key saved');
  }

  return (
    <div style={{minHeight:'100svh',display:'flex',alignItems:'center',justifyContent:'center',background:'#0d1117',color:'#fff',fontFamily:'system-ui,sans-serif',padding:'1rem'}}>
      <form onSubmit={submit} style={{background:'#161b22',padding:'2rem',borderRadius:'12px',width:'100%',maxWidth:'420px',boxShadow:'0 4px 24px rgba(0,0,0,0.4)'}}>
        <h1 style={{marginTop:0,fontSize:'1.75rem'}}>MCP UI Login</h1>
        <p style={{fontSize:'0.9rem',lineHeight:1.4,opacity:0.85}}>Enter your user API key. It is stored locally in <code>localStorage</code> only, never sent elsewhere except directly to this server for MCP / project requests.</p>
        <label style={{display:'block',marginBottom:'0.5rem',fontWeight:600}}>API Key</label>
        <div style={{display:'flex',gap:'0.5rem',alignItems:'center'}}>
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={e=>setValue(e.target.value)}
            placeholder="paste your api key"
            style={{flex:1,padding:'0.65rem 0.75rem',border:'1px solid #30363d',borderRadius:6,background:'#0d1117',color:'#fff',fontSize:'0.95rem'}}
            autoFocus
          />
          <button type="button" onClick={()=>setShow(s=>!s)} style={{background:'#21262d',color:'#c9d1d9',border:'1px solid #30363d',padding:'0.55rem 0.75rem',borderRadius:6,cursor:'pointer'}}>{show? 'Hide':'Show'}</button>
        </div>
        <button type="submit" style={{marginTop:'1rem',width:'100%',background:'#238636',color:'#fff',border:'1px solid #2ea043',padding:'0.75rem 1rem',borderRadius:6,fontWeight:600,cursor:'pointer'}}>Save & Continue</button>
        <p style={{marginTop:'1.25rem',fontSize:'0.75rem',opacity:0.6}}>You can clear or change this key later from the top navigation once the dashboard loads.</p>
      </form>
    </div>
  );
}
