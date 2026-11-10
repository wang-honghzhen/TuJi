import { authorizedAttachments } from './attachmentCatalog';
import { renderArtifactImages, imageAssetData } from './artifactImages';
import { DEFAULT_PERSONALIZATION,isCanvasBackgroundId,normalizePersonalizationSettings,type PersonalizationSettings } from '@/shared/canvasBackgrounds';
import { DEFAULT_SOUND_SETTINGS } from '@/shared/soundSettings';
import { migrateProposalEvaluations } from '@/v3/design';
import type { GraphState } from '@/v3/types';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppSnapshot,Artifact,ContextManifest,ProtocolMessage,ProviderConfig,SendInput,Task } from '../domain';
import { effectiveArtifacts } from '../memory';
import { selectedProgressPayload, normalizeProgressSelection,registerSessionTask } from '../sessionContext';
import { defaultTaskBudget } from '../taskBudget';
import { isMinimalSession, touchTemporary } from '../temporaryModes';
import { ApiConfiguration } from './apiConfiguration';
import { parseArtifact,type ParseArtifactOptions } from './artifacts';
import { attachmentLimits, attachmentBatchError } from '../attachments';
import { BackgroundAssets, MAX_BACKGROUND_BYTES } from './backgroundAssets';
import { protectReviewWrites } from './changeReview';
import { DomainError,requireValue,strings,text } from './errors';
import { compactEdges,compactCanvasPresentation,memberIds,normalizedGraph } from './graph';
import { validateProviderConfig,type ProviderConfig as TransportProviderConfig } from './providers';
import { hash,id,now,Repository } from './repository';
import { Runtime } from './runtime';
import { reconcileSessionRoots,SessionService } from './sessions';
import { claimTaskNotices } from './taskNotices';
import { userNotebookCommand } from './userNotebook';

export interface CredentialStorage {
  get(): string | null | Promise<string | null>;
  set(value: string): void | Promise<void>;
  clear(): void | Promise<void>;
}
export interface ApplicationOptions { artifactDirectory: string; credentialStorage?: CredentialStorage;
  apiConfiguration?: ApiConfiguration;
  ocr?: ParseArtifactOptions['ocr']; }
/** An export is the canvas data only: the graph, nothing about AI sessions or attachments. */
interface GraphBackup { format: string; exportedAt: string; graph: GraphState; checksum: string }
interface UploadJob { id: string; workspaceId: string; sourceHash: string; controller: AbortController; promise: Promise<Artifact> }
const shaPattern = /^[a-f0-9]{64}$/;
const maximumFileBytes = 50 * 1024 * 1024;
// The command HTTP transport accepts 128 MiB, including its action envelope.
const maximumBackupJsonBytes = 120 * 1024 * 1024;
const active = (task: Task) => task.status!=='completed';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const payloadObject = (value: unknown): Record<string, unknown> => { requireValue(object(value), '操作参数必须是对象'); return value; };
function decodeBase64(value: unknown, maximum = maximumFileBytes): Uint8Array {
  requireValue(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), '附件编码无效或文件过大', 'INVALID_BASE64');
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.byteLength <= maximum && bytes.toString('base64') === value, '附件编码无效或文件过大', 'INVALID_BASE64');
  return bytes;
}

/** Host-independent local application. SQLite is the only mutable canonical store. */
export class Application {
  readonly runtime: Runtime;
  readonly sessions: SessionService;
  private readonly artifactDirectory: string;
  private readonly backgroundAssets: BackgroundAssets;
  private readonly jobs = new Map<string, UploadJob>();
  private readonly operations = new Set<Promise<unknown>>();
  private initialized: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private maintenance = false;
  private settingsChain: Promise<unknown> = Promise.resolve();
  private temporaryCleanupChain: Promise<unknown> = Promise.resolve();
  private temporaryTimer?: ReturnType<typeof setInterval>;
  private expiryRunning = false;
  constructor(readonly repo: Repository, private readonly options: ApplicationOptions) {
    this.artifactDirectory = path.resolve(text(options.artifactDirectory, '资料目录', 4000));
    repo.artifactDirectory = this.artifactDirectory;
    this.backgroundAssets = new BackgroundAssets(this.artifactDirectory);
    this.runtime = new Runtime(repo);
    this.sessions = new SessionService(repo, (state, session) => this.runtime.assembleCreatedSession(state, session));
    repo.transaction(() => { reconcileSessionRoots(repo); this.compactStoredGraph(); });
    this.initialized = this.initialize();
  }
  /** One pass at boot drops fields a previous build wrote and this one retired. */
  private compactStoredGraph(): void {
    const graph = this.repo.state.graph; if (!graph) return;
    const base = compactCanvasPresentation(compactEdges(graph));
    const migrated = migrateProposalEvaluations(base);
    const compacted = migrated === base ? base : normalizedGraph(migrated);
    if (compacted === graph) return;
    this.repo.state.graph = compacted; this.repo.state.graphRevision++;
    this.repo.event('system', 'graph.compacted', { graphRevision: this.repo.state.graphRevision });
  }
  private async initialize() {
    await fs.mkdir(this.artifactDirectory, { recursive: true });
    await this.backgroundAssets.cleanup(normalizePersonalizationSettings(this.repo.state.personalizationSettings).customBackgroundAssetId);
    await this.cleanupTemporaryArtifacts();
    if (this.options.credentialStorage) {
      const saved = await this.options.credentialStorage.get();
      if (saved !== null) { requireValue(typeof saved === 'string' && saved.length < 20000 && !/[\r\n]/.test(saved), '系统凭据存储返回无效凭据'); this.repo.credential = saved; }
    }
    if (this.options.apiConfiguration) {
      const configured = this.options.apiConfiguration.load(this.repo.state.provider, this.repo.credential);
      this.repo.summaryConnection = configured.summaryConnection;
      this.repo.webConnection = configured.webConnection;
      this.repo.transaction(state => { state.attachmentLimits = configured.attachments; });
      await this.saveSettings({ provider: configured.provider, ...(configured.credential ? { credential: configured.credential } : { forgetCredential: true }) });
    }
    await this.cleanupExpiredTemporary();
    if (!this.closed) {this.runtime.kick();this.temporaryTimer=setInterval(()=>{void this.cleanupExpiredTemporary().catch(()=>{});},60000);this.temporaryTimer.unref();}
  }
  ready(): Promise<void> { return this.initialized; }
  snapshot(): AppSnapshot { return this.repo.publicSnapshot(); }
  private userSession(sessionId: unknown) { return this.runtime.getSession(text(sessionId, '会话 ID', 1000)); }

