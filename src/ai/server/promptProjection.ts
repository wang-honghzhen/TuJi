import { attachmentPromptMessages } from './attachmentPrompt';
import type { AppSnapshot, ProtocolMessage, Task } from '../domain';
import type { ContextStage, PromptEntry } from '../contextState';
import { allEvidence, summaryArchive } from './historyRepresentations';
import { renderSummaryReferences, summaryProjection } from './summaryBindings';
import { historicalGraphEncoder, translateGraphPayload } from './graphReferences';
import { historyReferenceProjection } from './historyReferenceProjection';
import { publicReadEntries } from './toolVersionProtocol';
import { promptReceipt } from './promptReceipts';

export const PROMPT_PROJECTION_VERSION = 27;

/** Projection is draft-only. The caller commits the complete stage with the request. */
export function projectPromptEntries(state: AppSnapshot, task: Task, stage: ContextStage,
  encode: (value: string) => string, _append: (entry: PromptEntry) => void): ProtocolMessage[] {
  const archive = summaryArchive(state, task);
  const projectHistory = historyReferenceProjection(state, task, encode);
  const records = state.canvasGraphReferences[task.canvasId]?.history?.length ? new Map(allEvidence(state,task).map(record=>[record.id,record])) : undefined;
  const refresh = (value: unknown, entry: PromptEntry, project:(id:string)=>string): unknown => {
    if (Array.isArray(value)) return value.map(item=>refresh(item,entry,project));
    if (!value || typeof value !== 'object') return value;
    const row = projectHistory(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, refresh(item,entry,project)])),entry.coverage,project);
    if(row.bodyOmitted===true&&typeof row.callId==='string'){
      if(stage.attachmentProtectionCalls?.includes(row.callId as string))row.contentLocation={regions:['references'],state:'protected_attachment_catalog_until_task_end'};
      const member=stage.summaryRegions?.members.find(m=>m.callIds.includes(row.callId as string));
      if(member)row.contentLocation={regions:[...new Set(member.parts.map(p=>p.category))],summaryIds:[...new Set(member.parts.flatMap(p=>p.rootIds??[p.rootId]))]};
      const views=stage.canvasRefresh?.members.filter(m=>m.callIds.includes(row.callId as string));
      if(views?.length)row.contentLocation={regions:['canvas'],state:'current_view_near_source_call'};
    }
    if (typeof row.summaryId === 'string' && typeof row.content === 'string') {
      const summary = archive.find(s => s.id === row.summaryId);
      if (summary) {
        const projection = summaryProjection(state, task, summary);
        // Saved summary expansions may predate the local summary/original label.
        // Refresh presentation metadata without changing archived text or ranges.
        row.contentState = projection.contentState;
        row.readWith ??= projection.readWith;
        row.objectBindings = projection.objectBindings;
        if(row.resultTextPart===undefined)row.content = projection.content;
        row.bindingEvidence = projection.bindingEvidence;
      }
    }
    return row;
  };
  const translate = (text: string, entry: PromptEntry, toolName?: string, timeline=false) => {
    const covered = entry.coverage.map(span=>records?.get(span.recordId)).filter(record=>!!record);
    const historical = covered.map(record=>historicalGraphEncoder(state,task.canvasId,record.createdAt,encode,record.order));
    const project = (id:string) => {
      const values = historical.map(encoder=>encoder(id));
      return values.length && values.every(value=>value===values[0]) ? values[0] : encode(id);
    };
    try {
      const payload = JSON.parse(text);
      if(timeline&&payload&&typeof payload==='object'&&!Array.isArray(payload))
        for(const key of ['historical_material','task_progress']){
          const row=payload[key];
          if(row&&typeof row==='object'&&!Array.isArray(row))payload[key]=projectHistory(row,entry.coverage,project,true);
        }
      return JSON.stringify(renderSummaryReferences(translateGraphPayload(publicReadEntries(
        refresh(toolName ? promptReceipt(toolName, payload) : payload,entry,project)), project)));
    }
    catch { return text; }
  };
  for (const entry of stage.entries) if (!entry.wireMessages) {
    const tools = new Map(entry.messages.flatMap(message => message.toolCalls ?? []).map(call => [call.id, call.name]));
    entry.wireMessages = entry.messages.map(({ responseItems: _items, reasoningContent: _reasoning, ...message }) => ({
      ...message, content: translate(message.content,entry, message.role === 'tool' ? tools.get(message.toolCallId ?? '') : undefined,
        message.role==='user'&&['history','progress','current_protocol'].includes(entry.category)),
      ...(message.toolCalls ? { toolCalls: message.toolCalls.map(call => ({ ...call, arguments: translate(call.arguments,entry) })) } : {}),
    }));
  }
  // Runtime attaches private continuation to this separate copy, never to the frozen public entries.
  return attachmentPromptMessages(state,task,stage.entries);
}
