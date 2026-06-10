import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export type AgentStatus = 'running' | 'stopped' | 'loading';

interface UseTauriChatReturn {
  messages: Message[];
  status: AgentStatus;
  isStreaming: boolean;
  sendMessage: (content: string) => Promise<void>;
  reloadAgent: () => Promise<void>;
  shutdownAgent: () => Promise<void>;
  error: string | null;
}

export function useTauriChat(): UseTauriChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<AgentStatus>('stopped');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamedMessageIdRef = useRef<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await invoke<string>('agent_status');
      setStatus(s as AgentStatus);
    } catch {
      // Agent may not be running yet
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    const unlisten = listen<{ token: string; delta: string }>('streaming-delta', (event) => {
      const { delta } = event.payload;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const currentId = streamedMessageIdRef.current;
        if (last && last.id === currentId && last.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + delta },
          ];
        }
        return prev;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim()) return;
    setError(null);

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: content.trim(),
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);

    setIsStreaming(true);

    const assistantMsgId = crypto.randomUUID();
    const assistantMsg: Message = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, assistantMsg]);
    streamedMessageIdRef.current = assistantMsgId;

    try {
      await invoke('chat_send', { message: content.trim() });
    } catch (err) {
      setError(String(err));
      setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
    } finally {
      setIsStreaming(false);
    }
  }, []);

  const reloadAgent = useCallback(async () => {
    setStatus('loading');
    try {
      await invoke('agent_reload');
      await fetchStatus();
    } catch (err) {
      setError(String(err));
      setStatus('stopped');
    }
  }, [fetchStatus]);

  const shutdownAgent = useCallback(async () => {
    try {
      await invoke('agent_shutdown');
      setStatus('stopped');
    } catch (err) {
      setError(String(err));
    }
  }, []);

  return { messages, status, isStreaming, sendMessage, reloadAgent, shutdownAgent, error };
}