  dispatch(action: string, raw: unknown = {}): Promise<unknown> {
    const operation = this.performDispatch(action, raw);
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  private async performDispatch(action: string, raw: unknown): Promise<unknown> {
    await this.ready(); requireValue(!this.closed, '本地服务已关闭', 'SERVICE_CLOSED');
    const payload = payloadObject(raw);
    requireValue(!this.maintenance || ['snapshot', 'context.preview', 'inheritance.preview'].includes(action), '本地资料正在维护，请稍后重试', 'MAINTENANCE');
    switch (action) {
      case 'snapshot': return this.snapshot();
      case 'session.create': { await this.cleanupExpiredTemporary(); const session=this.sessions.create(payload as unknown as Parameters<SessionService['create']>[0]);this.runtime.freezeForkContinuation(session.id);return session; }
      case 'temporary.configure': { const session=this.sessions.configureTemporary(payload as unknown as Parameters<SessionService['configureTemporary']>[0]);this.runtime.freezeForkContinuation(session.id);return session; }
      case 'temporary.touch': {
        const session=this.userSession(payload.sessionId);requireValue(session.mode==='temporary','仅临时会话可更新活动时间');
        this.repo.transaction(state=>{touchTemporary(session);state.lastSeq++;});return {ok:true};
      }
      case 'session.ensure': return this.sessions.ensure(text(payload.canvasId, '画布 ID', 1000));
      case 'session.update': return this.sessions.update(payload as unknown as Parameters<SessionService['update']>[0]);
      case 'chat.bookmark': return this.sessions.bookmarkTurn(payload as unknown as Parameters<SessionService['bookmarkTurn']>[0]);
      case 'temporary.close': {
        const sessionId = text(payload.sessionId, '临时会话 ID'), workspaceId = this.runtime.getSession(sessionId).workspaceId;
        this.runtime.stopTemporary(sessionId);
        const jobs = [...this.jobs.values()].filter(job => job.workspaceId === workspaceId);
        for (const job of jobs) job.controller.abort();
        const result = this.sessions.closeTemporary(sessionId);
        await Promise.allSettled(jobs.map(job => job.promise));
        // In-progress uploads may have stored bytes before an Artifact row existed.
        const pending = this.repo.db.prepare("SELECT body FROM metadata WHERE key='temporary_artifact_cleanup'").get();
        const hashes = [...new Set([...(pending ? JSON.parse(String(pending.body)) as string[] : []), ...jobs.map(job => job.sourceHash)])];
        this.repo.db.prepare("INSERT INTO metadata(key,body) VALUES('temporary_artifact_cleanup',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify(hashes));
        await this.cleanupTemporaryArtifacts();
        return result;
      }
      case 'inheritance.preview': return this.sessions.inheritancePreview(payload as unknown as Parameters<SessionService['inheritancePreview']>[0]);
      case 'note.save': return this.sessions.noteSave(payload as unknown as Parameters<SessionService['noteSave']>[0]);
      case 'note.requirements': return this.sessions.replaceRequirements(payload as unknown as Parameters<SessionService['replaceRequirements']>[0]);
      case 'userNote.ensure': case 'userNote.create': case 'userNote.save': case 'userNote.delete':
        return userNotebookCommand(this.repo, action, payload);
      case 'note.edit': return this.sessions.noteEdit(payload as unknown as Parameters<SessionService['noteEdit']>[0]);
      case 'note.delete': this.sessions.noteDelete(payload as unknown as Parameters<SessionService['noteDelete']>[0]); return { ok: true };
      case 'input.send': return structuredClone(this.runtime.send(payload as unknown as SendInput));
      case 'task.pause': return structuredClone(this.runtime.pause(text(payload.taskId, '任务 ID')));
      case 'presentation.control': return structuredClone(this.runtime.presentationControl(payload as unknown as Parameters<Runtime['presentationControl']>[0]));
      case 'task.resume': return structuredClone(this.runtime.resume(text(payload.taskId, '任务 ID')));
      case 'task.redo': {
        const taskId = text(payload.taskId, '任务 ID'), prior = this.runtime.getTask(taskId);
        requireValue(this.repo.state.messages.some(message => message.id === prior.rootUserMessageId), '任务原请求已被彻底删除，请发送新任务', 'SOURCE_DELETED');
        return structuredClone(this.runtime.redoTask(taskId));
      }
      case 'interaction.reply': return structuredClone(this.runtime.reply(payload as unknown as Parameters<Runtime['reply']>[0]));
      case 'context.preview': return this.preview(payload);
      case 'artifact.preview': {
        const session=this.userSession(payload.sessionId);
        const task={id:'attachment-preview',sessionId:session.id,workspaceId:session.workspaceId} as Task;
        const own=this.repo.state.artifacts.filter(a=>a.workspaceId===session.workspaceId);
        const files=[...own,...authorizedAttachments(this.repo.state,task).flatMap(f=>f.artifact??[])];
        const artifact=files.find(a=>a.id===payload.artifactId&&(payload.version===undefined||a.version===payload.version)&&a.status!=='deleted');
        requireValue(artifact,'附件不存在或不属于当前会话','OUT_OF_SCOPE');
        const images=await renderArtifactImages(artifact,this.artifactDirectory,attachmentLimits(this.repo.state),{pages:[payload.page??1]});
        return {image:images[0],dataUrl:await imageAssetData(this.artifactDirectory,images[0])};
      }
      case 'artifact.upload': return this.upload(payload);
      case 'artifact.cancel': {
        const job = this.jobs.get(text(payload.jobId, '资料任务 ID')); requireValue(job, '资料任务已结束或不存在', 'NOT_FOUND');
        requireValue(this.userSession(payload.sessionId).workspaceId === job.workspaceId, '资料任务不属于当前工作区', 'OUT_OF_SCOPE'); job.controller.abort(); return { ok: true };
      }
      case 'artifact.retry': {
        const session = this.userSession(payload.sessionId), artifact = this.repo.state.artifacts.find(value => value.id === payload.artifactId && value.workspaceId === session.workspaceId);
        requireValue(artifact && artifact.status !== 'deleted' && artifact.version === payload.expectedVersion, '资料版本已经改变或无权重试', 'VERSION_CONFLICT');
        const bytes = await fs.readFile(this.objectPath(artifact.hash));
        return this.upload({ sessionId: session.id, name: artifact.name, mimeType: artifact.mimeType, dataBase64: bytes.toString('base64') });
      }
      case 'artifact.delete': return this.deleteArtifact(payload);
      case 'settings.sound': {
        requireValue(Object.keys(payload).length > 0 && Object.keys(payload).every(key => ['buttonSounds', 'inputSounds', 'volume'].includes(key)), '音效设置字段无效');
        for (const key of ['buttonSounds', 'inputSounds']) if (key in payload) requireValue(typeof payload[key] === 'boolean', '音效开关必须为布尔值');
        if ('volume' in payload) requireValue(typeof payload.volume === 'number' && Number.isFinite(payload.volume) && payload.volume >= 0 && payload.volume <= 1, '音量必须在 0 到 1 之间');
        return this.repo.transaction(state => {
          state.soundSettings = { ...DEFAULT_SOUND_SETTINGS, ...state.soundSettings, ...payload };
          this.repo.event('system', 'settings.sound.updated', {});
          return structuredClone(state.soundSettings);
        });
      }
      case 'settings.personalization': {
        return this.personalize(() => this.savePersonalization(payload));
      }
      case 'settings.background.upload': return this.personalize(() => this.uploadBackground(payload));
      case 'settings.background.read': return this.personalize(() => this.readBackground(payload));
      case 'settings.background.remove': return this.personalize(() => this.removeBackground(payload));
      case 'settings.save': {
        const result = this.settingsChain.then(() => this.saveSettings(payload)); this.settingsChain = result.catch(() => undefined); return result;
      }
      case 'backup.export': return this.exportBackup();
      case 'backup.import': return this.importBackup(payload.backup ?? payload);
      case 'graph.migrate': return this.migrate(payload);
      case 'graph.mutate': return this.runtime.mutateGraph(payload as unknown as Parameters<Runtime['mutateGraph']>[0]);
      case 'graph.layout.preview': return this.runtime.previewLayout(text(payload.canvasId, '画布'), text(payload.regionId, '目录'));
      case 'graph.layout.apply': return this.runtime.applyLayout(text(payload.proposalId, '布局预览'), text(payload.operationId, '操作 ID'));
      case 'graph.layout.cancel': return this.runtime.cancelLayout(text(payload.proposalId, '布局预览'));
      case 'graph.positioning': return this.runtime.positioning(text(payload.refId, '对象'), payload.active === true);
      case 'graph.undo': case 'changes.undo': return this.runtime.undo(text(payload.changeSetId, '修改批次 ID'));
      case 'changes.review.preview': return this.runtime.previewReview(payload as unknown as Parameters<Runtime['previewReview']>[0]);
      case 'changes.review.apply': return this.runtime.applyReview(payload as unknown as Parameters<Runtime['applyReview']>[0]);
      case 'graph.editing': return this.runtime.editing(text(payload.refId ?? payload.ref, '对象 ID'), text(payload.field, '编辑字段', 80), payload.active === true,
        payload.expectedValue === undefined ? undefined : text(payload.expectedValue, '编辑开始时的原文'));
      default: throw new DomainError('未开放的应用操作', 'UNSUPPORTED_ACTION');
    }
  }

  private personalize<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.settingsChain.then(action);
    this.settingsChain = result.catch(() => undefined);
    return result;
  }
  private commitPersonalization(settings: PersonalizationSettings): PersonalizationSettings {
    return this.repo.transaction(state => {
      state.personalizationSettings = settings;
      this.repo.event('system', 'settings.personalization.updated', { canvasBackgroundId: settings.canvasBackgroundId });
      return structuredClone(settings);
    });
  }
  private async savePersonalization(payload: Record<string, unknown>): Promise<PersonalizationSettings> {
    requireValue(Object.keys(payload).length === 1 && isCanvasBackgroundId(payload.canvasBackgroundId), '请选择有效的画布背景');
    const current = normalizePersonalizationSettings(this.repo.state.personalizationSettings);
    if (payload.canvasBackgroundId === 'custom') {
      requireValue(current.customBackgroundAssetId, '请先上传自定义背景图片', 'BACKGROUND_ASSET_MISSING');
      await this.backgroundAssets.read(current.customBackgroundAssetId);
    }
    return this.commitPersonalization({ ...current, canvasBackgroundId: payload.canvasBackgroundId });
  }
  private async uploadBackground(payload: Record<string, unknown>): Promise<PersonalizationSettings> {
    requireValue(Object.keys(payload).every(key => ['name', 'mimeType', 'dataBase64'].includes(key)), '背景上传字段无效');
    text(payload.name, '图片名称', 1000);
    requireValue(typeof payload.dataBase64 === 'string' && payload.dataBase64.length <= Math.ceil(MAX_BACKGROUND_BYTES / 3) * 4,
      '背景图片不能超过 12 MiB', 'BACKGROUND_TOO_LARGE');
    const bytes = decodeBase64(payload.dataBase64, MAX_BACKGROUND_BYTES);
    const previous = normalizePersonalizationSettings(this.repo.state.personalizationSettings).customBackgroundAssetId;
    const assetId = await this.backgroundAssets.save(bytes, payload.mimeType);
    let settings: PersonalizationSettings;
    try { settings = this.commitPersonalization({ canvasBackgroundId: 'custom', customBackgroundAssetId: assetId }); }
    catch (error) { if (assetId !== previous) await this.backgroundAssets.remove(assetId).catch(() => undefined); throw error; }
    // A failed cleanup must not turn a committed selection into a reported failed upload.
    if (previous && previous !== assetId) await this.backgroundAssets.remove(previous).catch(() => undefined);
    return settings;
  }
  private async readBackground(payload: Record<string, unknown>) {
    requireValue(Object.keys(payload).length === 1, '背景读取字段无效');
    const assetId = text(payload.assetId, '背景图片编号', 64);
    requireValue(assetId === normalizePersonalizationSettings(this.repo.state.personalizationSettings).customBackgroundAssetId,
      '背景图片不属于当前个性化设置', 'BACKGROUND_ASSET_MISSING');
    return this.backgroundAssets.read(assetId);
  }
  private async removeBackground(payload: Record<string, unknown>): Promise<PersonalizationSettings> {
    requireValue(Object.keys(payload).length === 0, '移除背景无需额外参数');
    const current = normalizePersonalizationSettings(this.repo.state.personalizationSettings);
    const settings = this.commitPersonalization({ canvasBackgroundId: current.canvasBackgroundId === 'custom' ? DEFAULT_PERSONALIZATION.canvasBackgroundId : current.canvasBackgroundId });
    if (current.customBackgroundAssetId) await this.backgroundAssets.remove(current.customBackgroundAssetId).catch(() => undefined);
    return settings;
  }

  private cleanupTemporaryArtifacts() {
    const operation = this.temporaryCleanupChain.then(() => this.performTemporaryArtifactCleanup());
    this.temporaryCleanupChain = operation.catch(() => undefined);
    return operation;
  }
  private async performTemporaryArtifactCleanup() {
    const pending = this.repo.db.prepare("SELECT body FROM metadata WHERE key='temporary_artifact_cleanup'").get();
    if (!pending) return;
    const priorMaintenance = this.maintenance; this.maintenance = true;
    try {
    const processed = new Set(JSON.parse(String(pending.body)) as string[]);
    const remaining: string[] = [];
    for (const hash of processed) {
      if (!shaPattern.test(hash)) continue;
      if (this.repo.state.artifacts.some(a => a.hash === hash)
        || this.repo.state.snapshots.some(s => s.artifacts?.some(a => a.hash === hash))) continue;
      if ([...this.jobs.values()].some(job => job.sourceHash === hash)) { remaining.push(hash); continue; }
      const targets = [this.objectPath(hash), path.join(this.artifactDirectory, 'parse', hash + '.json'),
        path.join(this.artifactDirectory, 'parse', 'pages', hash)];
      const extracted = path.join(this.artifactDirectory, 'extracted');
      for (const name of await fs.readdir(extracted).catch(() => [])) if (name.startsWith(hash + '.')) targets.push(path.join(extracted, name));
      try {
        for (const target of targets) {
          const relative = path.relative(this.artifactDirectory, path.resolve(target));
          requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '临时资料清理路径越界');
          await fs.rm(target, { recursive: true, force: true });
        }
      } catch { remaining.push(hash); }
    }
    const latest = this.repo.db.prepare("SELECT body FROM metadata WHERE key='temporary_artifact_cleanup'").get();
    if (latest) remaining.push(...(JSON.parse(String(latest.body)) as string[]).filter(hash => !processed.has(hash)));
    if (remaining.length) this.repo.db.prepare("UPDATE metadata SET body=? WHERE key='temporary_artifact_cleanup'").run(JSON.stringify([...new Set(remaining)]));
    else this.repo.db.prepare("DELETE FROM metadata WHERE key='temporary_artifact_cleanup'").run();
    } finally { this.maintenance = priorMaintenance; }
  }

