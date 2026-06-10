# DesktopWork详细设计文档

> 版本：v1.0 draft
> 日期：2026-06-10  
> 状态：待评审

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Shell │
│              (窗口管理 + 菜单 + 登录页)                  │
│                     WebView                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │            Node.js HTTP Server │  │
│  │   localhost:PORT (PORT 默认 3737，自动检测占用)   │  │
│  │                                                  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐       │  │
│  │   │  HTML A  │  │  HTML B  │  │  HTML C  │       │  │
│  │ │ (本模块) │  │(外部引入) │  │(外部引入) │       │  │
│  │  └──────────┘  └──────────┘ └──────────┘       │  │
│  │                                                  │  │
│  │   Auth / Config / Skills / Memory / LLM — 统一 │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 核心设计原则

1. **Node 层是核心** — 所有业务逻辑、Auth、Config、Agent 能力都在 Node 层
2. **Tauri 只是包装** — 创建窗口、起 Node 进程、加载 WebView
3. **HTML App 通过 window.* 拿能力** — Auth Token、Config、Agent Chat API
4. **一套代码，两种部署** — 本地桌面（Tauri 包装）或 服务端（纯 Node）

### 部署形态

| 场景 | 怎么跑 |
|------|--------|
| **本地桌面** | Tauri 启动时先起 Node HTTP server，WebView 加载 localhost:PORT |
| **服务端** | 直接部署 Node 服务，用浏览器访问 |

---

## 2. 目录结构

```
desktopwork/
├── SPECS/
│   └── desktopwork-design.md       ← 本文档
├── server/ ← Node HTTP Server（核心）
│   ├── src/
│   │   ├── index.ts               ← 入口，起 HTTP server
│   │   ├── auth.ts ← 鉴权：login / logout / me
│   │   ├── config.ts ← 配置管理
│   │   ├── agent.ts               ← Agent Chat（流式 LLM）
│   │   ├── skills.ts              ← Skills加载与管理
│   │   ├── memory.ts              ← Memory 读写
│   │   └── router.ts              ← HTTP 路由聚合
│   ├── apps/                      ← HTML App 集合
│   │   ├── _shared/               ← 共享资源（auth, config, styles）
│   │   │   ├── auth.js ← window.getAuthToken() 等
│   │   │   ├── config.js          ← window.appConfig 等
│   │   │   └── styles.css
│   │   ├── dashboard/             ← 主面板 App
│   │   │   └── index.html
│   │   ├── chat/                  ← 对话 App
│   │   │   └── index.html
│   │   └── settings/              ← 设置 App
│   │       └── index.html
│   ├── vendor/                    ← OpenClaw Bundles
│   │   └── bundles/
│   │       ├── llm-core.esm.js
│   │       ├── agent-core.esm.js
│   │       └── memory-host-sdk.esm.js
│   └── package.json
├── shell/                         ← Tauri Shell（外壳）
│   ├── src-tauri/ ← Rust 代码
│   │   └── src/
│   │       ├── main.rs            ← 入口：起 Node 进程 +窗口
│   │       ├── menu.rs            ← 菜单管理
│   │       └── ipc.rs ← Tauri IPC（窗口控制）
│   ├── tauri.conf.json
│   └── Cargo.toml
└── scripts/
    └── extract-openclaw.mjs       ← 提取 OpenClaw bundles
```

---

## 3. API Surface（Node 层对外接口）

### 3.1 鉴权 Auth

```
POST   /auth/login
  Body:    { username: string, password: string }
  Returns: { token: string, user: { userId, name, avatar? } }

POST   /auth/logout
  Headers: Authorization: Bearer <token>
  Returns: { ok: true }

GET /auth/me
  Headers: Authorization: Bearer <token>
  Returns: { userId, name, role, createdAt }
```

**用户数据存储：**
- 使用 `better-sqlite3` 存用户表（username, passwordHash, name, avatar, createdAt）
- Token 用 JWT（HMAC-SHA256，24h 过期）
-密码 bcrypt 哈希

### 3.2 配置 Config

