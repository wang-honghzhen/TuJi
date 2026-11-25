import { GitMerge, Share2, Workflow } from 'lucide-react';

interface Props {
  edges: readonly { id: 'cross' | 'internal'; label: string; key: string; shown: boolean; onChange: (shown: boolean) => void }[];
  aggregation: boolean | 'mixed';
  onAggregation: () => void;
}

export function CanvasDisplayOptions({ edges, aggregation, onAggregation }: Props) {
  return <div role="group" aria-label="画布关系" className="canvas-edge-toggles">
    {edges.map(edge => {
      const Icon = edge.id === 'cross' ? Workflow : Share2;
      return <button type="button" key={edge.id} data-canvas-edge-toggle={edge.id} data-edge-filter={edge.label}
        aria-label={edge.label} aria-pressed={edge.shown}
        title={`显示或隐藏${edge.label}（${edge.key}）`} onClick={() => edge.onChange(!edge.shown)}><Icon size={17} aria-hidden="true" /></button>;
    })}
    <button type="button" data-canvas-edge-toggle="aggregate" aria-label="收束跨子图边" aria-pressed={aggregation}
      title={aggregation === true ? '展开全部跨子图边（Shift+R）' : '收束全部跨子图边（Shift+R）'}
      onClick={onAggregation}><GitMerge size={17} aria-hidden="true" /></button>
  </div>;
}
