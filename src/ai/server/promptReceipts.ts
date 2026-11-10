import { rollbackReview } from '../changeReview';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Strip only application-owned bookkeeping. Never walk into user/tool body text,
 * unknown business fields, arguments, or failure details. Durable receipts stay intact. */
export function promptReceipt(name: string, value: unknown): unknown {
  if (!object(value)) return value;
  if(['graph_propose_changes','graph_apply_changes'].includes(name)) {
    const {affectedCanvasIds:_canvasIds,userReview:review,...result}=value;
    const userReview=rollbackReview(review);
    return {...result,...(userReview?{userReview}:{})};
  }
  if (name === 'workspace_search_artifacts') {
    const page = (input: unknown): unknown => {
      if (!object(input)) return input;
      const result = { ...input };
      if (Array.isArray(result.hits)) result.hits = result.hits.map(hit => {
        if (!object(hit)) return hit;
        const { hash: _hash, ...content } = hit; return content;
      });
      for (const key of ['page', 'data', 'expandedPages']) {
        if (Array.isArray(result[key])) result[key] = (result[key] as unknown[]).map(page);
        else if (object(result[key])) result[key] = page(result[key]);
      }
      return result;
    };
    return page(value);
  }
  if (name === 'context_view') {
    const entry=(row:unknown):unknown=>{
      if(!object(row))return row;
      const result={...row};
      for(const key of ['alreadyDisplayed','displayedSummaries','remainingSummaries']) {
        if(Array.isArray(result[key])&&!(result[key] as unknown[]).length)delete result[key];
      }
      for(const [list,count] of [['displayedSummaries','displayedSummaryCount'],['remainingSummaries','remainingSummaryCount']]) {
        if(result[count]===0||Array.isArray(result[list])&&result[count]===(result[list] as unknown[]).length)delete result[count];
      }
      for(const key of ['displayedSummariesTruncated','remainingSummariesTruncated','batchGrowthStopped'])if(result[key]===false)delete result[key];
      return result;
    };
    return {...entry(value) as Record<string,unknown>,...(Array.isArray(value.results)?{results:value.results.map(entry)}:{})};
  }
  return value;
}
