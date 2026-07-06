import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Changing this value resets the boundary (e.g. the pane's file path), so a
   * new file gets a fresh attempt after a previous one threw. */
  resetKey?: string;
  onClose?: () => void;
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Contains a render-time crash to one pane. A malformed viewer file (canvas /
 * base) that throws must NOT unmount the whole app — that would also poison
 * workspace restore into a crash loop, since the offending file reopens on
 * launch. Here the rest of the workspace stays alive and the tab is closable. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep it visible in the console; never silently swallow.
    console.error("Pane render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="pane-error">
          <div className="pane-error-title">⚠ Couldn't display this file</div>
          <div className="pane-error-msg">{this.state.error.message}</div>
          {this.props.onClose && (
            <button className="badge-btn" onClick={this.props.onClose}>
              Close tab
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
