// window.auth — injected by Node HTTP Server
const auth = {
  _token: null,

  async login(username, password) {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error('Login failed');
    const data = await res.json();
    this._token = data.token;
    localStorage.setItem('dw_token', data.token);
    localStorage.setItem('dw_user', JSON.stringify(data.user));
    return data;
  },

  logout() {
    this._token = null;
    localStorage.removeItem('dw_token');
    localStorage.removeItem('dw_user');
  },

  getUser() {
    const raw = localStorage.getItem('dw_user');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },

  getToken() {
    return this._token || localStorage.getItem('dw_token');
  },

  requireAuth() {
    if (!this.getToken()) {
      window.location.href = '/auth/login.html';
    }
  },
};

// Auto-restore token from localStorage
const savedToken = localStorage.getItem('dw_token');
if (savedToken) auth._token = savedToken;

window.auth = auth;