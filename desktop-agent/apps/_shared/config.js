// window.config — injected by Node HTTP Server
const config = {
  _token: null,

  _getHeaders() {
    const token = window.auth?.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  async get(path) {
    const url = path ? `/config${path}` : '/config';
    const res = await fetch(url, { headers: this._getHeaders() });
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    return res.json();
  },

  async patch(path, body) {
    const url = path ? `/config${path}` : '/config';
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...this._getHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Config patch failed: ${res.status}`);
    return res.json();
  },

  async getAgent() {
    return this.get('/agent');
  },

  async patchAgent(patch) {
    return this.patch('/agent', patch);
  },
};

window.config = config;