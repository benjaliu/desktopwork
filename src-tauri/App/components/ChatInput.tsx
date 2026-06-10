import { useState } from 'react';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

export default function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || disabled) return;
    onSend(value);
    setValue('');
  }

  return (
    <form className="chat-input-form" onSubmit={handleSubmit}>
      <input
        className="chat-input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type a message..."
        disabled={disabled}
        autoComplete="off"
      />
      <button className="chat-send-btn" type="submit" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  );
}