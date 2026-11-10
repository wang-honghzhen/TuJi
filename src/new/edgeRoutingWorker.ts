import { EdgeRoutingCache, type RoutingOptions } from '@/v3/edgeRouting';
import { RoutingDeltaReceiver, type RoutingDelta } from './edgeRoutingProtocol';
const cache = new EdgeRoutingCache();
const receiver = new RoutingDeltaReceiver();
self.onmessage = (event: MessageEvent<{ requestId: number; delta: RoutingDelta; options: RoutingOptions }>) => {
  const { requestId, delta, options } = event.data;
  const model = receiver.apply(delta);
  try { self.postMessage({ requestId, ...cache.route(model, options) }); }
  catch (error) { self.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) }); }
};
