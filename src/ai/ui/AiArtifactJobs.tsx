import { useState } from 'react';
import { useAiStore } from '../client';
import type { Session } from '../domain';
import { AiError, useAction } from './common';

interface ParseJob { id: string; name: string; completedPages?: number; totalPages?: number; status?: string }
export function AiArtifactJobs({ session }: { session: Session }) {
  const events = useAiStore((state) => state.snapshot?.events);
  const command = useAiStore((state) => state.command);
  const [cancelled, setCancelled] = useState<string[]>([]);
  const action = useAction();
  const jobs = new Map<string, ParseJob>();
  for (const event of events ?? []) {
    if (event.workspaceId !== session.workspaceId || typeof event.payload.jobId !== 'string') continue;
    const id = event.payload.jobId;
    if (event.type === 'artifact.started') jobs.set(id, { id, name: typeof event.payload.name === 'string' ? event.payload.name : '会话资料' });
    if (event.type === 'artifact.progress' && jobs.has(id)) jobs.set(id, { ...jobs.get(id)!, completedPages: Number(event.payload.completedPages), totalPages: Number(event.payload.totalPages), status: String(event.payload.status) });
    if (['artifact.completed', 'artifact.failed', 'artifact.cancelled'].includes(event.type)) jobs.delete(id);
  }
  if (!jobs.size && !action.error) return null;
  return <div className="ai-column" data-ai-artifact-jobs>{[...jobs.values()].map((job) => <div className="ai-card ai-column" key={job.id} data-ai-artifact-job={job.id}>
    <div className="ai-row ai-spread"><p>{job.name} · {cancelled.includes(job.id) ? '正在取消解析…' : '正在解析…'}</p><button className="ai-button" disabled={action.busy || cancelled.includes(job.id)} data-ai-cancel-artifact-job onClick={() => void action.run(async () => { await command('artifact.cancel', { sessionId: session.id, jobId: job.id }); setCancelled((old) => [...old, job.id]); })}>取消解析</button></div>
    {job.totalPages && Number.isFinite(job.completedPages) ? <><progress value={job.completedPages} max={job.totalPages} aria-label={`${job.name} 解析进度`} style={{ width: '100%' }} /><p className="ai-muted">已处理 {job.completedPages}/{job.totalPages} 页。已完成页会保留用于后续重试。</p></> : <p className="ai-muted">正在保存原始资料并识别内容。切换页面不会中断本地解析。</p>}
  </div>)}<AiError text={action.error} /></div>;
}
