# DesktopWork详细设计文档

> 版本：v1.1 draft
> 日期：2026-06-10
> 状态：待评审

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Shell                          │
│              (窗口管理 + 菜单 + 登录页)                 │
│                     WebView                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │            Node.js HTTP Server │  │
│  │   localhost:PORT (PORT 默认 3737，自动检测占用)   │  │
│  │                                                  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐       │  │
│  │   │ HTML A  │  │  HTML B  │  │  HTML C  │       │  │
│  │   │ (本模块) │  │(外部引入) │  │(外部引入) │       │  │
│  │ └──────────┘  └──────────┘ └──────────┘       │  │
│  │                                                  │  │
│  │   Auth / Config / Skills / Memory / LLM — 统一   │  │
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
├── desktop-agent/                      ← Node HTTP Server（核心）
│   ├── src/
│   │   ├── index.ts               ← 入口，起 HTTP server
│   │   ├── auth.ts                ← 鉴权（stub，OIDC 后续接入）
│   │   ├── config.ts              ← 配置管理
│   │   ├── agent.ts               ← Agent Chat（流式 LLM）
│   │   ├── skills.ts              ← Skills 管理（复用 agent-core）
│   │   ├── memory.ts              ← Memory读写（复用 memory-host-sdk）
│   │   └── router.ts              ← HTTP 路由聚合
│   ├── apps/                      ← HTML App 集合
│   │   ├── _shared/              ← 共享资源（auth, config, styles）
│   │   │   ├── auth.js           ← window.getAuthToken() 等
│   │   │   ├── config.js         ← window.appConfig 等
│   │   │   └── styles.css
│   │   ├── dashboard/             ← 主面板 App
│   │   │   └── index.html
│   │   ├── chat/                  ← 对话 App
│   │   │   └── index.html
│   │   └── settings/              ← 设置 App
│   │       └── index.html
│   ├── vendor/                    ← OpenClaw Bundles（提取自 submodule）
│   │   └── bundles/
│   │       ├── llm-core.esm.js    ← 提取自 packages/llm-core
│   │       ├── agent-core.esm.js  ← 提取自 packages/agent-core
│   │       ├── memory-host-sdk.esm.js ← 提取自 packages/memory-host-sdk
│   │       └── OPENCLAW_VERSIONS.json
│   └── package.json
├── shell/                         ← Tauri Shell（外壳）
│   ├── src-tauri/                 ← Rust 代码
│   │   └── src/
│   │       ├── main.rs            ← 入口：起 Node 进程 + 窗口
│   │       ├── menu.rs            ← 菜单管理
│   │       └── ipc.rs ← Tauri IPC（窗口控制）
│   ├── tauri.conf.json
│   └── Cargo.toml
└── scripts/
    └── extract-openclaw.mjs       ← 提取 OpenClaw bundles脚本
```

---

## 3. OpenClaw 模块提取机制

### 3.1 背景

OpenClaw 是一个独立的 Git仓库（`vendor/openclaw`），包含多个 npm package。本项目不直接依赖 OpenClaw 的源码，而是通过 `extract-openclaw.mjs` 脚本将需要的模块提取为独立的 ESM bundle 文件，绑定到本项目。

**优点：**
- Bundle 文件独立，不依赖 submodule 的完整性
- 可以在 submodule 下载完成之前就开始开发
- Bundle 内容是确定版本的快照

**版本锁定：**
- `OPENCLAW_VERSION` 文件记录当前使用的版本号
- `OPENCLAW_COMMIT` 文件记录 git commit hash
- `vendor/bundles/OPENCLAW_VERSIONS.json` 记录每次提取的元信息

### 3.2 提取脚本逻辑

`scripts/extract-openclaw.mjs` — 核心流程：

```
输入：vendor/openclaw/（OpenClaw Git submodule）
      ├── packages/
      │   ├── llm-core/           src/index.ts
      │   ├── agent-core/        src/index.ts
      │   └── memory-host-sdk/    src/runtime.ts
      └── node_modules/.bin/esbuild

