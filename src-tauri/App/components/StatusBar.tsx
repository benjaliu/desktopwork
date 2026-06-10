import type { AgentStatus } from '../hooks/useTauriChat';

interface StatusBarProps {
  status: AgentStatus;
  onReload: () => void;
  onShutdown: () => void;
}

export default function StatusBar({ status, onReload, onShutdown }: StatusBarProps) {
  const statusLabel: Record<AgentStatus, string> = {
    running: 'Running',
    stopped: 'Stopped',
    loading: 'Loading...',
  };

  return (
    <div className="status-bar">
      <div className="status-indicator">
        <span className={`status-dot status-${status}`} />
        <span className="status-label">{statusLabel[status]}</span>
      </div>
      <div className="status-actions">
        <button
          className="status-btn"
          onClick={onReload}
          disabled={status === 'loading'}
          title="Reload Agent"
        >
          Reload
        </button>
        <button
          className="status-btn status-btn-stop"
          onClick={onShutdown}
          disabled={status === 'stopped' || status === 'loading'}
          title="Shutdown Agent"
        >
          Stop
        </button>
      </div>
    </div>
  );
}