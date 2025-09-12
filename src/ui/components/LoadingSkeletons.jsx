"use client";
import React from 'react';

export function Skeleton({ height=16, width='100%', style }) {
  return <div className="skeleton" style={{height,width, ...style}} />;
}

export function ProjectListSkeleton() {
  return (
    <ul style={{listStyle:'none',padding:0,margin:0,display:'grid',gap:'0.5rem'}}>
      {Array.from({length:4}).map((_,i)=>(
  <li key={i} style={{border:'1px solid var(--border)',borderRadius:6,padding:'0.75rem',background:'var(--panel)'}}>
          <Skeleton height={14} width="40%" />
          <Skeleton height={10} width="25%" style={{marginTop:6}} />
        </li>
      ))}
    </ul>
  );
}

export function KanbanSkeleton() {
  return (
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'0.75rem'}}>
      {['Pending','In Progress','Completed','Archived'].map(col => (
  <div key={col} style={{background:'var(--panel)',border:'1px solid var(--border)',borderRadius:6,padding:'0.5rem',minHeight:300,display:'flex',flexDirection:'column'}}>
          <div style={{fontWeight:600,fontSize:'0.8rem',marginBottom:'0.4rem'}}>{col}</div>
          <div style={{display:'flex',flexDirection:'column',gap:'0.5rem'}}>
            {Array.from({length:4}).map((_,i)=>(
              <div key={i} style={{background:'var(--panel-alt)',border:'1px solid var(--border)',borderRadius:6,padding:'0.5rem'}}>
                <Skeleton height={10} width="55%" />
                <Skeleton height={12} width="80%" style={{marginTop:6}} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AgentEditorSkeleton() {
  return (
    <div>
      <Skeleton height={28} width="30%" style={{marginBottom:12}} />
  <div style={{border:'1px solid var(--border)',borderRadius:6,overflow:'hidden'}}>
        <Skeleton height={480} />
      </div>
    </div>
  );
}