输出：server/vendor/bundles/
      ├── llm-core.esm.js
      ├── agent-core.esm.js
      ├── memory-host-sdk.esm.js
      └── OPENCLAW_VERSIONS.json
```

**关键处理：**

1. **memory-host-sdk 的 ESM 兼容问题**
   - `memory-host-sdk` 内部使用 `dotenv`（CJS 模块），dotenv 在 eval 时动态调用 `require('fs')`
   - esbuild 将其转换为 `__require` shim，在 ESM 环境下 `global.require` 是 undefined
   - **解决方案**：注入 `require-shim.mjs`，提供 `createRequire` polyfill

2. **External 处理**
   - `llm-core` external: `['typebox']`
   - `agent-core` external: `['ignore', 'yaml']`
   - `memory-host-sdk` 无 external（全部 bundle 内联）

### 3.3 当前提取的模块

| Bundle | 源码位置 | 导出内容 | 用途 |
|--------|----------|----------|------|
| **llm-core.esm.js** | `packages/llm-core/src/index.ts` | `EventStream` 类, `createAssistantMessageEventStream()`, `validateToolArguments()`, `validateToolCall()` | SSE 流处理，工具参数校验 |
| **agent-core.esm.js** | `packages/agent-core/src/index.ts` | `agentLoop()`, `loadSkills()`, `JsonlSessionStorage`, `convertToLlm()`, `asAgentMessage()`, `uuidv7()` | Agent 主循环，Skills 加载，会话存储 |
| **memory-host-sdk.esm.js** | `packages/memory-host-sdk/src/runtime.ts` | Memory 读写接口 | 长期记忆存储 |

### 3.4 agentLoop 的流式机制

`agent-core.esm.js` 的 `agentLoop` 是核心。它接收：

```
agentLoop(prompts, context, config, signal, streamFn, runtime)
  └── streamFn: 自定义的流构建函数（本项目用 buildStreamFn）
       └── buildStreamFn: 调用 LLM API，将 SSE 事件转为 EventStream
```

**本项目的 buildStreamFn（`desktop-agent/src/agent.ts` 内）职责：**
1. 用 `fetch` 调用 LLM API（OpenAI Protocol，`https://aegis-higress-gateway.baozun.com/v1/chat/completions`）
2. 将 SSE 格式的响应解析为 `content_block_delta` →发出 `text_delta` 事件
3. 将 `finish_reason` 解析为 `done` 事件
4. 返回 `EventStream`（实现 `Symbol.asyncIterator`）

**注意：** OpenClaw 原生的 `agentLoop` 期望的是 Anthropic SSE 格式。本项目对接的是 OpenAI 兼容 API，所以 `buildStreamFn` 是适配层。

### 3.5 Skills 加载机制

`agent-core.esm.js` 的 `loadSkills(nodeFs, dirs)`：
- `nodeFs`：Node.js fs 操作抽象（readTextFile, readDir, fileInfo, joinPath, absolutePath）
- `dirs`：Skills 目录数组
- 返回：`{ skills: Skill[], diagnostics: Diagnostic[] }`

**Skills 目录结构：**
```
skills/
└── <skill-name>/
    └── SKILL.md        ← Skill 定义文件
```

**本项目使用方式（`desktop-agent/src/skills.ts`）：**
```typescript
import { loadSkills } from '../vendor/bundles/agent-core.esm.js';

const nodeFs = {
  async readTextFile(path) { ... },
  async readDir(path) { ... },
  async fileInfo(path) { ... },
  async joinPath(parts) { ... },
  async absolutePath(p) { ... }
};

export async function loadUserSkills(skillsDirs: string[]) {
  const result = await loadSkills(nodeFs, skillsDirs);
  return {
    skills: result.skills.map(s => ({ name: s.name, description: s.description })),
    diagnostics: result.diagnostics
  };
}
```

### 3.6 Memory 机制

`memory-host-sdk.esm.js` 提供 Memory 读写接口，与 OpenClaw 的 Mem0 向量存储配合工作。

