import { useEffect, useMemo, useRef, useState } from 'react';
import type { RenderModel, RenderEdge } from '@/v3/layout';
import { EdgeRoutingCache, type RoutingOptions, type RoutingStats } from '@/v3/edgeRouting';
import { previewCachedRoutes } from './routePreview';
import { RoutingDeltaEncoder, RoutingDeltaReceiver } from './edgeRoutingProtocol';

interface Input { model: RenderModel; options: RoutingOptions; interactive: boolean; canvasId: string; version: number }
interface Result { model: RenderModel; edges: RenderEdge[]; stats: RoutingStats; canvasId: string; sequence: number }

export function useEdgeRouting(model: RenderModel, options: RoutingOptions, interactive: boolean, canvasId: string) {
  const latest = useRef<Input>(), sequence = useRef(0), schedule = useRef<() => void>(() => {});
  const presentation = useRef<{ model: RenderModel; edges: RenderEdge[]; canvasId: string; sequence: number }>();
  const [result, setResult] = useState<Result>();
  const preview = useMemo(() => {
    const old = presentation.current;
    const accepted = result?.canvasId === canvasId && result.sequence !== old?.sequence ? result : undefined;
    const base = accepted ?? (old?.canvasId === canvasId ? old : undefined);
    const edges = base ? base.model === model ? base.edges : previewCachedRoutes(base.model, base.edges, model, options.expandedEdgeIds) : model.edges;
    presentation.current = { model, edges, canvasId, sequence: accepted?.sequence ?? old?.sequence ?? 0 };
    return edges;
  }, [result, model, canvasId, options.expandedEdgeIds]);

  useEffect(() => {
    let alive = true, worker: Worker | undefined, active: Input | undefined, timer: number | undefined;
    let sentAt = -Infinity, lastVersion = -1, refinements = 0, requestId = 0;
    const encoder = new RoutingDeltaEncoder(), receiver = new RoutingDeltaReceiver(), fallback = new EdgeRoutingCache();
    try { worker = new Worker(new URL('./edgeRoutingWorker.ts', import.meta.url), { type: 'module' }); } catch { /* Bounded same-router fallback. */ }
    const enqueue = () => {
      if (!alive || active || timer !== undefined || latest.current?.canvasId !== canvasId) return;
      const interval = latest.current.interactive ? 48 : 24;
      timer = window.setTimeout(run, Math.max(0, interval - (performance.now() - sentAt)));
    };
    const complete = (job: Input, edges?: RenderEdge[], stats?: RoutingStats) => {
      if (!alive) return;
      active = undefined;
      const current = latest.current;
      // A drag may advance while a worker is busy. Only its path is reused; previewCachedRoutes
      // projects it onto the newest endpoints. Once released, discard late geometry entirely.
      if (current?.canvasId === canvasId && (current.model === job.model || current.interactive) && edges && stats) {
        const originals = new Map(job.model.edges.map(e => [e.edge.edgeId, e.edge]));
        setResult({ model: job.model, edges: edges.map(e => ({ ...e, edge: originals.get(e.edge.edgeId)! })), stats, canvasId, sequence: ++sequence.current });
      }
      if (current?.version !== job.version) { refinements = 0; enqueue(); }
      else if (stats?.pending && refinements++ < (current?.interactive ? 2 : 12)) enqueue();
    };
    const run = () => {
      timer = undefined;
      const job = latest.current; if (!alive || !job || job.canvasId !== canvasId || active) return;
      if (lastVersion !== job.version) { refinements = 0; lastVersion = job.version; }
      const shown = presentation.current;
      const displayed = shown?.canvasId === canvasId ? shown.model === job.model ? shown.edges : previewCachedRoutes(shown.model, shown.edges, job.model, job.options.expandedEdgeIds) : job.model.edges;
      const delta = encoder.encode(job.model, displayed);
      // Also retain the tiny wire state locally so a worker crash can fall back without requesting a full snapshot.
      const wire = receiver.apply(delta);
      const routingOptions = { ...job.options, interactive: job.interactive, budgetMs: worker ? job.interactive ? 12 : 120 : 5 };
      active = job; sentAt = performance.now();
      if (worker) worker.postMessage({ requestId: ++requestId, delta, options: routingOptions });
      else {
        const routed = fallback.route(wire, routingOptions); complete(job, routed.edges, routed.stats);
      }
    };
    if (worker) {
      worker.onmessage = event => {
        const reply = event.data as { requestId: number; edges?: RenderEdge[]; stats?: RoutingStats; error?: string };
        if (!alive || !active || reply.requestId !== requestId) return;
        if (reply.error) { worker?.terminate(); worker = undefined; const job = active; complete(job); enqueue(); }
        else complete(active, reply.edges, reply.stats);
      };
      worker.onerror = () => { worker?.terminate(); worker = undefined; active = undefined; enqueue(); };
    }
    schedule.current = enqueue;
    return () => { alive = false; window.clearTimeout(timer); worker?.terminate(); schedule.current = () => {}; };
  }, [canvasId]);

  useEffect(() => {
    latest.current = { model, options, interactive, canvasId, version: (latest.current?.version ?? 0) + 1 };
    // The timer is not canceled by every pointer event: continuous movement must not starve the worker.
    schedule.current();
  }, [model, options, interactive, canvasId]);
  return { edges: preview, sequence: result?.canvasId === canvasId ? result.sequence : 0,
    stats: result?.canvasId === canvasId && result.model === model ? result.stats : undefined };
}
