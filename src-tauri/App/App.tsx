import { useRef, useEffect } from 'react';
import { useTauriChat } from './hooks/useTauriChat';
import ChatMessage from './components/ChatMessage';
import ChatInput from './components/ChatInput';
import StatusBar from './components/StatusBar';
import './App.css';

function App() {
  const { messages, status, isStreaming, sendMessage, reloadAgent, shutdownAgent, error } =
    useTauriChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="app">
      <StatusBar status={status} onReload={reloadAgent} onShutdown={shutdownAgent} />

      {error &&<div className="error-banner">{error}</div>}

      <div className="messages-list">
        {messages.length === 0 && (
          <div className="messages-empty">
            Send a message to start the conversation.
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} role={msg.role} content={msg.content} timestamp={msg.timestamp} />
        ))}
        {isStreaming && (
          <div className="message message-assistant">
            <div className="message-bubble">
              <div className="message-content streaming-indicator">...</div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <ChatInput onSend={sendMessage} disabled={isStreaming} />
    </div>
  );
}

export default App;