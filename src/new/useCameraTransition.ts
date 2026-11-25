import { useCallback, useEffect, useRef } from 'react';

/** Keep the camera interruptible while following a new neighborhood focus. */
export function useCameraTransition() {
  const frame = useRef<number>();
  const cancel = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel]);
  const animate = useCallback((paint: (progress: number) => void) => {
    cancel();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(1);
      return;
    }
    let start: number | undefined;
    function step(now: number) {
      start ??= now;
      const t = Math.min(1, (now - start) / 300);
      paint(t * t * (3 - 2 * t));
      frame.current = t < 1 ? requestAnimationFrame(step) : undefined;
    }
    frame.current = requestAnimationFrame(step);
  }, [cancel]);
  return { animate, cancel };
}
