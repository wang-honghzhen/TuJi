import { useLayoutEffect, useRef } from 'react';
import type { GranularityIndex } from '../canvasGranularity';
import { useGraphAppearance } from '../graphAppearance';

export function GranularityObjectSelect({ id, index, name, onChoose }: {
  id: string; index: GranularityIndex; name: (id: string) => string; onChoose: (id: string) => void;
}) {
  const element = useRef<HTMLSelectElement>(null);
  const appearance = useGraphAppearance();

  // Chromium's customizable select preserves native keyboard navigation and type-ahead.
  // Build its rich options using DOM APIs because React 18 only accepts text inside options.
  useLayoutEffect(() => {
    const select = element.current!;
    const button = document.createElement('button');
    button.append(document.createElement('selectedcontent'));
    const group = (label: string) => {
      const section = document.createElement('optgroup');
      section.label = label;
      return section;
    };
    const groups = group('子图'), relations = group('子图间关系');
    const paths = new Map<string, string[]>();
    function path(key: string): string[] {
      const found = paths.get(key);
      if (found) return found;
      const parent = index.parents.get(key);
      const ids = parent && parent !== index.rootId ? [...path(parent), key] : [key];
      paths.set(key, ids);
      return ids;
    }
    const labels = new Map<string, HTMLSpanElement>();
    function appendPath(option: HTMLOptionElement, key: string) {
      path(key).forEach((part, i) => {
        if (i) option.append(' / ');
        let label = labels.get(part);
        if (!label) {
          const { kind, accent } = appearance(part);
          label = document.createElement('span');
          label.className = 'graph-name-label';
          label.dataset.pathKind = kind;
          label.dataset.pathId = part;
          label.style.setProperty('--graph-node-accent', accent);
          label.textContent = name(part);
          labels.set(part, label);
        }
        option.append(label.cloneNode(true));
      });
    }
    for (const key of index.groupIds) {
      const option = new Option('', key);
      appendPath(option, key);
      groups.append(option);
    }
    for (const pair of index.relations.values()) {
      const option = new Option('', pair.id);
      appendPath(option, pair.sourceSubgraphId);
      option.append(pair.directed ? ' → ' : ' — ');
      appendPath(option, pair.targetSubgraphId);
      option.append(` (${pair.relationCount})`);
      relations.append(option);
    }
    select.replaceChildren(button, groups, relations);
  }, [appearance, index, name]);
  useLayoutEffect(() => { element.current!.value = id; }, [id, appearance, index, name]);
  return <select ref={element} className="granularity-object-select" aria-label="切换要调整的子图或关系"
    onChange={event => onChoose(event.currentTarget.value)} />;
}