```
GET    /config
  Headers: Authorization: Bearer <token>
  Returns: {
    menu: [{ id, label, icon, appId }], // 菜单结构
    defaultApp: string,                    // 默认加载的 appId
    theme: 'light' | 'dark' | 'system',
    language: string
  }

GET    /config/apps/:appId
  Headers: Authorization: Bearer <token>
  Returns: {
    appId: string,
    name: string,
    config: { ... } // App 私有配置
  }

PATCH  /config/apps/:appId
  Headers: Authorization: Bearer <token>
  Body:   { ...partial config... }
  Returns: { ok: true }

GET    /config/agent
  Headers: Authorization: Bearer <token>
  Returns: {
    model: string,
    provider: string,
    apiKey: string (加密存储),
    skills: [{ id, name, enabled }]
  }

PATCH  /config/agent
  Headers: Authorization: Bearer <token>
  Body:   { ...partial agent config... }
  Returns: { ok: true }
```

**配置存储：**
- 全局配置：JSON 文件（`~/.config/desktopwork/config.json`）
- App 私有配置：JSON 文件（`~/.config/desktopwork/apps/:appId.json`）
- API Key 加密：AES-256-GCM，密钥存在 Tauri Rust 端（OS Keychain）

### 3.3 Agent Chat

```
POST   /agent/chat
  Headers: Authorization: Bearer <token>
  Body: {
    appId: string, // 从哪个 App 发起的
    message: string | AgentMessage[],
    stream: true                          // 默认 true
  }
  Response (stream): text/event-stream
  → event: text_delta { delta: string, contentIndex: 0 }
  → event: done { message: AgentMessage }
  或
  Response (非流式): { message: AgentMessage }
```

### 3.4 Skills

```
GET    /skills
  Headers: Authorization: Bearer <token>
  Returns: [{ id, name, description, version, author }]

GET    /skills/:id
  Headers: Authorization: Bearer <token>
  Returns: { id, name, description, manifest: SkillManifest }

POST   /skills/:id/enable
  Headers: Authorization: Bearer <token>
  Body:   { appId?: string }             // 可选：只为特定 App 启用
  Returns: { ok: true }

POST   /skills/:id/disable
  Headers: Authorization: Bearer <token>
  Returns: { ok: true }
```

### 3.5 Memory

```
GET    /memory?query=...&limit=5
  Headers: Authorization: Bearer <token>
  Returns: [{ id, content, timestamp, score }]

POST /memory
  Headers: Authorization: Bearer <token>
  Body:   { query: string, content: string }
  Returns: { id: string }

DELETE /memory/:id
  Headers: Authorization: Bearer <token>
  Returns: { ok: true }
```

---

## 4. HTML App 集成规范

### 4.1 window.* 全局 API（Node 层注入）

每个 HTML App 初始化时，Node 层自动注入以下全局对象：

```javascript
window.auth = {
  token: string,                          // 当前 JWT token
  user: { userId, name, role },           // 当前用户信息
  getToken: () => string,                 // 获取 token
  getUser: () => object,                  // 获取用户信息
  onChange: (cb: (user) => void) => void  // 监听登录状态变化
};

window.config = {
  get: (appId?) => object,                // 获取配置
  set: (appId, patch) => Promise<void>,   // 更新配置
  getAgent: () => object,                 // 获取 Agent 配置
  onChange: (cb: (config) => void) => void
};

window.agent = {
  chat: (message, appId, onDelta) => Promise<AgentMessage>,
  // onDelta: (delta: string) => void
  abort: () => void                      // 中止当前请求
};
```

### 4.2 App 初始化协议

HTML App 必须遵守以下初始化协议：

```javascript
// 1. 检查 auth
if (!window.auth?.token) {
  // 重定向到登录
  window.location.href = '/auth/login';
}

// 2. 等待初始化完成
window.appReady = new Promise((resolve) => {
  if (window.auth && window.config) resolve();
  else window.addEventListener('app-ready', () => resolve(), { once: true });
});

// 3. App 入口
async function main() {
  await window.appReady;
  const user = window.auth.getUser();
  const cfg = window.config.get('chat');
  // ...
}
```

### 4.3 路由规则

Node 层根据 URL 前缀路由到不同 HTML App：

