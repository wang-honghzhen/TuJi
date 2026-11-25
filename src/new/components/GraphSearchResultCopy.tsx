import type { GraphSearchResult } from '../graphSearch';
import type { GraphPath } from '@/v3/paths';
import { GraphNameLabel, GraphPathLabel } from './GraphPathLabel';
import { SearchHighlight } from './SearchField';

export function GraphSearchResultCopy({ result, query }: { result: GraphSearchResult; query: string }) {
  const { source, target, separator } = result;
  const title = (row: GraphPath) => {
    const segment = row.segments[row.segments.length - 1];
    return <GraphNameLabel {...segment}><SearchHighlight text={segment.name} query={query} /></GraphNameLabel>;
  };
  const path = (row: GraphPath, suffix?: string) => <><GraphPathLabel segments={row.segments} />{suffix && ' · ' + suffix}</>;
  return <span className="graph-search-result-copy">
    <strong>{title(source)}{target && <>{separator}{title(target)}</>}</strong>
    <small title={result.path}>{path(source, result.sourceSuffix)}{target && <>{separator}{path(target, result.targetSuffix)}</>}</small>
    {result.detail && <span><SearchHighlight text={result.detail} query={query} /></span>}
  </span>;
}
