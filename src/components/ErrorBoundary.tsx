import React from 'react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || 'An unexpected error occurred.',
    };
  }

  componentDidCatch(error: Error): void {
    console.error('Application ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      let parsedMsg = this.state.message;
      try {
        const parsed = JSON.parse(this.state.message) as { error?: string; operationType?: string; path?: string };
        if (parsed.error) {
          parsedMsg = `Database permission or sync issue (${parsed.operationType ?? 'read'} on ${parsed.path ?? 'room'}): ${parsed.error}`;
        }
      } catch {
        // Keep plain message
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-[#FAF8F4] px-6">
          <div className="max-w-md w-full bg-white border border-[#E5E1D8] rounded-xl p-8 space-y-4">
            <h1 className="font-display text-2xl font-semibold text-[#1C1917]">
              Something went wrong
            </h1>
            <p className="text-sm text-[#57534E] leading-relaxed">{parsedMsg}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2.5 text-sm font-medium bg-[#0F5132] text-white rounded-lg hover:bg-[#0B3D25] transition-colors whitespace-nowrap"
            >
              Reload Arena
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
