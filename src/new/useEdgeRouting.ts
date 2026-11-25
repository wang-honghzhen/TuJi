import { useEffect, useMemo, useRef, useState } from 'react';
import type { RenderModel, RenderEdge } from '@/v3/layout';
import { EdgeRoutingCache, type RoutingOptions, type RoutingStats } from '@/v3/edgeRouting';
import { previewCachedRoutes } from './routePreview';
import { RoutingDeltaEncoder, RoutingDeltaReceiver, RoutingFrameReceiver, type RoutingFrame } from './edgeRoutingProtocol';

interface Input { model: RenderModel; options: RoutingOptions; interactive: boolean; canvasId: string; version: number; expandedKey: string }
interface Result { model: RenderModel; edges: RenderEdge[]; stats: RoutingStats; canvasId: string; sequence: number; expandedKey: string }

function displayedRoutes(model: RenderModel, expandedIds: string[] | undefined, expandedKey: string, previous?: Omit<Result, 'stats'>) {
  if (previous?.model === model && previous.expandedKey === expandedKey) return previous.edges;
  return previewCachedRoutes(previous?.model ?? model, previous?.edges ?? [], model, expandedIds);
}

function onlyViewportMoved(previous: Input | undefined, next: Input) {
  if (!previous || previous.version === next.version || previous.model !== next.model || previous.interactive !== next.interactive) return false;
  const a = previous.options, b = next.options, from = a.viewport, to = b.viewport;
  if (!from || !to || from.width !== to.width || from.height !== to.height || (from.x === to.x && from.y === to.y)) return false;
  const before = a.expandedEdgeIds ?? [], after = b.expandedEdgeIds ?? [];
  return a.labels === b.labels && before.length === after.length && before.every((id, i) => id === after[i]);
}

export function useEdgeRouting(model: RenderModel, options: RoutingOptions, interactive: boolean, canvasId: string, enabled = true) {
  const latest = useRef<Input>(), sequence = useRef(0), schedule = useRef<() => void>(() => {});
  const presentation = useRef<Omit<Result, 'stats'>>();
  const [result, setResult] = useState<Result>();
  const expandedKey = JSON.stringify(options.expandedEdgeIds ?? []);
  const preview = useMemo(() => {
    if (!enabled) return model.edges;
    const old = presentation.current;
    const accepted = result?.canvasId === canvasId && result.sequence !== old?.sequence ? result : undefined;
    const base = accepted ?? (old?.canvasId === canvasId ? old : undefined);
    const edges = displayedRoutes(model, options.expandedEdgeIds, expandedKey, base);
    presentation.current = { model, edges, canvasId, expandedKey, sequence: accepted?.sequence ?? old?.sequence ?? 0 };
    return edges;
  }, [enabled, result, model, canvasId, expandedKey]);

  useEffect(() => {
    let alive = true, worker: Worker | undefined, active: Input | undefined, timer: number | undefined;
    let sentAt = -Infinity, scheduledAt = 0, lastVersion = -1, refinements = 0, requestId = 0;
    let lastSent: Input | undefined;
    const encoder = new RoutingDeltaEncoder(), receiver = new RoutingDeltaReceiver(), fallback = new EdgeRoutingCache();
    const frames = new RoutingFrameReceiver();
    try { worker = new Worker(new URL('./edgeRoutingWorker.ts', import.meta.url), { type: 'module' }); } catch { /* Bounded same-router fallback. */ }
    const enqueue = () => {
      const job = latest.current;
      if (!alive || active || job?.canvasId !== canvasId) return;
      // Paths move immediately with the world transform. Only labels near the
      // viewport boundary need a worker update during a continuous pan.
      const interval = onlyViewportMoved(lastSent, job) ? 160 : job.interactive ? 48 : 24;
      const due = sentAt + interval;
      if (timer !== undefined && scheduledAt <= due) return;
      window.clearTimeout(timer);
      scheduledAt = due;
      timer = window.setTimeout(run, Math.max(0, due - performance.now()));
    };
    const complete = (job: Input, frame?: RoutingFrame, stats?: RoutingStats) => {
      if (!alive) return;
      active = undefined;
      const current = latest.current;
      // Consume every reply in sequence, including superseded drag previews.
      const edges = frame === undefined ? undefined : frames.apply(frame, job.model);
      // A drag may advance while a worker is busy. Only its path is reused; previewCachedRoutes
      // projects it onto the newest endpoints. Once released, discard late geometry entirely.
      if (current?.canvasId === canvasId && (current.model === job.model || current.interactive) && edges && stats) {
        setResult({ model: job.model, expandedKey: job.expandedKey, edges, stats, canvasId, sequence: ++sequence.current });
      }
      if (current?.version !== job.version) { refinements = 0; enqueue(); }
      else if (stats?.pending && refinements++ < (current?.interactive ? 2 : 12)) enqueue();
    };
    const run = () => {
      timer = undefined;
      const job = latest.current; if (!alive || !job || job.canvasId !== canvasId || active) return;
      if (lastVersion !== job.version) { refinements = 0; lastVersion = job.version; }
      const shown = presentation.current;
      const displayed = displayedRoutes(job.model, job.options.expandedEdgeIds, job.expandedKey, shown?.canvasId === canvasId ? shown : undefined);
      const delta = encoder.encode(job.model, displayed);
      // Also retain the tiny wire state locally so a worker crash can fall back without requesting a full snapshot.
      const wire = receiver.apply(delta);
      const routingOptions = { ...job.options, interactive: job.interactive, budgetMs: worker ? job.interactive ? 12 : 120 : 5 };
      active = job; lastSent = job; sentAt = performance.now();
      if (worker) worker.postMessage({ requestId: ++requestId, delta, options: routingOptions });
      else {
        const routed = fallback.route(wire, routingOptions); complete(job, routed.edges, routed.stats);
      }
    };
    if (worker) {
      worker.onmessage = event => {
        const reply = event.data as { requestId: number; frame?: RoutingFrame; stats?: RoutingStats; error?: string };
        if (!alive || !active || reply.requestId !== requestId) return;
        if (reply.error) { worker?.terminate(); worker = undefined; const job = active; complete(job); enqueue(); }
        else complete(active, reply.frame, reply.stats);
      };
      worker.onerror = () => { worker?.terminate(); worker = undefined; active = undefined; enqueue(); };
    }
    schedule.current = enqueue;
    return () => { alive = false; window.clearTimeout(timer); worker?.terminate(); schedule.current = () => {}; };
  }, [canvasId]);

  useEffect(() => {
    if (!enabled) return;
    latest.current = { model, options, interactive, canvasId, expandedKey, version: (latest.current?.version ?? 0) + 1 };
    // The timer is not canceled by every pointer event: continuous movement must not starve the worker.
    schedule.current();
  }, [enabled, model, options, interactive, canvasId]);
  return { edges: preview, sequence: result?.canvasId === canvasId ? result.sequence : 0,
    stats: result?.canvasId === canvasId && result.model === model && result.expandedKey === expandedKey ? result.stats : undefined };
}
