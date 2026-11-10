import React from 'react';
import ReactDOM from 'react-dom/client';
import NewApp from './new/NewApp';
import { AppErrorBoundary, recordUiError } from './new/components/AppErrorBoundary';
import './new/new-ui.css';
import './new/space-theme.css';

const rootElement = document.getElementById('root');
window.addEventListener('error', event => { if (event.error) recordUiError(event.error); });
window.addEventListener('unhandledrejection', event => recordUiError(event.reason));

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AppErrorBoundary><NewApp /></AppErrorBoundary>
    </React.StrictMode>,
  );
}
