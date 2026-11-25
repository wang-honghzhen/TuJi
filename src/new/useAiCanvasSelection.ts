import { useMemo, useState } from 'react';

const EMPTY_REFS: readonly string[] = [];

interface Visit {
  key: string;
  includePart: boolean;
  located?: readonly string[];
  explicitlyLocated?: boolean;
  excluded: readonly string[];
}

/** AI references only affect canvas highlighting and filtering, never the user's chat selection. */
export function useAiCanvasSelection(key: string, previouslyLocated: boolean, partRefs: readonly string[], filtered: boolean) {
  const initialVisit = (): Visit => ({ key, includePart: !previouslyLocated, excluded: EMPTY_REFS });
  const [visit, setVisit] = useState(initialVisit);
  // Capture first-visit eligibility at entry. An acknowledgement arriving halfway
  // through the current part must not remove references already on the canvas.
  if (visit.key !== key) setVisit(initialVisit());
  const refs = visit.located ?? (!filtered || visit.includePart ? partRefs : EMPTY_REFS);
  const targets = useMemo(() => {
    const ids = new Set(refs);
    for (const id of visit.excluded) ids.delete(id);
    return ids;
  }, [refs, visit.excluded]);
  return {
    targets,
    explicitlyLocated: visit.key === key && !!visit.explicitlyLocated,
    needsPartLocation: !visit.includePart || !!visit.located || !!visit.excluded.length,
    locate: (located?: readonly string[], visitKey = key) => setVisit({ key: visitKey, located, explicitlyLocated: true, includePart: true, excluded: EMPTY_REFS }),
    dismiss: (id: string) => setVisit(current => current.key === key && !current.excluded.includes(id)
      ? { ...current, excluded: [...current.excluded, id] } : current),
  };
}
