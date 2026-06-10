interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export default function ChatMessage({ role, content, timestamp }: ChatMessageProps) {
  const timeStr = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`message message-${role}`}>
      <div className="message-bubble">
        <div className="message-content">{content || '...'}</div>
        <div className="message-time">{timeStr}</div>
      </div>
    </div>
  );
}