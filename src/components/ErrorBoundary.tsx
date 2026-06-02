import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. A render crash anywhere below would otherwise blank
 * the whole app; here we show a recoverable fallback instead. The notebook data
 * is safe in Yjs (IndexedDB + Neon) regardless of this UI error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] UI crashed:', error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-error">
        <div className="app-error__card">
          <h1 className="app-error__title">Đã xảy ra lỗi giao diện</h1>
          <p className="app-error__msg">
            Dữ liệu của bạn vẫn an toàn (lưu trong trình duyệt và trên server).
            Thử tải lại trang.
          </p>
          <pre className="app-error__detail">{error.message}</pre>
          <button className="app-error__btn" onClick={this.handleReload}>
            Tải lại
          </button>
        </div>
      </div>
    );
  }
}
