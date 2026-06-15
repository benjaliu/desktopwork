// window.config — injected by Node HTTP Server
const config = {
  _getHeaders() {
    const token = window.auth?.getToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { 'x-desktop-work-token': token } : {}),
    };
  },

  async get() {
    const res = await fetch('/api/platform/config', { headers: this._getHeaders() });
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    return res.json();
  },

  async patch(body) {
    const res = await fetch('/api/platform/config', {
      method: 'PUT',
      headers: this._getHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Config patch failed: ${res.status}`);
    return res.json();
  },

  async getAgent() {
    const cfg = await this.get();
    return cfg.agent ?? {};
  },

  async patchAgent(patch) {
    const current = await this.get();
    return this.patch({ ...current, agent: { ...(current.agent ?? {}), ...patch } });
  },
};

window.config = config;