  private preview(payload: Record<string, unknown>): ContextManifest {
    if (payload.taskId !== undefined) {
      const task = this.runtime.getTask(text(payload.taskId, '任务 ID'));
      if (payload.sessionId !== undefined) requireValue(task.sessionId === payload.sessionId, '预览任务不属于该会话', 'OUT_OF_SCOPE');
      const manifest = structuredClone(this.runtime.preview(task, task.checkpoint?.protocol));
      return sanitizeManifest(manifest);
    }
    const session = this.userSession(payload.sessionId), state = structuredClone(this.repo.state);
    requireValue(state.graph, '画布尚未迁移', 'NOT_READY');
    const body = text(payload.text ?? '', '草稿消息', 5000000).trim();
    const intent = payload.intent ?? 'new'; requireValue(['new', 'amend'].includes(intent as string), '预览发送意图无效');
    const members = memberIds(state.graph, session.canvasId);
    const targets = isMinimalSession(session)?[]:strings(payload.targetIds ?? [], '目标').filter(ref => members.has(ref)), artifacts = strings(payload.artifactIds ?? [], '附件');
    const versions: Record<string, number> = {};
    for (const ref of artifacts) {
      const artifact = state.artifacts.find(value => value.id === ref && value.workspaceId === session.workspaceId && value.status !== 'deleted');
      requireValue(artifact, '草稿附件不属于当前工作区或已经删除', 'OUT_OF_SCOPE'); versions[ref] = artifact.version;
    }
    const attachmentError=attachmentBatchError([...new Set(artifacts)].map(id=>state.artifacts.find(a=>a.id===id)!),attachmentLimits(state),session);
    requireValue(!attachmentError,attachmentError??'', 'ATTACHMENT_LIMIT');
    const current = state.tasks.find(task => task.sessionId===session.id && task.status!=='completed');
    const amended=Boolean(current);
    let task: Task;
    if (amended && current) {
      task = current; task.instructionRevision++; task.updatedAt = now();
      task.inputBindings.artifactIds = [...new Set([...task.inputBindings.artifactIds, ...artifacts])];
      Object.assign(task.inputBindings.artifactVersions, versions);
      for (const call of state.toolCalls.filter(call => call.taskId === task.id && call.status === 'prepared')) {
        call.status = 'rejected'; call.result = JSON.stringify({ status: 'rejected', reason: '用户补充已接收，旧指令下的未执行调用已作废' });
      }
      if (task.interaction?.kind === 'structure') {
        task.interaction = undefined; task.status = 'queued';
        for (const call of state.toolCalls.filter(call => call.taskId === task.id && call.status === 'waiting')) {
          call.status = 'rejected'; call.result = JSON.stringify({ status: 'rejected', reason: '用户补充改变了提案依据，请重新规划' });
        }
      }
    } else {
      const draftRequestId = payload.clientMessageId === undefined ? '00000000-0000-4000-8000-000000000000' : text(payload.clientMessageId, '草稿请求 ID', 200);
      task = { id: 'task:00000000-0000-4000-8000-000000000000', sessionId: session.id, workspaceId: session.workspaceId, canvasId: session.canvasId,
        rootUserMessageId: `user:${session.id}:${draftRequestId}`, clientRequestId: draftRequestId, instructionRevision: 1, appliedInstructionRevision: 0,
        status: 'queued', createdAt: now(), updatedAt: now(), inputBindings: { targetIds: targets, artifactIds: artifacts,
          artifactVersions: versions },
        readHashes: {},
        ...defaultTaskBudget(state.provider), usedTokens: 0, stepCount: 0, fencingToken: 0,
        relatedTaskId: current?.id ?? (intent === 'amend' ? payload.targetTaskId as string | undefined : undefined) };
      state.tasks.push(task);
      if (intent === 'amend' && payload.targetTaskId) state.messages.push({ id: 'preview:associated-status', workspaceId: session.workspaceId, taskId: task.id,
        role: 'system', text: '原任务已结束，本条补充已保存为关联的新任务。', version: 1, status: 'complete', phase: 'status', createdAt: now(),
        relatedOperationIds: [], targetRefs: [], sourceRefs: [], instructionRevision: task.instructionRevision });
    }
    const draftMessageId = amended ? `user:${session.id}:${payload.clientMessageId ?? '00000000-0000-4000-8000-000000000000'}` : task.rootUserMessageId;
    state.messages.push({ id: draftMessageId, workspaceId: session.workspaceId, taskId: task.id,
      role: 'user', text: body, version: 1, status: 'complete', phase: amended ? 'amendment' : 'request', createdAt: now(), relatedOperationIds: [], targetRefs: targets,
      sourceRefs: artifacts.map(ref => ({ kind: 'artifact' as const, id: ref, version: versions[ref] })), instructionRevision: task.instructionRevision });
    state.messages.at(-1)!.partSeq=amended?(state.presentationParts?.filter(p=>p.taskId===task.id&&p.seq>0).at(-1)?.seq??1):0;
    state.messages.at(-1)!.attachments = artifacts.map(ref => ({ kind: 'artifact' as const, id: ref, version: versions[ref] }));
    registerSessionTask(state,session.id,task.id);
    claimTaskNotices(state,session.workspaceId,task.id);
    if(payload.progressSelection!==undefined){const message=state.messages.at(-1)!;message.progressSelection=normalizeProgressSelection(state,session.id,payload.progressSelection as NonNullable<SendInput['progressSelection']>);message.selectedProgress=selectedProgressPayload(state,session.id,message.progressSelection);}
    if (['queued', 'waiting_resource'].includes(task.status)) task.status = 'running';
    const protocol: ProtocolMessage[] = structuredClone(task.checkpoint?.protocol ?? []);
    if (protocol.length) {
      const requested = new Set(protocol.flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
      for (const call of state.toolCalls.filter(call => call.taskId === task.id && requested.has(call.providerCallId)
        && !protocol.some(message => message.role === 'tool' && message.toolCallId === call.providerCallId))) {
        if (call.result !== undefined) protocol.push({ role: 'tool', content: call.result, toolCallId: call.providerCallId });
      }
      if (task.instructionRevision > task.appliedInstructionRevision) for (const message of state.messages.filter(message => message.taskId === task.id
        && message.role === 'user' && (message.instructionRevision ?? 1) > task.appliedInstructionRevision)) {
        if (!protocol.some(value => value.role === 'user' && value.content === message.text)) protocol.push({ role: 'user', content: message.text });
      }
    }
    return sanitizeManifest(this.runtime.previewState(state, task, protocol.length ? protocol : undefined));
  }

  private async saveSettings(payload: Record<string, unknown>) {
    requireValue(object(payload.provider), '缺少提供方配置');
    const allowed = ['protocol', 'baseUrl', 'model', 'contextWindow', 'contextPresetTokens', 'maxInputTokens', 'workNotesPercent', 'maxOutputTokens', 'supportsTools', 'supportsVision', 'visionModels', 'webSearchEnabled', 'webSearchProvider', 'timeoutMs', 'idleTimeoutMs', 'chatTokenLimit', 'includeUsage', 'includeEncryptedReasoning', 'toolCallProtocol', 'stream', 'maxResponseBytes', 'apiFamily', 'thinkingEffort'];
    requireValue(Object.keys(payload.provider).every(key => allowed.includes(key)), '提供方配置含有未知字段；凭据只能放入独立凭据参数');
    const provider = (this.options.apiConfiguration ? this.options.apiConfiguration.executionSettings(payload.provider)
      : { ...this.repo.state.provider, ...structuredClone(payload.provider) }) as TransportProviderConfig;
    // Older clients that omit the additive setting must not reset a user's selected preset.
    if (!this.options.apiConfiguration && provider.contextPresetTokens === undefined) provider.contextPresetTokens = this.repo.state.provider.contextPresetTokens ?? 500000;
    validateProviderConfig(provider);
    const providerChanged = hash(Object.entries(provider).sort(([a], [b]) => a.localeCompare(b)))
      !== hash(Object.entries(this.repo.state.provider).sort(([a], [b]) => a.localeCompare(b)));
    requireValue(!providerChanged || !this.runtime.hasActiveRuns(), '模型调用或工具执行尚未停止，请先停止当前任务再更换提供方配置', 'PROVIDER_BUSY');
    requireValue(payload.credential === undefined || (typeof payload.credential === 'string' && payload.credential.length > 0 && payload.credential.length < 20000 && !/[\r\n]/.test(payload.credential)), '调用凭据格式无效');
    requireValue(payload.forgetCredential === undefined || typeof payload.forgetCredential === 'boolean', '忘记凭据开关无效');
    requireValue(!(payload.forgetCredential && payload.credential !== undefined), '不能同时保存和删除凭据');
    const endpointChanged = provider.baseUrl.replace(/\/+$/, '') !== this.repo.state.provider.baseUrl.replace(/\/+$/, '');
    const identityChanged = endpointChanged || provider.protocol !== this.repo.state.provider.protocol || provider.model !== this.repo.state.provider.model;
    const continuationChanged = identityChanged || provider.apiFamily !== this.repo.state.provider.apiFamily || provider.thinkingEffort !== this.repo.state.provider.thinkingEffort || provider.supportsTools !== this.repo.state.provider.supportsTools
      || provider.toolCallProtocol !== (this.repo.state.provider as TransportProviderConfig).toolCallProtocol
      || Boolean(provider.webSearchEnabled) !== Boolean(this.repo.state.provider.webSearchEnabled);
    const forgetCredential = payload.forgetCredential === true || (endpointChanged && payload.credential === undefined);
    const credentialChanged = Boolean(forgetCredential || payload.credential !== undefined);
    const previousStored = credentialChanged ? await this.options.credentialStorage?.get() : undefined;
    let restoreConfiguration: (() => void) | undefined;
    try {
      if (forgetCredential) await this.options.credentialStorage?.clear();
      else if (typeof payload.credential === 'string') await this.options.credentialStorage?.set(payload.credential);
      restoreConfiguration = this.options.apiConfiguration?.saveExecution(provider as ProviderConfig, payload.credential as string | undefined, forgetCredential);
      this.repo.transaction(state => {
        requireValue(!providerChanged || !this.runtime.hasActiveRuns(), '等待凭据存储期间任务已开始，请先停止再更换提供方配置', 'PROVIDER_BUSY');
        state.provider = provider as ProviderConfig;
        if (payload.credential !== undefined || (!forgetCredential && this.repo.credential)) state.setupCompleted = true;
        if (continuationChanged) {
          const replanning = new Set<string>();
          for (const call of state.toolCalls) if (['prepared', 'waiting'].includes(call.status)) { call.status = 'rejected'; call.result = undefined; replanning.add(call.taskId); }
          for (const change of state.changes) if (change.status === 'proposed') { change.status = 'superseded'; replanning.add(change.taskId); }
          for (const task of state.tasks) {
            if (task.checkpoint) for (const message of task.checkpoint.protocol) { delete message.responseItems; delete message.reasoningContent; }
            if (replanning.has(task.id) && task.status!=='completed') {
              task.checkpoint = undefined; task.interaction = undefined; task.fencingToken++;
              if (task.status !== 'queued') task.status = 'paused';
              task.error = '模型提供方或工具能力已改变，旧工具提案与私有续接已清除；续接时将按公开上下文重新规划。';
            }
          }
          state.contextManifests.forEach(sanitizeManifest);
        }
        this.repo.event('system', 'settings.updated', { provider: { protocol: provider.protocol, model: provider.model }, credentialChanged });
      });
    } catch (cause) {
      let configurationRestoreFailed = false;
      try { restoreConfiguration?.(); } catch { configurationRestoreFailed = true; }
      if (credentialChanged && this.options.credentialStorage) {
        try { if (previousStored) await this.options.credentialStorage.set(previousStored); else await this.options.credentialStorage.clear(); }
        catch {
          this.repo.credential = '';
          try { await this.options.credentialStorage.clear(); } catch { /* Recovery remains explicitly unsuccessful. */ }
          throw new DomainError('系统凭据存储恢复失败，已停止使用内存凭据；请重新配置。', 'CREDENTIAL_STORAGE_FAILED', 500);
        }
      }
      if (configurationRestoreFailed) throw new DomainError('API 配置文件恢复失败，请检查文件并重启应用。', 'API_CONFIG_RESTORE_FAILED', 500);
      throw cause;
    }
    if (forgetCredential) this.repo.credential = ''; else if (typeof payload.credential === 'string') this.repo.credential = payload.credential;
    this.runtime.clearSummaryCache(); this.runtime.kick(); return { provider: structuredClone(this.repo.state.provider), credentialConfigured: Boolean(this.repo.credential) };
  }

  private upload(payload: Record<string, unknown>): Promise<Artifact> {
    const session = this.userSession(payload.sessionId), bytes = decodeBase64(payload.dataBase64, attachmentLimits(this.repo.state).fileBytes);
    requireValue(bytes.length > 0, '上传资料为空'); requireValue(payload.artifactId === undefined, '上传会创建新资料，不覆盖已绑定的资料版本');
    const name = text(payload.name, '附件名称', 1000), mime = text(payload.mimeType ?? 'application/octet-stream', '附件 MIME', 256);
    const problem=attachmentBatchError([{name,mimeType:mime,size:bytes.length}],attachmentLimits(this.repo.state),session);
    requireValue(!problem,problem??'附件超过限制','ATTACHMENT_LIMIT');
    const jobId = id('upload:'), controller = new AbortController();
    const sourceHash = rawSha(bytes);
    this.repo.transaction(() => {touchTemporary(session);this.repo.event(session.workspaceId, 'artifact.started', { jobId, name });});
    const promise = parseArtifact(session.workspaceId, name, mime, bytes, { directory: this.artifactDirectory, signal: controller.signal, limits: attachmentLimits(this.repo.state), maxBytes: attachmentLimits(this.repo.state).fileBytes,
      imagesOnly:isMinimalSession(session),
      ocr: this.options.ocr ?? { dataPath: process.env.QIXUE_OCR_DATA_DIR ?? path.join(this.artifactDirectory, '..', 'ocr'), language: process.env.QIXUE_OCR_LANGUAGE ?? 'chi_sim+eng' },
      onProgress: progress => { if (this.repo.state.sessions.some(s => s.id === session.id)) this.repo.transaction(() => this.repo.event(session.workspaceId, 'artifact.progress', { jobId, ...progress })); } })
      .then(artifact => {
        requireValue(!controller.signal.aborted, '已取消附件解析，未加入消息；可重新上传继续解析', 'UPLOAD_CANCELLED');
        this.repo.transaction(state => {
          const owner = state.sessions.find(value => value.id === session.id);
          requireValue(owner?.lifecycle === 'active' && owner.workspaceId === session.workspaceId, '解析期间会话已归档或删除，未附加资料', 'SOURCE_CHANGED');
          const problem=attachmentBatchError([artifact],attachmentLimits(state),owner);
          requireValue(!problem,problem??'附件超过限制','ATTACHMENT_LIMIT');
          state.artifacts.push(artifact); state.workspaces.find(value => value.id === session.workspaceId)!.artifactIds.push(artifact.id);
          this.repo.event(session.workspaceId, controller.signal.aborted ? 'artifact.cancelled' : artifact.status === 'failed' ? 'artifact.failed' : 'artifact.completed',
            { jobId, artifactId: artifact.id, status: artifact.status, ...(artifact.error ? { error: artifact.error.slice(0, 2000) } : {}) });
        });
        return {...structuredClone(artifact),chunkCount:artifact.chunks.length,chunks:[]};
      }).catch(cause => {
        if (this.repo.state.sessions.some(s => s.id === session.id)) this.repo.transaction(() => this.repo.event(session.workspaceId, controller.signal.aborted ? 'artifact.cancelled' : 'artifact.failed',
          { jobId, error: cause instanceof Error ? cause.message.slice(0, 2000) : '资料解析未能完成。' }));
        throw cause;
      }).finally(() => {this.jobs.delete(jobId);const owner=this.repo.state.sessions.find(s=>s.id===session.id);if(owner&&!this.closed)this.repo.transaction(()=>touchTemporary(owner));});
    this.jobs.set(jobId, { id: jobId, workspaceId: session.workspaceId, sourceHash, controller, promise });
    return promise;
  }

  private deleteArtifact(payload: Record<string, unknown>) {
    const session = this.userSession(payload.sessionId);
    return this.repo.transaction(state => {
      const artifact = state.artifacts.find(value => value.id === payload.artifactId && value.workspaceId === session.workspaceId);
      requireValue(artifact && (payload.expectedVersion === undefined || payload.expectedVersion === artifact.version), '资料不属于工作区或版本已改变', 'VERSION_CONFLICT');
      const bound = state.tasks.filter(task => task.workspaceId === session.workspaceId && (task.inputBindings.artifactIds.includes(artifact.id) || effectiveArtifacts(state, task).some(value => value.ref.id === artifact.id)));
      requireValue(!bound.some(active), '请先停止引用该资料的活动任务', 'SOURCE_BUSY');
      artifact.status = 'deleted';
      for (const task of bound) task.checkpoint=undefined;
      this.repo.event(session.workspaceId, 'artifact.deleted', { artifactId: artifact.id }); this.runtime.clearSummaryCache(); return { ok: true };
    });
  }
  private objectPath(sourceHash: string) { requireValue(shaPattern.test(sourceHash), '资料对象标识无效'); return path.join(this.artifactDirectory, 'objects', sourceHash); }

  private async migrate(payload: Record<string, unknown>) {
    requireValue(!this.repo.state.graph, '现有图数据已迁移，不能用旧 localStorage 覆盖', 'ALREADY_MIGRATED');
    requireValue(object(payload.graph), '迁移图数据无效');
    const graph = normalizedGraph(structuredClone(payload.graph) as unknown as GraphState);
    const material = { graph };
    const backup = { format: 'qixue-graph-migration-v2', createdAt: now(), ...material, checksum: hash(material) };
    await fs.mkdir(path.join(this.artifactDirectory, 'migration'), { recursive: true });
    const file = path.join(this.artifactDirectory, 'migration', `${backup.checksum}.json`);
    await fs.writeFile(file, JSON.stringify(backup), { flag: 'wx' }).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const saved = JSON.parse(await fs.readFile(file, 'utf8')); requireValue(hash({ graph: saved.graph }) === backup.checksum, '已有迁移备份校验失败'); });
    this.repo.transaction(state => { requireValue(!state.graph, '图数据已经迁移', 'ALREADY_MIGRATED'); state.graph = graph; state.graphRevision++;
      reconcileSessionRoots(this.repo);
      this.repo.event('system', 'graph.migrated', { checksum: backup.checksum, graphRevision: state.graphRevision }); });
    return { ok: true, graphRevision: this.repo.state.graphRevision, backup };
  }

  private async exportBackup(): Promise<GraphBackup> {
    const graph = this.repo.state.graph; requireValue(graph, '尚无画布数据可导出', 'NOT_READY');
    const material = { graph };
    const backup: GraphBackup = { format: 'qixue-graph-backup-v1', exportedAt: now(), graph, checksum: hash(material) };
    requireValue(Buffer.byteLength(JSON.stringify(backup)) <= maximumBackupJsonBytes, '画布数据超过 120 MiB，未生成备份', 'BACKUP_TOO_LARGE');
    return backup;
  }
  private async importBackup(value: unknown) {
    requireValue(!this.jobs.size && !this.repo.state.tasks.some(active), '请先完成当前任务并停止资料解析，再导入画布数据', 'APPLICATION_BUSY');
    requireValue(object(value) && value.format === 'qixue-graph-backup-v1' && object(value.graph), '备份格式无效');
    requireValue(Buffer.byteLength(JSON.stringify(value)) <= maximumBackupJsonBytes, '画布数据超过 120 MiB，未导入', 'BACKUP_TOO_LARGE');
    const backup = value as unknown as GraphBackup;
    requireValue(hash({ graph: backup.graph }) === backup.checksum, '备份校验失败，未导入', 'CHECKSUM_MISMATCH');
    const graph = normalizedGraph(structuredClone(backup.graph));
    for (const session of this.repo.state.sessions) {
      const canvas = graph.canvases.find(canvas => canvas.canvasId === session.canvasId);
      requireValue(!canvas || session.lifecycle === 'deleted' || session.mode === 'temporary' || session.mode === (canvas.mode ?? 'explore'), '导入画布的模式与已有会话不一致，不能替换现有画布');
    }
    this.maintenance = true;
    try {
      this.repo.transaction(state => {
        requireValue(!state.tasks.some(active), '导入期间出现活动任务，未覆盖现有数据', 'APPLICATION_BUSY');
        if (state.graph) protectReviewWrites(state, state.graph, graph);
        state.graph = graph; state.graphRevision++;
        // Sessions live only as long as their canvas, and every cached projection is rebuilt.
        for (const session of state.sessions) if (!graph.canvases.some(canvas => canvas.canvasId === session.canvasId) && session.lifecycle === 'active') session.lifecycle = 'archived';
        for (const canvasId of Object.keys(state.canvasGraphReferences)) if (!graph.canvases.some(canvas => canvas.canvasId === canvasId)) delete state.canvasGraphReferences[canvasId];
        for (const workspace of state.workspaces) { workspace.canvasView = undefined; }
        reconcileSessionRoots(this.repo);
        this.repo.event('system', 'graph.imported', { checksum: backup.checksum, graphRevision: state.graphRevision });
      });
      this.runtime.clearSummaryCache(); return { ok: true, snapshot: this.snapshot() };
    } finally { this.maintenance = false; }
  }
  async cleanupExpiredTemporary(at=Date.now()):Promise<void> {
    if(this.expiryRunning||this.closed)return;this.expiryRunning=true;
    try {
      for(const session of [...this.repo.state.sessions])if(session.mode==='temporary'&&session.temporaryContext?.expiresAt&&Date.parse(session.temporaryContext.expiresAt)<=at){
        if(this.runtime.isSessionBusy(session.id)||[...this.jobs.values()].some(job=>job.workspaceId===session.workspaceId))continue;
        this.runtime.stopTemporary(session.id);this.sessions.closeTemporary(session.id);
      }
      await this.cleanupTemporaryArtifacts();
    } finally {this.expiryRunning=false;}
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.temporaryTimer);
    for (const job of this.jobs.values()) job.controller.abort();
    this.closing = (async () => {
      await Promise.allSettled([this.ready(), this.runtime.dispose(), ...[...this.jobs.values()].map(job => job.promise), this.settingsChain, ...this.operations]);
      this.runtime.clearSummaryCache(); this.repo.credential = '';
    })();
    return this.closing;
  }
}

function sanitizeManifest(manifest: ContextManifest): ContextManifest {
  delete manifest.stageDraft;
  for (const message of manifest.messages) { delete message.responseItems; delete message.reasoningContent; }
  for (const item of manifest.items) if (item.category === 'current_protocol') {
    try { const value: unknown = JSON.parse(item.text); if (object(value)) { delete value.responseItems; delete value.reasoningContent; item.text = JSON.stringify(value); } } catch { /* Non-protocol source remains visible. */ }
  }
  return manifest;
}

function rawSha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
