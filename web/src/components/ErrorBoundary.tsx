import { Component, type ReactNode } from 'react';
import { reportError } from '../lib/errorReporting';

/** If a page crashes, show a way out instead of a blank screen, and report it. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    reportError('react', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    // Bilingual: the language setting lives in the part of the app that just failed.
    return (
      <main id="main" className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-2xl font-extrabold text-navy-900">Something went wrong · Algo salió mal</h1>
        <p className="mt-3 text-lg text-muted">
          Please reload the page. Your place in line is safe. · Vuelva a cargar la página. Su lugar en la fila está guardado.
        </p>
        <button type="button" className="btn-primary mt-8" onClick={() => location.reload()}>
          Reload · Recargar
        </button>
      </main>
    );
  }
}
