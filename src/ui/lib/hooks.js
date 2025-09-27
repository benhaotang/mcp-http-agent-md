"use client";
import useSWR from 'swr';
import { callTool } from './mcpClient';
import { useEffect, useState } from 'react';

function useClientReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  return ready;
}

function toolFetcher(apiKey, name, args) {
  return callTool(apiKey, name, args);
}

export function useProjects(apiKey) {
  const ready = useClientReady();
  return useSWR(ready && apiKey ? ['projects', apiKey] : null, () => toolFetcher(apiKey, 'list_projects', {}), { refreshInterval: 15000 });
}

export function useAgent(apiKey, projectId) {
  const ready = useClientReady();
  return useSWR(ready && apiKey && projectId ? ['agent', apiKey, projectId] : null, () => toolFetcher(apiKey, 'read_agent', { project_id: projectId }), { refreshInterval: 0 });
}

export function useTasks(apiKey, projectId) {
  const ready = useClientReady();
  return useSWR(ready && apiKey && projectId ? ['tasks', apiKey, projectId] : null, () => toolFetcher(apiKey, 'read_progress', { project_id: projectId }), { refreshInterval: 10000 });
}

export function useLogs(apiKey, projectId) {
  const ready = useClientReady();
  return useSWR(ready && apiKey && projectId ? ['logs', apiKey, projectId] : null, () => toolFetcher(apiKey, 'list_project_logs', { project_id: projectId }), { refreshInterval: 30000 });
}

async function fetchProjectFiles(apiKey, projectId) {
  const res = await fetch(`/project/files?project_id=${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    try {
      const data = await res.json();
      const msg = data?.message || data?.error || `status ${res.status}`;
      throw new Error(msg);
    } catch (err) {
      if (err instanceof Error && err.message) throw err;
      throw new Error(`status ${res.status}`);
    }
  }
  return res.json();
}

export function useProjectFiles(apiKey, projectId) {
  const ready = useClientReady();
  return useSWR(ready && apiKey && projectId ? ['files', apiKey, projectId] : null, () => fetchProjectFiles(apiKey, projectId), { refreshInterval: 15000 });
}
