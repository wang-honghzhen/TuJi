import { useEffect, useState } from 'react';

/** Global canvas listeners must not act behind another foreground surface. */
export function canvasInteractionBlocked(target?: EventTarget | null, checkText = false): boolean {
  if (document.getElementById('root')?.inert || document.querySelector('[data-ai-settings-page], [aria-modal="true"]')) return true;
  if (!checkText) return false;
  const editable = (value: EventTarget | null | undefined) => value instanceof Element
    && !!value.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"]');
  return editable(target) || editable(document.activeElement);
}

/** Dialogs are portalled, so observe their lifecycle as well as native focus. */
export function useCanvasForeground(): boolean {
  const read = () => document.visibilityState === 'visible' && document.hasFocus() && !canvasInteractionBlocked();
  const [foreground, setForeground] = useState(read);
  useEffect(() => {
    const update = () => setForeground(read());
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['inert', 'aria-modal'] });
    window.addEventListener('focus', update); window.addEventListener('blur', update); document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  return foreground;
}
