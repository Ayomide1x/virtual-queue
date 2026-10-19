import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/public-sans/800.css';
import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { I18nProvider } from './i18n';
import { installErrorReporting } from './lib/errorReporting';
import { applyLargeText, savedLargeText } from './lib/textSize';

// Before the first paint, so the page doesn't jump to the larger size.
applyLargeText(savedLargeText());
installErrorReporting();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <I18nProvider>
          <App />
        </I18nProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
