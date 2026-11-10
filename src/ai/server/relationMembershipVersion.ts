import { createHash } from 'node:crypto';
import type { GraphState } from '@/v3/types';
/** Relation membership/topology and edge bodies are independent read scopes. */
export function relationMembershipVersion(edges:GraphState['edges']){
  return createHash('sha256').update(JSON.stringify([...edges].sort((a,b)=>a.edgeId.localeCompare(b.edgeId))
    .map(e=>[e.edgeId,e.sourceNodeId,e.targetNodeId,e.directed,e.membershipFor??null]))).digest('hex');
}
