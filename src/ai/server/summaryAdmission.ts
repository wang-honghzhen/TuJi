import type { ContextManifest } from '../domain';
import type { SummarySnapshot } from '../contextState';

/** Persisted summary metadata is not its executor prompt cost. */
export function summaryProjectionBenefits(next:ContextManifest,prior:ContextManifest):boolean {
  return (next.contextMetrics?.rawRequestTokens??next.requestTokens)<(prior.contextMetrics?.rawRequestTokens??prior.requestTokens)
    && !(next.error&&!next.capacityEstimateError&&next.error!==prior.error);
}

/** Preserve a profitable preferred batch, then admit additions individually. A
 * rejected expansion must not discard useful summaries from the same response.
 * Each projection must start from the same private maintenance snapshot. */
export function selectProjectedSummaries(options:{before:ContextManifest;preferred:SummarySnapshot[];candidates:SummarySnapshot[];
  project:(summaries:SummarySnapshot[])=>ContextManifest;canProject?:()=>boolean}):SummarySnapshot[] {
  let kept:SummarySnapshot[]=[],manifest=options.before;
  const attempt=(proposed:SummarySnapshot[])=>{
    const projected=options.project(proposed);
    if(summaryProjectionBenefits(projected,manifest)){kept=proposed;manifest=projected;}
  };
  if(options.preferred.length&&options.canProject?.()!==false)attempt(options.preferred);
  for(const item of options.candidates){
    if(kept.includes(item))continue;
    if(options.canProject?.()===false)break;
    attempt([...kept,item]);
  }
  return kept;
}