---

## 4. API Surface（Node 层对外接口）

### 4.1 鉴权 Auth — Stub（OIDC 后续接入）

**当前实现：Stub（假鉴权）**
- 任意用户名 + 任意密码 → 都能登录成功
- 返回固定格式的用户信息和 JWT token
- 用于开发阶段，后续替换为真实 OIDC

**计划：OIDC 接入（后续）**
- 集成目标：飞书、企业微信、Google Workspace 等
- 届时替换 `desktop-agent/src/auth.ts` 实现，API 接口不变

```
POST   /auth/login
  Body:    { username: string, password: string }
  Returns: { token: string, user: { userId, name, avatar? } }
           或 { error: string }

POST   /auth/logout
  Headers: Authorization: Bearer <token>
  Returns: { ok: true }

GET /auth/me
  Headers: Authorization: Bearer <token>
  Returns: { userId, name, role, createdAt }
```

**JWT Token：**
- 生成算法：HMAC-SHA256（临时固定密钥，后续存在 Tauri Rust 端）
- 过期时间：24h
- payload：`{ userId, name, role, iat, exp }`

---

## 5. HTML App 集成规范

### 5.1 window.* 全局 API（Node 层注入）

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

### 5.2 App 初始化协议

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

### 5.3 路由规则

Node 层根据 URL 前缀路由到不同 HTML App：

| URL 前缀 | 映射到 |
|----------|--------|
| `/` 或 `/dashboard` | `desktop-agent/apps/dashboard/index.html` |
| `/chat` | `desktop-agent/apps/chat/index.html` |
| `/settings` | `desktop-agent/apps/settings/index.html` |
| `/auth/login` | `desktop-agent/apps/auth/login.html` |
| `/auth/logout` | `desktop-agent/apps/auth/logout.html` |

**Tauri Shell 加载策略：**
- 主窗口加载 `/`（dashboard）
- 菜单项点击 → WebView 导航到对应 URL
- 不需要多 webview，同一 WebView 内 navigation

---

## 6. Tauri Shell 设计

### 6.1 职责（极简）

```
Shell 职责：
1. 起 Node 子进程（localhost:PORT）
2. 验证 Node 服务健康（/auth/me 端点）
3. 创建主窗口，加载 http://localhost:PORT
4. 管理窗口菜单（从 Node /config 拿菜单结构）
5. 窗口控制：最小化/最大化/关闭
6. 打包（.exe / .dmg / .AppImage）
```

### 6.2 不做

- **不写业务逻辑** — Auth、Config、Agent 全部在 Node 层
- **不处理 IPC** — 不需要 Rust ↔ Node 通信
- **不编译 Rust 业务代码** — Rust 只做窗口管理和进程启动

### 6.3 Node 进程管理

```rust
// main.rs
fn main() {
    let port = find_available_port(3737);
    let node_child = Command::new("node")
        .args(["desktop-agent/src/index.ts", "--port", &port.to_string()])
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

### 6.4 菜单配置

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

## 7. Auth 流程

### 7.1 首次启动

```
1. Shell 启动 Node
2. Node 检测无用户 → 自动创建 admin 用户（默认密码 admin123）
3. Node 启动 HTTP 服务
4. Shell WebView 加载 /auth/login
5. 用户看到登录页，输入 admin / admin123
6. 登录成功，Token 存入 Shell 内存（Rust 端可安全存储）
7. WebView 导航到 /
```

### 7.2 Token 传递

```
登录后：
1. Node 返回 { token: JWT, user: {...} }
2. Shell 拦截 HTTP 响应，提取 token 存 Rust 内存
3. 后续所有请求，Shell 自动注入 Header：
   Authorization: Bearer <token>
