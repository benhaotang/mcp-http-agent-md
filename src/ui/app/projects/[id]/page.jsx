"use client";
import React, { useMemo, useState, useEffect } from 'react';
import { useSearchParams, useRouter, useParams } from 'next/navigation';
import { useApiKey } from '../../../components/ApiKeyContext';
import { useProjects } from '../../../lib/hooks';
import AgentEditor from '../../../components/AgentEditor';
import KanbanBoard from '../../../components/KanbanBoard';
import TaskAddForm from '../../../components/TaskAddForm';
import SharePanel from '../../../components/SharePanel';
import HistoryList from '../../../components/HistoryList';
import Link from 'next/link';
import Dashboard from '../../../components/Dashboard';
import ProjectFilesPanel from '../../../components/ProjectFilesPanel';

const TABS = [
  { key: 'tasks', label: 'Tasks' },
  { key: 'agent', label: 'AGENTS.md' },
  { key: 'files', label: 'Files' },
  { key: 'share', label: 'Share' },
  { key: 'history', label: 'History' }
];

export default function ProjectPage() {
  const params = useParams();
  const projectId = params.id;
  const { apiKey } = useApiKey();
  const search = useSearchParams();
  const router = useRouter();
  const tab = search.get('tab') || 'tasks';
  const { data: projects } = useProjects(apiKey);
  const project = useMemo(()=> (projects?.projects||[]).find(p=>p.id===projectId), [projects, projectId]);
  const readOnly = project?.read_only || project?.permission === 'ro';
  const [refreshTasksFlag, setRefreshTasksFlag] = useState(0);

  useEffect(() => {
    // persist last selected project id
    try { localStorage.setItem('ui_last_project', projectId); } catch {}
  }, [projectId]);
  useEffect(() => {
    // If no explicit tab in URL, try restore from localStorage
    if (!search.get('tab')) {
      try {
        const lastTab = localStorage.getItem('ui_last_tab');
        if (lastTab && TABS.find(x=>x.key===lastTab)) {
          router.replace(`/projects/${projectId}?tab=${lastTab}`);
        }
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setTab(t) {
    const q = new URLSearchParams(Array.from(search.entries()));
    q.set('tab', t);
  router.replace(`/projects/${projectId}?${q.toString()}`);
    try { localStorage.setItem('ui_last_tab', t); } catch {}
  }

  return (
    <div style={{padding:'1rem',fontFamily:'system-ui,sans-serif'}}>
      <div style={{display:'flex',alignItems:'center',gap:'0.75rem',marginBottom:'1rem'}}>
  <Link href="/" style={{color:'#58a6ff'}}>← Projects</Link>
        <h2 style={{margin:0,fontSize:'1.25rem'}}>{project?.name || 'Project'} {readOnly && <span style={{fontSize:'0.6rem',background:'#555',padding:'0.2rem 0.4rem',borderRadius:4}}>RO</span>}</h2>
      </div>
      <nav style={{display:'flex',gap:'0.5rem',marginBottom:'1rem',flexWrap:'wrap'}}>
        {TABS.map(t => (
          <button key={t.key} onClick={()=>setTab(t.key)} style={{background: tab===t.key?'#1f6feb':'#30363d',color:'#fff',border:'1px solid #30363d',padding:'0.45rem 0.8rem',borderRadius:6,cursor:'pointer',fontSize:'0.8rem',fontWeight:600}}>{t.label}</button>
        ))}
      </nav>
      {tab === 'tasks' && (
        <div>
          <TaskAddForm projectId={projectId} readOnly={readOnly} onAdded={()=>setRefreshTasksFlag(f=>f+1)} />
          <KanbanBoard key={refreshTasksFlag} projectId={projectId} readOnly={readOnly} />
        </div>
      )}
      {tab === 'agent' && <AgentEditor projectId={projectId} readOnly={readOnly} />}
      {tab === 'share' && <SharePanel projectId={projectId} />}
      {tab === 'files' && <ProjectFilesPanel projectId={projectId} readOnly={readOnly} />}
      {tab === 'history' && <HistoryList projectId={projectId} readOnly={readOnly} />}
    </div>
  );
}
