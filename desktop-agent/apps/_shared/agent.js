// window.agent — injected by Node HTTP Server
const agent = {
  _token: null,

  _getHeaders() {
    const token = window.auth?.getToken();
    return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  },

  /**
   * Send a message and get a streaming response via SSE.
   * @param {string} message
   * @param {{ sessionKey?: string, onDelta?: (delta: string) => void, onEnd?: (content: string) => void, onError?: (err: string) => void }} opts
   * @returns {Promise<{ text: string }>}
   */
  async chat(message, { sessionKey = 'default', onDelta, onEnd, onError } = {}) {
    const res = await fetch('/agent/chat', {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({ message, sessionKey, stream: true }),
    });

    if (!res.ok) {
      const err = await res.json();
      onError?.(err.error || res.statusText);
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
        if (done) break;

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
            } else if (event.type === 'message_end') {
              onEnd?.(fullText);
            } else if (event.type === 'error') {
              onError?.(event.error);
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
  async chatSync(message, { sessionKey = 'default' } = {}) {
    const res = await fetch('/agent/chat', {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({ message, sessionKey, stream: false }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },
};

window.agent = agent;