4. HTML App 通过 window.auth 拿到用户信息
```

---

## 8. 数据流

### 8.1 Agent Chat 数据流

```
HTML App                              Node Layer
   │                                       │
   │  window.agent.chat(msg) │
   │ ──────────────────────────────────────►│
   │                                       │  convertToLlm(messages)
   │                                       │  loadSkills()  ← agent-core.loadSkills
   │                                       │  agentLoop(messages, skills, streamFn)
   │                                       │    │  buildStreamFn() ← 自定义适配层
   │                                       │    │ │  fetch LLM API
   │                                       │    │    │  ← SSE stream
   │                                       │    │    │  emit text_delta 事件
   │                                       │    │  agentLoop yields events
   │◄──────────────────────────────────────│
   │   SSE: text_delta { delta }            │
   │   SSE: text_delta { delta }            │
   │   SSE: done { message }                │
```

**buildStreamFn 的职责（本项目适配层）：**
- 调用 OpenAI Protocol LLM API（`https://aegis-higress-gateway.baozun.com/v1/chat/completions`）
- 解析 SSE 格式的 `content_block_delta` 事件 →发出 `text_delta` 事件
- 解析 SSE 格式的 `finish_reason` 事件 → 发出 `done` 事件
- 返回 `EventStream` 实例供 `agentLoop` 消费

### 8.2 配置数据流

```
写入配置：
HTML App → PATCH /config/apps/:appId → Node → 写入 ~/.config/desktopwork/apps/:appId.json

读取配置：
HTML App → GET /config/apps/:appId → Node → 读取 ~/.config/desktopwork/apps/:appId.json

广播变更：
配置变更后 → Node 通过 Server-Sent Events 广播给所有连接的 HTML App
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

## 10. 里程碑（执行对照表）

### M1：Node HTTP 服务可独立运行
- [ ] M1.1 目录结构（desktop-agent/ + package.json）
- [ ] M1.2 Auth Stub（任意密码登录）
- [ ] M1.3 Config（读/写 JSON 配置）
- [ ] M1.4 Agent Chat（buildStreamFn + agent-loop）
- [ ] M1.5 Skills 薄包装（复用 agent-core.loadSkills）
- [ ] M1.6 验证标准（curl + 浏览器）

### M2：HTML App 集成
- [ ] M2.1 共享资源（window.auth / window.config / styles）
- [ ] M2.2 dashboard App
- [ ] M2.3 chat App（流式对话）
- [ ] M2.4 settings App（配置 + Skills）
- [ ] M2.5 验证标准

### M3：Tauri Shell
- [ ] M3.1 Node 进程管理（Rust）
- [ ] M3.2 菜单管理
- [ ] M3.3 窗口控制
- [ ] M3.4 验证标准

### M4：打包发布
- [ ] Windows .exe 打包
- [ ] macOS .dmg 打包（可选）
- [ ] 端到端验证


## 11. 技术选型

| 模块 | 技术 | 说明 |
|------|------|------|
| HTTP Server | Express + TypeScript | 成熟稳定，简单够用 |
| Auth | JWT (jsonwebtoken) | Stub：固定密钥；OIDC：后续接入 |
| 数据库 | better-sqlite3 | 单文件，轻量，满足需求 |
| LLM | OpenAI Protocol + fetch | 复用现有 llm-core bundle |
| Skills | 复用 agent-core bundle | 复用现有 agent-core.loadSkills |
| Memory | 复用 memory-host-sdk | 复用现有 memory-host-sdk |
| HTML App | 原生 HTML + CSS + Vanilla JS | 无框架依赖，简单直接 |
| Tauri | tauri v2 + Rust | 窗口管理，不写业务逻辑 |
| 打包 | tauri build | 一键打包 |

---

## 12. 已知约束

1. **API Key 安全**：LLM API Key 存在文件里会被加密，但 Git 内不能有明文 key
2. **Skills 复用**：现有 OpenClaw bundles 继续用，不重写 Skills 逻辑
3. **多语言**：第一批只有中文界面，暂不考虑 i18n
4. **用户系统**：第一批只有单用户（admin），不考虑多用户团队场景
5. **OpenClaw Submodule**：当前正在下载中，Bundles 可独立使用不依赖 submodule