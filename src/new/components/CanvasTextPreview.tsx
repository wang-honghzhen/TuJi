import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { canvasTextVisibility, type CanvasTextRole } from '../canvasTextPresentation';

interface Props extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  zoom: number;
  textRole: CanvasTextRole;
  fontSize: number;
  lineHeight: number;
  maxLines?: number;
  wrap?: boolean;
  editing?: boolean;
  center?: boolean;
}

interface TextMeasurement {
  unclamp(): void;
  read(): () => void;
}
const measurements = new Map<Element, TextMeasurement>();
const pending = new Set<TextMeasurement>();
let observer: ResizeObserver | undefined;
let scheduled = false;

// Unclamp all changed fields, read their natural sizes in one layout pass,
// then apply the results. Interleaving these phases forces a layout per field.
function invalidate(measurement: TextMeasurement) {
  pending.add(measurement);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const batch = [...pending];
    pending.clear();
    for (const item of batch) item.unclamp();
    const updates = batch.map(item => item.read());
    for (const apply of updates) apply();
  });
}
const fontsChanged = () => measurements.forEach(invalidate);
function observeText(element: Element, measurement: TextMeasurement) {
  if (!observer) {
    observer = new ResizeObserver(entries => {
      for (const { target } of entries) {
        const item = measurements.get(target);
        if (item) invalidate(item);
      }
    });
    document.fonts?.addEventListener('loadingdone', fontsChanged);
  }
  measurements.set(element, measurement);
  observer.observe(element);
  invalidate(measurement);
  return () => {
    pending.delete(measurement);
    measurements.delete(element);
    observer?.unobserve(element);
    if (!measurements.size) {
      observer?.disconnect();
      observer = undefined;
      document.fonts?.removeEventListener('loadingdone', fontsChanged);
    }
  };
}

/** Keep full committed text available to details and assistive tools. Zoom-only
 * LOD updates use cached dimensions; measuring is reserved for layout changes. */
export function CanvasTextPreview({ children, zoom, textRole, fontSize, lineHeight, maxLines,
  wrap = false, editing = false, center = false, style, ...props }: Props) {
  const element = useRef<HTMLSpanElement>(null);
  const current = useRef({ zoom, textRole, editing }); current.current = { zoom, textRole, editing };
  const visible = useRef<boolean>();
  const updateVisibility = useRef<() => void>();
  useLayoutEffect(() => {
    const root = element.current; if (!root) return;
    const source = root.querySelector<HTMLElement>('[data-canvas-text-source]')!;
    let measured: { width: number; height: number; truncated: boolean; mode: string } | undefined;
    const applyVisibility = () => {
      if (!measured) return;
      const { zoom, textRole, editing } = current.current;
      const presentation = canvasTextVisibility(textRole, zoom, measured.width, measured.height, fontSize, lineHeight, visible.current);
      visible.current = presentation.visible;
      const hidden = !editing && (!presentation.visible || measured.mode === 'hidden');
      root.dataset.textLod = hidden ? 'hidden' : 'visible';
      root.dataset.textOverflow = String(measured.truncated || hidden || presentation.opacity < .99);
      root.dataset.textDisplay = editing ? 'editing' : hidden ? 'hidden' : measured.mode;
      root.style.opacity = String(editing ? 1 : presentation.opacity);
      source.style.visibility = hidden ? 'hidden' : 'visible';
    };
    updateVisibility.current = applyVisibility;
    const unclamp = () => {
      Object.assign(source.style, { display: 'block', visibility: 'visible', overflow: 'visible',
        maxHeight: 'none', webkitLineClamp: '', webkitBoxOrient: '', textOverflow: '',
        whiteSpace: wrap ? 'pre-wrap' : 'nowrap', wordBreak: wrap ? 'break-all' : 'normal' });
    };
    const read = () => {
      const { zoom } = current.current;
      const rect = root.getBoundingClientRect();
      // clientHeight rounds CSS pixels before scaling: at 59.1%, a 20.3046px
      // title used to become 20px and was incorrectly treated as zero lines.
      const width = rect.width / zoom, height = rect.height / zoom;
      const tolerance = .25 / zoom;
      const rows = Math.max(0, Math.min(maxLines ?? Infinity, Math.floor((height + tolerance) / lineHeight)));
      const naturalHeight = source.getBoundingClientRect().height / zoom;
      const truncated = naturalHeight > Math.min(height, rows * lineHeight) + tolerance || source.scrollWidth > width + tolerance;
      const mode = !truncated ? 'full' : rows > 0 ? 'clamp' : 'hidden';
      return () => {
        if (mode === 'clamp') Object.assign(source.style, {
          display: wrap ? '-webkit-box' : 'block', overflow: 'hidden', maxHeight: `${rows * lineHeight}px`,
          webkitLineClamp: wrap ? String(rows) : '', webkitBoxOrient: 'vertical', textOverflow: 'ellipsis',
        });
        root.dataset.textLines = String(rows);
        measured = { width, height, truncated, mode };
        applyVisibility();
      };
    };
    const unobserve = observeText(root, { unclamp, read });
    return () => { updateVisibility.current = undefined; unobserve(); };
  }, [children, wrap, center, fontSize, lineHeight, maxLines]);
  useLayoutEffect(() => { updateVisibility.current?.(); }, [zoom, textRole, editing]);
  return <span {...props} ref={element} data-canvas-text-preview data-text-role={textRole}
    style={{ display: 'block', position: 'relative', minWidth: 0, minHeight: 0, width: '100%', height: '100%',
      overflow: 'hidden', fontSize, lineHeight: `${lineHeight}px`, ...style }}>
    <span data-canvas-text-source style={{ display: 'block', width: '100%',
      position: center ? 'relative' : undefined, top: center ? '50%' : undefined, transform: center ? 'translateY(-50%)' : undefined }}>{children}</span>
  </span>;
}
