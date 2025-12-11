import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    console.error('Component stack:', errorInfo.componentStack);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div style={{ padding: '20px', color: '#ff6b6b' }}>
          <p>Something went wrong. Your game state is safe on-chain.</p>
          <p style={{ fontSize: '12px', opacity: 0.7 }}>{this.state.error?.message}</p>
          {this.state.error?.stack && (
            <pre style={{ fontSize: '10px', opacity: 0.5, maxHeight: '100px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {this.state.error.stack}
            </pre>
          )}
          <button onClick={() => window.location.reload()}>
            Refresh
          </button>
          <button onClick={() => this.setState({ hasError: false, error: undefined, errorInfo: undefined })} style={{ marginLeft: '10px' }}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
