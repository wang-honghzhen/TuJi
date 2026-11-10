import { nanoid } from 'nanoid';
import type { GraphState } from './types';

export function graphIdentities(state: GraphState): string[] {
  return [...Object.keys(state.nodes), ...Object.keys(state.documents),
    ...state.canvases.flatMap(canvas => [canvas.canvasId, ...Object.keys(canvas.directories)]),
    ...state.edges.map(edge => edge.edgeId)];
}

/** Reserve against all object types, including other creations in the same batch. */
export function graphIdAllocator(state: GraphState, generate: () => string = nanoid) {
  const used = new Set(graphIdentities(state));
  return (prefix = '') => {
    for (let attempt = 0; attempt < 256; attempt++) {
      const value = prefix + generate();
      if (!value || used.has(value)) continue;
      used.add(value); return value;
    }
    throw new Error('无法分配不重复的图对象 ID，未创建任何内容');
  };
}

export function validateGraphIdentities(state: GraphState) {
  const seen = new Set<string>();
  for (const id of graphIdentities(state)) {
    if (!id || seen.has(id)) throw new Error(`图对象 ID 重复或为空：${id}`);
    seen.add(id);
  }
  for (const [id, node] of Object.entries(state.nodes)) if (id !== node.nodeId) throw new Error(`节点 ID 与记录键不一致：${id}`);
  for (const [id, document] of Object.entries(state.documents)) if (id !== document.documentId) throw new Error(`文档 ID 与记录键不一致：${id}`);
}