| URL 前缀 | 映射到 |
|----------|--------|
| `/` 或 `/dashboard` | `server/apps/dashboard/index.html` |
| `/chat` | `server/apps/chat/index.html` |
| `/settings` | `server/apps/settings/index.html` |
| `/auth/login` | `server/apps/auth/login.html` |
| `/auth/logout` | `server/apps/auth/logout.html` |

**Tauri Shell 加载策略：**
- 主窗口加载 `/`（dashboard）
- 菜单项点击 → WebView 导航到对应 URL
- 不需要多 webview，同一 WebView 内 navigation

---

## 5. Tauri Shell 设计

### 5.1 职责（极简）

```
Shell 职责：
1. 起 Node 子进程（localhost:PORT）
2. 验证 Node 服务健康（/auth/me 端点）
3. 创建主窗口，加载 http://localhost:PORT
4. 管理窗口菜单（从 Node /config 拿菜单结构）
5. 窗口控制：最小化/最大化/关闭
6. 打包（.exe / .dmg / .AppImage）
```

### 5.2 不做

- **不写业务逻辑** — Auth、Config、Agent全部在 Node 层
- **不处理 IPC** — 不需要 Rust ↔ Node 通信
- **不编译 Rust业务代码** — Rust 只做窗口管理和进程启动

### 5.3 Node 进程管理

```rust
// main.rs
fn main() {
    let port = find_available_port(3737);
    let node_child = Command::new("node")
        .args(["server/src/index.ts", "--port", &port.to_string()])
        .spawn()
        .expect("Failed to start node server");

    // 等待 Node 服务 ready
    wait_for_url(&format!("http://localhost:{port}/auth/me"));

    // 创建窗口
    let window = tauri::Builder::default()
        .create_window(
            &format!("http://localhost:{port}"),
            "DesktopWork",
            tauri::Size::Physical(1200, 800)
        )
        .run();

    // 清理
    node_child.kill().ok();
}
```

### 5.4 菜单配置

菜单结构从 Node `/config` 获取，由 Node 层管理：

```
菜单数据结构：
{
  menu: [
    { id: "dashboard", label: "主面板", icon: "home", appId: "dashboard" },
    { id: "chat",      label: "对话",   icon: "chat", appId: "chat" },
    { id: "skills",    label: "技能",   icon: "skill", appId: "skills" },
    { id: "settings",  label: "设置",   icon: "gear", appId: "settings" }
  ]
}
```

Shell 通过 HTTP 请求获取菜单，渲染为原生菜单或 HTML 侧边栏。

---

## 6. Auth流程

### 6.1 首次启动

```
1. Shell 启动 Node
2. Node 检测无用户 → 自动创建 admin 用户（默认密码 admin123）
3. Node启动 HTTP 服务
4. Shell WebView 加载 /auth/login
5. 用户看到登录页，输入 admin / admin123
6. 登录成功，Token 存入 Shell 内存（Rust 端安全存储）
7. WebView 导航到 /
```

### 6.2 Token 传递

```
登录后：
1. Node 返回 { token: JWT, user: {...} }
2. Shell 拦截 HTTP响应，提取 token 存 Rust 内存
3. 后续所有请求，Shell 自动注入 Header：
   Authorization: Bearer <token>
4. HTML App 通过 window.auth 拿到用户信息
```

### 6.3 密码修改

```
用户修改密码：
POST /auth/change-password
  Body: { oldPassword, newPassword }
  Headers: Authorization: Bearer <token>
  Returns: { ok: true }
```

---

## 7. Skills 管理

### 7.1 Skills 加载

- Skills 定义文件在 `server/vendor/skills/` 目录
- 每个 Skill 一个子目录，含 `SKILL.md` +资源
- Node 启动时扫描所有 Skills，构建索引

### 7.2 Skill 启用

- 用户在 Settings App 里启用/禁用 Skills
- 启用的 Skill IDs 写入 `~/.config/desktopwork/enabled-skills.json`
- Agent Chat 时传入已启用 Skills 列表

### 7.3 Skill 执行

HTML App 通过 `window.agent.chat()` 发起对话时，Skill 执行在 Node 层完成：

