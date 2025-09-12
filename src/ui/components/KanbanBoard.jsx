"use client";
import React, { useState } from 'react';
import TaskPropertyModal from './TaskPropertyModal';
import dynamic from 'next/dynamic';
// Dynamically import DnD to avoid SSR hydration issues
const DragDropContext = dynamic(() => import('@hello-pangea/dnd').then(m => m.DragDropContext), { ssr: false });
const Droppable = dynamic(() => import('@hello-pangea/dnd').then(m => m.Droppable), { ssr: false });
const Draggable = dynamic(() => import('@hello-pangea/dnd').then(m => m.Draggable), { ssr: false });
import { useTasks } from '../lib/hooks';
import { callTool } from '../lib/mcpClient';
import { useApiKey } from './ApiKeyContext';
import toast from 'react-hot-toast';
import { KanbanSkeleton } from './LoadingSkeletons';

const COLUMNS = [
  { key: 'pending', title: 'Pending' },
  { key: 'in_progress', title: 'In Progress' },
  { key: 'completed', title: 'Completed' },
  { key: 'archived', title: 'Archived' },
];

export default function KanbanBoard({ projectId, readOnly }) {
  const { apiKey } = useApiKey();
  const { data, error, isLoading, mutate } = useTasks(apiKey, projectId);
  const [moving, setMoving] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('kanbanCollapsed');
        if (raw) {
          const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return new Set(arr);
        }
      }
    } catch {}
    return new Set();
  }); // task_ids of collapsed items (explicit user toggles)
  const [propTask, setPropTask] = useState(null); // task_id being edited

  React.useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        const arr = Array.from(collapsed);
        window.localStorage.setItem('kanbanCollapsed', JSON.stringify(arr));
      }
    } catch {}
  }, [collapsed]);

  const allTasks = data?.tasks || [];
  const idMap = React.useMemo(() => {
    const m = new Map();
    allTasks.forEach(t => m.set(t.task_id, t));
    return m;
  }, [allTasks]);

  function findRootId(task) {
    let current = task;
    const seen = new Set();
    while (current?.parent_id) {
      if (seen.has(current.parent_id)) break; // cycle safety
      seen.add(current.parent_id);
      const parent = idMap.get(current.parent_id);
      if (!parent) break;
      current = parent;
    }
    return current?.task_id || task.task_id;
  }

  const rootCache = React.useMemo(() => {
    const cache = new Map();
    allTasks.forEach(t => cache.set(t.task_id, findRootId(t)));
    return cache;
  }, [allTasks, idMap]);

  const depthCache = React.useMemo(() => {
    const cache = new Map();
    function depthOf(t) {
      let depth = 0;
      let current = t;
      const guard = new Set();
      while (current?.parent_id) {
        if (guard.has(current.parent_id)) break; // cycle safety
        guard.add(current.parent_id);
        const parent = idMap.get(current.parent_id);
        if (!parent) break;
        depth += 1;
        current = parent;
      }
      return depth;
    }
    allTasks.forEach(t => cache.set(t.task_id, depthOf(t)));
    return cache;
  }, [allTasks, idMap]);

  function hasCollapsedAncestor(t) {
    let p = t.parent_id;
    const guard = new Set();
    while (p) {
      if (collapsed.has(p)) return true;
      if (guard.has(p)) break; // cycle
      guard.add(p);
      const parent = idMap.get(p);
      p = parent?.parent_id;
    }
    return false;
  }

  // ancestorHidden stores roots whose subtree should be suppressed globally (root collapsed)
  const [ancestorHidden, setAncestorHidden] = useState(new Set());

  function collapsedAncestor(task) {
    let p = task.parent_id;
    const seen = new Set();
    while (p) {
      if (ancestorHidden.has(p)) return idMap.get(p) || null;
      if (seen.has(p)) break;
      seen.add(p);
      const parent = idMap.get(p);
      p = parent?.parent_id;
    }
    return null;
  }

  function shouldHide(task) {
    const anc = collapsedAncestor(task);
    if (!anc) return false;
    // Only hide across columns; same-column descendants stay for hierarchical rendering logic.
    return anc.status !== task.status;
  }

  const tasksByCol = React.useMemo(() => {
    const map = { pending: [], in_progress: [], completed: [], archived: [] };
    allTasks.forEach(t => { if (map[t.status] && !shouldHide(t)) map[t.status].push(t); });
    return map;
  }, [allTasks, collapsed, ancestorHidden]);

  // Color palette for root lineage markers
  const ROOT_COLORS = ['#58a6ff','#d2a8ff','#ff7b72','#ffa657','#7ee787','#f0883e','#1f6feb','#bc8cff','#79c0ff','#ffb77c','#ffb3d1','#c9d1d9','#b5e8a3','#ffd580','#b392f0','#8ddb8c'];
  const rootColorMap = React.useMemo(() => {
    const uniqueRoots = Array.from(new Set(allTasks.map(t => rootCache.get(t.task_id) || t.task_id)));
    uniqueRoots.sort();
    const m = new Map();
    uniqueRoots.forEach((r,i)=> m.set(r, ROOT_COLORS[i % ROOT_COLORS.length]));
    return m;
  }, [allTasks, rootCache]);
  function rootColor(rootId) { return rootColorMap.get(rootId) || '#8b949e'; }

  function shortUserFromKey(key) {
    if (!key) return 'user';
    return 'user-' + key.slice(0,4);
  }

  async function onDragEnd(result) {
    if (!result.destination) return;
    const { draggableId, destination, source } = result;
    const destCol = destination.droppableId;
    const srcCol = source.droppableId;
    if (destCol === srcCol) return; // no change
    if (readOnly) { toast.error('Read-only project'); return; }
    setMoving(true);
    try {
      const comment = `${shortUserFromKey(apiKey)} moved task ${draggableId} ${srcCol} -> ${destCol}`;
      await callTool(apiKey, 'progress_set_new_state', { project_id: projectId, match: [draggableId], state: destCol, comment });
      toast.success('Updated status');
      mutate();
    } catch (e) {
      toast.error('Move failed: ' + e.message);
    } finally {
      setMoving(false);
    }
  }

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <h3 style={{margin:'0 0 0.5rem'}}>Tasks</h3>
        {moving && <small>Updating…</small>}
      </div>
  {isLoading && <KanbanSkeleton />}
      {error && <p style={{color:'tomato'}}>Error: {error.message}</p>}
      <DragDropContext onDragEnd={onDragEnd}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:'0.75rem'}}>
          {COLUMNS.map(col => {
            const colTasks = tasksByCol[col.key];
            // Build child mapping (only within same column/status)
            const childrenMap = {};
            colTasks.forEach(t => { if (t.parent_id) { (childrenMap[t.parent_id] ||= []).push(t); } });
            // Order preservation map
            const orderIndex = new Map(colTasks.map((t,i)=>[t.task_id,i]));
            // Roots are tasks without parent_id or whose parent is not in same column
            const roots = colTasks.filter(t => !t.parent_id || !colTasks.find(x => x.task_id === t.parent_id));
            // Sort roots by their original order for stability
            roots.sort((a,b)=>orderIndex.get(a.task_id)-orderIndex.get(b.task_id));
            const hierarchical = [];
            function addTask(t, depth){
              hierarchical.push({ task: t, depth, globalDepth: depthCache.get(t.task_id) || 0 });
              if (collapsed.has(t.task_id)) return; // collapsed: skip rendering its descendants
              const kids = childrenMap[t.task_id];
              if (kids){
                // stable order by original appearance
                kids.sort((a,b)=>orderIndex.get(a.task_id)-orderIndex.get(b.task_id));
                kids.forEach(k => addTask(k, depth+1));
              }
            }
            roots.forEach(r => addTask(r, 0));
            const totalCount = colTasks.length;
            return (
              <Droppable droppableId={col.key} key={col.key}>
                {(provided) => (
                  <div ref={provided.innerRef} {...provided.droppableProps} style={{background:'#161b22',border:'1px solid #30363d',borderRadius:6,padding:'0.5rem',minHeight:300,display:'flex',flexDirection:'column'}}>
                    <div style={{fontWeight:600,fontSize:'0.85rem',marginBottom:'0.4rem'}}>{col.title} ({totalCount})</div>
                    <div style={{display:'flex',flexDirection:'column',gap:'0.5rem'}}>
                      {hierarchical.map((entry, idx) => {
                        const t = entry.task;
                        const depth = entry.depth; // local (same-column) depth for toggle logic
                        const globalDepth = entry.globalDepth ?? depth;
                        const kids = childrenMap[t.task_id];
                        const hasKids = !!kids?.length;
                        const isCollapsed = collapsed.has(t.task_id);
                        const rootId = rootCache.get(t.task_id) || t.task_id;
                        const color = rootColor(rootId);
                        const hiddenCount = hasKids && isCollapsed ? kids.length : 0; // only direct children count; nested omitted
                        return (
                          <Draggable draggableId={t.task_id} index={idx} key={t.task_id} isDragDisabled={readOnly}>
                            {(p) => (
                              <div ref={p.innerRef} {...p.draggableProps} {...p.dragHandleProps} style={{background:'#0d1117',border:'1px solid #30363d',borderRadius:6,padding:'0.45rem',paddingLeft: globalDepth ? (0.5 + globalDepth*0.75) + 'rem' : '0.5rem',...p.draggableProps.style}}>
                                <div style={{display:'flex',alignItems:'center',gap:'0.4rem'}}>
                                  <span title={`Root: ${rootId}`} style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:color,flexShrink:0}} />
                                  {hasKids && (
                                    <button
                                      type="button"
                                      onClick={(e)=>{ e.stopPropagation(); setCollapsed(prev=>{ const n=new Set(prev); if(n.has(t.task_id)) { n.delete(t.task_id); setAncestorHidden(h => { const nh=new Set(h); nh.delete(t.task_id); return nh; }); } else { n.add(t.task_id); setAncestorHidden(h => { const nh=new Set(h); nh.add(t.task_id); return nh; }); } return n; }); }}
                                      style={{background:'none',border:'none',color:'#8b949e',cursor:'pointer',padding:0,fontSize:'0.75rem',lineHeight:1}}>
                                      {isCollapsed ? '▸' : '▾'}
                                    </button>
                                  )}
                                  {!hasKids && depth > 0 && (
                                    <span style={{width:'0.75rem',display:'inline-block'}} />
                                  )}
                                  <div style={{flex:1,cursor: readOnly? 'default':'pointer'}} onDoubleClick={()=> !readOnly && setPropTask(t.task_id)}>
                                    <div style={{fontSize:'0.75rem',opacity:0.6}}>{t.task_id}</div>
                                    <div style={{fontSize:'0.85rem'}}>{t.task_info}</div>
                                  </div>
                                  {hiddenCount > 0 && (
                                    <span style={{fontSize:'0.65rem',background:'#21262d',border:'1px solid #30363d',borderRadius:12,padding:'0 0.4rem'}}>{hiddenCount}</span>
                                  )}
                                  {!readOnly && (
                                    <button type="button" title="Edit properties" onClick={(e)=>{ e.stopPropagation(); setPropTask(t.task_id); }} style={{background:'none',border:'1px solid #30363d',color:'#8b949e',cursor:'pointer',padding:'0.15rem 0.35rem',fontSize:'0.65rem',borderRadius:4}}>⚙</button>
                                  )}
                                </div>
                              </div>
                            )}
                          </Draggable>
                        );
                      })}
                      {provided.placeholder}
                    </div>
                  </div>
                )}
              </Droppable>
            );
          })}
        </div>
      </DragDropContext>
      <TaskPropertyModal
        open={!!propTask}
        taskId={propTask}
        onClose={()=>setPropTask(null)}
        allTasks={allTasks}
        projectId={projectId}
        readOnly={readOnly}
        onUpdated={()=>mutate()}
      />
    </div>
  );
}
