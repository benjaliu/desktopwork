// window.agent — injected by Node HTTP Server
const agent = {
  _getHeaders() {
    const token = window.auth?.getToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { 'x-desktop-work-token': token } : {}),
    };
  },

  /**
   * Send a message and get a streaming response via SSE.
   * @param {string} message
   * @param {{ sessionId?: string|null, onDelta?: (delta: string) => void, onEnd?: (content: string) => void, onError?: (err: string) => void }} opts
   * @returns {Promise<{ text: string }>}
   */
  async chat(message, { sessionId = null, onDelta, onEnd, onError } = {}) {
    const res = await fetch('/api/bot-chat/chat', {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({ message, sessionId }),
    });

    if (!res.ok) {
      let errMsg = res.statusText;
      try { const e = await res.json(); errMsg = e.message || e.error || errMsg; } catch { /* ignore */ }
      onError?.(errMsg);
      return { text: '' };
    }

    // SSE streaming via fetch + ReadableStream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Drain any remaining complete lines before exiting
          for (const line of buffer.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6).trim();
            if (data === '') continue;
            try {
              const event = JSON.parse(data);
              if (event.type === 'text_delta') {
                fullText += event.delta;
                onDelta?.(event.delta);
              } else if (event.type === 'session_done') {
                onEnd?.(fullText);
              } else if (event.type === 'error') {
                onError?.(event.message);
              }
            } catch { /* skip malformed */ }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6).trim();
          if (data === '') continue;

          try {
            const event = JSON.parse(data);
            if (event.type === 'text_delta') {
              fullText += event.delta;
              onDelta?.(event.delta);
            } else if (event.type === 'session_done') {
              onEnd?.(fullText);
            } else if (event.type === 'error') {
              onError?.(event.message);
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (e) {
      onError?.(e.message);
    }

    return { text: fullText };
  },

  /**
   * Non-streaming chat (single shot, returns once complete).
   */
  async chatSync(message, { sessionId = null } = {}) {
    const res = await fetch('/api/bot-chat/chat', {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({ message, sessionId, stream: false }),
    });
    if (!res.ok) {
      let errMsg = res.statusText;
      try { const e = await res.json(); errMsg = e.message || e.error || errMsg; } catch { /* ignore */ }
      throw new Error(errMsg);
    }
    return res.json();
  },
};

window.agent = agent;