```
HTML App                          Node Layer
   │                                   │
   │  window.agent.chat(msg)            │
   │ ─────────────────────────────────►│
   │                                   │  加载已启用 Skills
   │                                   │  执行 Skill Chain
   │                                   │  调用 LLM
   │◄─────────────────────────────────│
   │ stream: text_delta               │
   │   stream: done │
```

---

## 8. 数据流

### 8.1 配置数据流

```
写入配置：
HTML App → PATCH /config/apps/:appId → Node →写入 ~/.config/desktopwork/apps/:appId.json

读取配置：
HTML App → GET /config/apps/:appId → Node → 读取 ~/.config/desktopwork/apps/:appId.json

广播变更：
配置变更后 → Node 通过 Server-Sent Events 广播给所有连接的 HTML App
```

### 8.2 Agent Chat 数据流

```
HTML App                              Node Layer
   │                                       │
   │  window.agent.chat(msg)               │
   │ ──────────────────────────────────────►│
   │                                       │  convertToLlm(messages)
   │                                       │  loadSkills()
   │                                       │  agentLoop(messages, skills, streamFn)
   │                                       │    │  streamAssistantResponse(...)
   │                                       │    │    │  fetch LLM API
   │                                       │    │    │  ← SSE stream
   │                                       │    │  agentLoop yields events
   │◄──────────────────────────────────────│
   │   SSE: text_delta { delta } │
   │   SSE: text_delta { delta }           │
   │   SSE: done { message } │
```

---

## 9. 开发工作流

### 9.1 本地开发

**Node 服务（开发模式）：**
```bash
cd server && npx tsx watch src/index.ts
# 自动重新加载，端口 3737
```

**Tauri Shell（开发模式）：**
```bash
cd shell/src-tauri && cargo run
# 自动起 Node + 打开窗口
```

**单独测试 HTML App：**
```bash
# 起 Node 服务后，直接浏览器访问
open http://localhost:3737/chat
```

### 9.2 打包

```bash
# 构建 Node 服务
cd server && npm run build  # → dist/

# 构建 Tauri
cd shell/src-tauri && cargo build --release

# 或一条命令
pnpm build  # → 调用 server build + shell build
```

---

## 10.里程碑

### M1：Node HTTP 服务可独立运行
- [x] Auth（login/logout/me）
- [x] Config（读/写）
- [ ] Agent Chat（流式对话）
- [ ] Skills 加载
- [ ] Memory 读写
-验证：curl 测试所有 API +浏览器访问 HTML App

### M2：HTML App 集成
- [ ] dashboard App
- [ ] chat App（调用 /agent/chat）
- [ ] settings App（修改配置、启停 Skills）
- 验证：浏览器访问各 App，window.* API 正常工作

### M3：Tauri Shell
- [ ] 起 Node 子进程
- [ ] 创建窗口加载 WebView
- [ ] 菜单管理
- 验证：`cargo run` 启动完整 App

### M4：打包发布
- [ ] Windows .exe 打包
- [ ] macOS .dmg 打包（可选）
- 验证：双击运行，无需命令行

---

## 11. 技术选型

| 模块 | 技术 | 说明 |
|------|------|------|
| HTTP Server | Express + TypeScript | 成熟稳定，简单够用 |
| Auth | JWT (jsonwebtoken) + bcrypt | 标准方案 |
| 数据库 | better-sqlite3 | 单文件，轻量，满足需求 |
| LLM | OpenAI Protocol + fetch | 复用现有 llm-core bundle |
| Skills | 复用 agent-core bundle | 复用现有实现 |
| Memory | 复用 memory-host-sdk | 复用现有实现 |
| HTML App | 原生 HTML + CSS + Vanilla JS | 无框架依赖，简单直接 |
| Tauri | tauri v2 + Rust | 窗口管理，不写业务逻辑 |
| 打包 | tauri build | 一键打包 |

---

## 12. 已知约束

1. **API Key 安全**：LLM API Key 存在文件里会被加密，但 Git 内不能有明文 key
2. **Skills 复用**：现有 OpenClaw bundles 继续用，不重写 Skills逻辑
3. **多语言**：第一批只有中文界面，暂不考虑 i18n
4. **用户系统**：第一批只有单用户（admin），不考虑多用户团队场景