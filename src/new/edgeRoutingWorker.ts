import { EdgeRoutingCache, type RoutingOptions } from '@/v3/edgeRouting';
import { RoutingDeltaReceiver, RoutingFrameEncoder, type RoutingDelta } from './edgeRoutingProtocol';
const cache = new EdgeRoutingCache();
const receiver = new RoutingDeltaReceiver();
const frames = new RoutingFrameEncoder();
self.onmessage = (event: MessageEvent<{ requestId: number; delta: RoutingDelta; options: RoutingOptions }>) => {
  const { requestId, delta, options } = event.data;
  const model = receiver.apply(delta);
  try {
    const { edges, stats } = cache.route(model, options);
    self.postMessage({ requestId, frame: frames.encode(edges), stats });
  }
  catch (error) { self.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) }); }
};
