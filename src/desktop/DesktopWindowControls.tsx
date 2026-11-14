import { Minus } from 'lucide-react';
import './window-controls.css';

export function DesktopWindowControls() {
  const controls = window.tujiWindow;
  if (!controls) return null;
  return <>
    <div className="desktop-drag-region" aria-hidden="true" />
    <div className="desktop-window-controls" role="group" aria-label="窗口操作" tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        }
      }}>
      <div className="desktop-window-buttons">
        <button type="button" className="desktop-window-button" aria-label="最小化" title="最小化为悬浮球"
          onClick={() => controls.minimize()}><Minus size={15} strokeWidth={1.5} aria-hidden="true" /></button>
      </div>
    </div>
  </>;
}
