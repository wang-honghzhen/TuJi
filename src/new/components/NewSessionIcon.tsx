import { useEffect, useRef, type CSSProperties } from 'react';
import type { CanvasMode } from '@/v3/types';
import { GALAXY_MARK_SIZE } from '../newGalaxyMark';
import { NewGalaxyIcon } from './NewGalaxyIcon';

// One observer serves both sidebar and graph icons, including clipped scroll areas.
let visibilityObserver: IntersectionObserver | undefined;
let observedIcons = 0;
function observeIcon(element: HTMLElement) {
  visibilityObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) (entry.target as HTMLElement).dataset.inView = String(entry.isIntersecting);
  });
  visibilityObserver.observe(element);
  observedIcons++;
  return () => {
    visibilityObserver?.unobserve(element);
    if (--observedIcons === 0) { visibilityObserver?.disconnect(); visibilityObserver = undefined; }
  };
}

// Top/bottom outlines supply eight edges; front/back sides supply the other four.
// Four planes per cube avoid both doubled borders and twelve individual 3D layers.
const CUBE_PLANES = ['top', 'bottom', 'front', 'back'] as const;

function NewDesignIcon({ size, phase, active }: { size: number; phase: number; active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (ref.current) return observeIcon(ref.current); }, []);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const target = element.closest<HTMLElement>('.new-session-btn') ?? element;
    let hovered = target.matches(':hover');
    // Update the existing CSS animations' rates, preserving their current angles.
    // This runs only on interaction/media changes, never on an animation frame.
    const syncSpeed = () => {
      for (const cube of element.querySelectorAll('.new-design-cube')) {
        for (const animation of cube.getAnimations()) animation.updatePlaybackRate(active || hovered ? 2 : 1);
      }
    };
    const enter = () => { hovered = true; syncSpeed(); };
    const leave = () => { hovered = false; syncSpeed(); };
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    target.addEventListener('mouseenter', enter);
    target.addEventListener('mouseleave', leave);
    motion.addEventListener('change', syncSpeed);
    syncSpeed();
    return () => {
      target.removeEventListener('mouseenter', enter);
      target.removeEventListener('mouseleave', leave);
      motion.removeEventListener('change', syncSpeed);
    };
  }, [active]);
  return <span ref={ref} className="new-design-mark" aria-hidden="true" style={{
    width: size, height: size, '--cube-outer-size': `${size * .52}px`, '--cube-inner-size': `${size * .27}px`,
    '--cube-outer-delay': `${-phase * 13}s`, '--cube-inner-delay': `${-phase * 7}s`,
  } as CSSProperties}>
    {(['outer', 'inner'] as const).map(layer => <span key={layer} className={`new-design-cube new-design-cube-${layer}`}>
      {CUBE_PLANES.map(plane => <span key={plane} className={`new-design-cube-plane new-design-cube-${plane}`} />)}
    </span>)}
    <span className="new-design-core" />
  </span>;
}

/** Shared mode identity for canvas buttons and their ordinary sessions. */
export function NewSessionIcon({ mode, size = GALAXY_MARK_SIZE, phase = 0, active = false }: { mode: CanvasMode; size?: number; phase?: number; active?: boolean }) {
  return mode === 'design' ? <NewDesignIcon size={size} phase={phase} active={active} /> : <NewGalaxyIcon size={size} phase={phase} />;
}
