import React from 'react';
import ReactDOM from 'react-dom/client';
import NewApp from './new/NewApp';
import { AppErrorBoundary, recordUiError } from './new/components/AppErrorBoundary';
import { DesktopWindowControls } from './desktop/DesktopWindowControls';
import { DesktopAuxiliary } from './desktop/DesktopAuxiliary';
import { initializePanelBridge } from './desktop/panelState';
import './new/new-ui.css';
import './new/space-theme.css';

const rootElement = document.getElementById('root');
document.documentElement.dataset.desktopRole = window.tujiDesktop?.role ?? 'main';
initializePanelBridge();
window.addEventListener('error', event => { if (event.error) recordUiError(event.error); });
window.addEventListener('unhandledrejection', event => recordUiError(event.reason));

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <DesktopWindowControls />
      <AppErrorBoundary>{window.tujiDesktop && window.tujiDesktop.role !== 'main' ? <DesktopAuxiliary /> : <NewApp />}</AppErrorBoundary>
    </React.StrictMode>,
  );
}
