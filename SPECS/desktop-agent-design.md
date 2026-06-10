# Desktop Agent 设计文档

> **目标**：设计一个拥有完整 Agent 能力（对话、记忆、技能）的桌面 DesktopWork 工具，Agent 能力抽取自 OpenClaw。

---

## 1. 项目概述

### 1.1 目标

DesktopWork 是一个桌面客户端应用，用户安装后配置好 LLM 即可开始聊天，同时具备记忆和技能扩展能力。

**核心能力**：
- **对话**：与 LLM 实时对话，支持流式输出
- **记忆**：跨会话记住对话上下文，支持语义检索
- **技能**：加载和管理 Skills，扩展 Agent 能力边界

### 1.2 技术选型

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | **Tauri v2** | 轻量、跨平台、安全 |
| 前端 | **React 19 + TypeScript** | 成熟生态 |
| Agent 核心 | **OpenClaw Bundle** | agent-core ESM bundle |
| 记忆引擎 | **OpenClaw Bundle** | memory-host-sdk ESM bundle |
| LLM 抽象 | **OpenClaw Bundle** | llm-core ESM bundle |
| 技能加载 | **OpenClaw Bundle** | harness/skills |
| 构建工具 | **Vite** | 快速 HMR |
| 包管理 | **pnpm** | Monorepo 友好 |

### 1.3 OpenClaw 依赖管理方案

#### 背景

DesktopWork 是独立项目，不在 OpenClaw pnpm workspace 内。OpenClaw 的 `@openclaw/*` 包未被 npm publish，无法通过 `npm install` 安装。

#### 方案：Submodule + Bundle 提取

```
desktopwork/
├── vendor/                     ← OpenClaw submodule（构建时用，打包时排除）
│   └── openclaw/              ← git submodule，指向 OpenClaw 仓库
│       └── scripts/
│           └── require-shim.mjs  ← ESM require shim（随 submodule 提供）
├── scripts/
│   └── extract-openclaw.mjs    ← 提取工具
└── desktop-agent/
    └── vendor/
        └── bundles/           ← 提取后的 bundle（纳入 git）
            ├── llm-core.esm.js
            ├── agent-core.esm.js
            ├── memory-host-sdk.esm.js
            └── OPENCLAW_VERSIONS.json
```

> 📖 **详细技术决策**（dotenv `require('fs')` 问题、入口点选择、shim 方案）见 [module-extraction-decision.md](./module-extraction-decision.md)。

**工作流**：

```bash
# 首次初始化 submodule
git submodule add https://github.com/benjaliu/openclaw vendor/openclaw

# 更新 OpenClaw 版本
cd vendor/openclaw && git pull origin main
cd ../.. && node scripts/extract-openclaw.mjs \
  --openclaw vendor/openclaw \
  --out desktop-agent/vendor/bundles
# 提交新的 bundle 文件
git add desktop-agent/vendor/bundles
git commit -m "chore: update OpenClaw bundle"
```

**打包时不包含 submodule**：Tauri 的 `bundle.resources` 只包含 `desktop-agent/vendor/bundles/`，不包含 `vendor/openclaw` 目录。

#### 提取工具（extract-openclaw.mjs）

- 基于 esbuild 将 OpenClaw packages 打为单文件 ESM bundle
- 内联所有内部 `@openclaw/*` 依赖
- **memory-host-sdk 使用 `--inject` + require-shim**：解决 dotenv CJS 模块在 ESM bundle 中的 `require('fs')` 动态调用问题（详见 [module-extraction-decision.md](./module-extraction-decision.md) §3）
- **memory-host-sdk 入口点**：`src/runtime.ts`（非 `src/engine.ts`，后者有 dotenv 深层依赖）
- 自动记录 git commit、branch、tag、version 到 `OPENCLAW_VERSIONS.json`
- 当前输出（v2026.6.2）：

| Bundle | 大小 |
|--------|------|
| llm-core.esm.js | ~358KB |
| agent-core.esm.js | ~525KB |
| memory-host-sdk.esm.js | ~7.6MB |


#### 版本记录

`OPENCLAW_VERSIONS.json` 记录每次提取的 OpenClaw 版本信息：

```json
{
  "extractedAt": "2026-06-09T01:36:49.157Z",
  "openclaw": {
    "path": "/home/benjamin/OpenClaw",
    "commit": "b8adc11977ab9dc1eb558dc070bfe63df75911c5",
    "branch": "main",
    "tag": "",
    "version": "2026.6.2"
  },
  "bundles": {
    "llm-core": { "file": "llm-core.esm.js", "status": "ok", "sizeKB": 358 },
    "agent-core": { "file": "agent-core.esm.js", "status": "ok", "sizeKB": 525 },
    "memory-host-sdk": { "file": "memory-host-sdk.esm.js", "status": "ok", "sizeKB": 7618 }
  }
}
```

#### 优势

| 优势 | 说明 |
|------|------|
| 零 npm 依赖 | 不依赖 OpenClaw publish |
| 版本可溯源 | `OPENCLAW_VERSIONS.json` 记录 commit |
| 打包干净 | submodule 不打入最终安装包 |
| 独立开发 | desktop-agent 完整独立，不依赖 OpenClaw 目录结构 |
| 更新流程清晰 | pull → extract → commit |
| 技术决策透明 | 关键问题（如 dotenv ESM 兼容性）见 [module-extraction-decision.md](./module-extraction-decision.md) |

---

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Shell                          │
│              (窗口管理 + 菜单 + 登录页)                 │
│                     WebView                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │            Node.js HTTP Server                    │  │
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

**核心设计原则：**
1. **Node 层是核心** — 所有业务逻辑、Auth、Config、Agent 能力都在 Node 层
2. **Tauri 只是包装** — 创建窗口、起 Node 进程、加载 WebView
3. **HTML App 通过 window.* 拿能力** — Auth Token、Config、Agent Chat API
4. **一套代码，两种部署** — 本地桌面（Tauri 包装）或 服务端（纯 Node）

### 2.2 数据流

```
用户输入消息
    ↓
HTML App (WebView)
    ↓ fetch POST /agent/chat
Node HTTP Server
    │
    ├── loadSkills()          ← agent-core.loadSkills
    ├── agentLoop(messages, streamFn)
    │      │
    │      └── buildStreamFn()  ← 协议适配层（自动检测 OpenAI / Anthropic）
    │               │
    │               └── fetch LLM API → SSE stream
    │
    └── SSE stream ──► HTML App
```

### 2.3 模块职责

| 模块 | 职责 |
|------|------|
| **Tauri Shell** | 起 Node 子进程、创建窗口、加载 WebView、菜单 |
| **Node HTTP Server** | 业务逻辑：Auth、Config、Agent Chat、Skills、Memory |
| **HTML App** | 通过 window.* 使用 Node 层能力（Auth、Config、Agent） |
| **desktop-agent/vendor/bundles/agent-core** | 核心 Agent 循环（agentLoop、loadSkills） |
| **desktop-agent/vendor/bundles/memory-host-sdk** | 记忆存储与检索 |
| **desktop-agent/vendor/bundles/llm-core** | SSE EventStream 流处理 |

---

## 3. HTTP API Surface（Node 层对外接口）

### 3.1 协议概述

Node.js HTTP Server 对外提供 REST API，所有 HTML App 通过 fetch 调用。

**通信模式**：
- HTML App → Node Server：HTTP fetch（JSON body / SSE stream）
- Shell → Node Server：HTTP（鉴权 Token 注入）

**认证**：所有 API 需要 Header `Authorization: Bearer <token>`（Stub 实现为任意密码可登录）

### 3.2 Auth API

```
POST /auth/login
  Body:    { username: string, password: string }
  Returns: { token: string, user: { userId, name, avatar? } }
           或 { error: string }

POST /auth/logout
  Headers: Authorization: Bearer <token>
  Returns: { ok: true }

GET  /auth/me
  Headers: Authorization: Bearer <token>
  Returns: { userId, name, role, createdAt }
```

> **Stub 说明**：当前实现任意用户名+密码都能登录成功。后续替换为 OIDC（飞书/企微/Google Workspace）。

### 3.3 Config API

```
GET  /config
  Headers: Authorization: Bearer <token>
  Returns: {
    menu: [{ id, label, icon, appId }],
    defaultApp: string,
    theme: 'light'|'dark'|'system',
    language: string
  }

GET  /config/apps/:appId
  Headers: Authorization: Bearer <token>
  Returns: { appId, name, config: { ... } }

PATCH  /config/apps/:appId
  Headers: Authorization: Bearer <token>
  Body:   { ...partial config... }
  Returns: { ok: true }

GET  /config/agent
  Headers: Authorization: Bearer <token>
  Returns: { model, provider, apiKey, skills: [...] }

PATCH  /config/agent
  Headers: Authorization: Bearer <token>
  Body:   { ...partial agent config... }
  Returns: { ok: true }
```

### 3.4 Agent Chat API

```
POST /agent/chat
  Headers: Authorization: Bearer <token>
  Body: {
    appId: string,
    message: string | AgentMessage[],
    stream: true           // 默认 true
  }
  Response (stream=true): text/event-stream
  → event: text_delta { delta: string, contentIndex: 0 }
  → event: done { message: AgentMessage }
  或
  Response (stream=false): { message: AgentMessage }
```

### 3.5 Skills API（管理已安装的 Skills）

> 注意：市场浏览（marketplace）功能在后续阶段考虑，当前只有已安装 Skills 的管理。

```
GET  /skills
  Headers: Authorization: Bearer <token>
  Returns: [{ id, name, description, version, author }]

GET  /skills/:id
  Headers: Authorization: Bearer <token>
  Returns: { id, name, description, manifest: SkillManifest }

POST /skills/:id/enable
  Headers: Authorization: Bearer <token>
  Body:   { appId?: string }
  Returns: { ok: true }

POST /skills/:id/disable
  Headers: Authorization: Bearer <token>
  Returns: { ok: true }
```

### 3.6 Memory（非 API）

Memory 是 Node 层内部能力，不对外暴露 API。

- Session 持久化：session.ts（JSONL 文件）
- Memory 检索：agent.ts 内部调用 memory-host-sdk
- HTML App 无需感知 Memory 存在

### 3.7 错误码约定

| HTTP Status | 含义 |
|-------------|------|
| 400 | Bad Request（参数格式错误） |
| 401 | Unauthorized（未登录或 Token 无效） |
| 403 | Forbidden（权限不足） |
| 404 | Not Found（资源不存在） |
| 500 | Internal Server Error（Agent/LLM 失败） |

---

## 4. desktop-agent 模块设计

### 4.1 目录结构

```
desktopwork/
├── desktop-agent/              <- Node HTTP Server (core)
│   ├── src/
│   │   ├── index.ts            # entry: start HTTP server
│   │   ├── auth.ts             # auth (stub, OIDC later)
│   │   ├── config.ts           # config management
│   │   ├── agent.ts            # Agent Chat (streaming LLM)
│   │   ├── skills.ts           # Skills (复用 agent-core)
│   │   ├── memory.ts           # Memory (复用 memory-host-sdk)
│   │   └── router.ts           # HTTP route aggregation
│   ├── apps/                   # HTML App collection
│   │   ├── _shared/           # shared (auth, config, styles)
│   │   ├── dashboard/          # dashboard App
│   │   │   └── index.html
│   │   ├── chat/               # chat App
│   │   │   └── index.html
│   │   └── settings/           # settings App
│   │       └── index.html
│   ├── vendor/bundles/         # OpenClaw Bundles
│   │   ├── llm-core.esm.js
│   │   ├── agent-core.esm.js
│   │   ├── memory-host-sdk.esm.js
│   │   └── OPENCLAW_VERSIONS.json
│   └── package.json
├── shell/                      <- Tauri Shell (wrapper)
│   ├── src-tauri/             # Rust code
│   │   └── src/
│   │       ├── main.rs       # entry: start Node + window
│   │       ├── menu.rs         # menu management
│   │       └── ipc.rs          # Tauri IPC (window control)
│   └── tauri.conf.json
└── scripts/
    └── extract-openclaw.mjs    # extract OpenClaw bundles script
```

### 4.2 模块详解

#### agent.ts — Agent Chat + buildStreamFn（协议适配层）

核心职责：串联 agentLoop + buildStreamFn + LLM API。

**buildStreamFn 协议自适应逻辑：**

```typescript
function buildStreamFn(baseUrl: string, apiKey: string, model: string) {
  return async function streamSimple(
    model: any,
    messages: any[],
    options: any,
    signal: AbortSignal
  ): Promise<EventStream> {
    // 1. 自动检测 baseurl 是否带 /v1 后缀
    const normalizedBaseUrl = baseUrl.endsWith('/v1') ? baseUrl : baseUrl + '/v1';
    const endpoint = normalizedBaseUrl + '/chat/completions';

    // 2. 检测协议类型（OpenAI vs Anthropic）
    // OpenAI: choice.delta.content -> text_delta
    // Anthropic: choice.delta.delta.text -> text_delta
    // 两者都通过 finish_reason 触发 done
    // 实际通过响应结构自动判断
    const stream = new EventStream(isComplete, extractResult);

    // 3. SSE 解析：content_block_delta -> text_delta
    // finish_reason -> done
    //    两者可能在同一 chunk 中（先处理 delta，再处理 done）
    // 4. 返回 EventStream 给 agentLoop 消费
  };
}
```

**协议检测关键点：**
- OpenAI: choice.delta.content -> text_delta, choice.finish_reason -> done
- Anthropic: choice.delta.delta.text -> text_delta, choice.finish_reason -> done
- 两者 finish_reason 可能与最后一个 content_block_delta 在同一 SSE chunk 中
  -> 必须先处理 content_block_delta，再处理 finish_reason

**baseurl 自动适配：**
- 输入 https://api.example.com/v1 -> 直接使用
- 输入 https://api.example.com -> 自动追加 /v1

#### session.ts — Session 管理

职责：JSONL 文件读写，Agent 消息持久化。

```typescript
import { JsonlSessionStorage } from '../vendor/bundles/agent-core.esm.js';

const nodeFs = {
  async readTextFile(path) { return { ok: true, value: readFileSync(path, 'utf-8') }; },
  async writeFile(path, content) { writeFileSync(path, content, 'utf-8'); return { ok: true }; },
};

export async function createSessionStore(dataDir: string) {
  const sessionsPath = join(dataDir, 'sessions');
  return {
    async getMessages(sessionKey: string) { ... },
    async appendMessage(sessionKey: string, msg: AgentMessage) { ... },
  };
}
```

#### skills.ts — Skills 加载（复用 agent-core）

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
  return { skills: result.skills, diagnostics: result.diagnostics };
}
```

### 4.2 模块详解

#### `ipc.ts` — JSON-RPC 编解码

职责：
- 读 `stdin` 逐行解析 JSON-RPC 请求
- 写 `stdout` 发送响应和流式事件
- 处理 parse error，返回 error response

```typescript
export async function startIpcLoop(agent: Agent) {
  const stdin = readline.createInterface({ input: process.stdin });
  for await (const line of stdin) {
    if (!line.trim()) continue;
    try {
      const req = JSON.parse(line) as Request;
      const response = await handleRequest(agent, req);
      console.log(JSON.stringify(response));
    } catch (e) {
      console.log(JSON.stringify(errorResponse(null, -32600, String(e))));
    }
  }
}
```

#### `llm.ts` — LLM 配置解析

职责：
- 从共享配置文件读取 providers 配置
- 转换为 `agent-core` 的 `Model` 类型
- 支持：OpenAI Responses、Anthropic Messages、Ollama、Azure OpenAI

```typescript
export interface LLMConfig {
  providers: Record<string, ProviderConfig>;
  activeProvider: string;
}

export function resolveModel(config: LLMConfig): Model {
  const provider = config.providers[config.activeProvider];
  const modelDef = provider.models[0];
  return {
    id: modelDef.id,
    name: modelDef.name,
    provider: config.activeProvider,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  };
}
```

#### `memory.ts` — Memory 集成

DesktopWork memory 架构分两层：

| 层 | 实现 | 来源 |
|----|------|------|
| **Session 持久化** | `JsonlSessionStorage` | agent-core bundle |
| **Memory Prompt 构建** | `buildActiveMemoryPromptSection` | memory-host-sdk bundle |

**集成时机**：每次 `agentLoop` 调用前，将 session 历史 + memory prompt section 合并为完整 context 传入。

```
用户消息
  ↓
buildActiveMemoryPromptSection({ sessionId, recentMessages })
  ↓ memory section
session.ts 读取历史 JSONL
  ↓ session history
合并 → agentLoop({ messages: [...memorySection, ...sessionHistory, userMsg] })
  ↓
LLM 回复
```

**当前状态**：`memory.ts` 未创建（Phase 4+ 任务）；session 持久化已在 session.ts 实现。

#### `skills.ts` — Skills 加载

职责：
- 使用 OpenClaw Bundle: agent-core 的 `loadSkills()`
- skills 目录：`desktop-agent/skills/` + 用户可选的额外目录
- 启动时加载，运行时复用

```typescript
import { loadSkills } from '../vendor/bundles/agent-core.esm.js';

export async function loadUserSkills(skillsDirs: string[]) {
  const env = { readFile: fs.promises.readFile, readDir: fs.promises.readdir, ... };
  const { skills, diagnostics } = await loadSkills(env, skillsDirs);
  return { skills, diagnostics };
}
```

#### `session.ts` — Session 管理

职责：
- 每个 `sessionKey` 对应一个 JSONL 文件（`sessions/<sessionKey>.jsonl`）
- 完整消息历史（role + content + timestamp）
- 支持 compaction（上下文超阈值时自动压缩）
- Session 存储在 desktop-agent 可访问的本地目录

**Compaction 阈值**（来自 `DEFAULT_COMPACTION_SETTINGS`）：
- `enabled: true`
- `reserveTokens: 16384`（保留 token 上限）
- `keepRecentTokens: 20000`（保留最近 token 数）

当上下文 token 超过 `reserveTokens + keepRecentTokens` 时触发压缩，调用 `compact()` 将旧消息合并为摘要。

```typescript
export interface SessionStore {
  getMessages(sessionKey: string): Promise<AgentMessage[]>;
  appendMessage(sessionKey: string, msg: AgentMessage): Promise<void>;
  compactIfNeeded(sessionKey: string): Promise<void>;
}

export function createSessionStore(storagePath: string): SessionStore { ... }
```

#### `agent.ts` — Agent Loop 封装

核心胶水层，把所有模块串联起来：

```typescript
export interface Agent {
  chat(message: string, sessionKey: string): Promise<{ text: string; messages: AgentMessage[] }>;
  shutdown(): Promise<void>;
}

export async function createAgent(config: AgentConfig): Promise<Agent> {
  // LLM config 从 ~/.openclaw/openclaw.json 读取
  const llmConfig = loadLLMConfig();
  const model = resolveModel(llmConfig);
  const sessionsPath = join(config.dataDir, 'sessions');
  const sessionStore = createSessionStore(sessionsPath);

  return {
    async chat(message: string, sessionKey: string) {
      const history = await sessionStore.getMessages(sessionKey);
      const userMsg: AgentMessage = {
        id: uuid(),
        role: 'user',
        content: message,
        timestamp: Date.now()
      };

      // agentLoop returns EventStream; collect stream and return Promise
      const stream = agentLoop([userMsg], { systemPrompt: '', messages: history }, { model });

      let fullText = '';
      let finalMessages: AgentMessage[] = [];
      for await (const event of stream) {
        if (event.type === 'content_delta') fullText += event.delta;
        if (event.type === 'message_end') finalMessages = [event.message];
      }

      await sessionStore.appendMessage(sessionKey, userMsg);
      if (finalMessages.length) await sessionStore.appendMessage(sessionKey, finalMessages[0]);

      return { text: fullText, messages: finalMessages };
    },
    async shutdown() { /* cleanup */ }
  };
}
```

#### `index.ts` — 入口 / Stdio Main Loop

```typescript
// LLM config 从 ~/.openclaw/openclaw.json 读取（内部调用 loadLLMConfig()）
// skills 在启动时加载
const dataDir = resolveDataDir();

const agent = await createAgent({
  dataDir,
  skillsDirs: [join(dataDir, 'skills')],
});

await startIpcLoop((req, writeStream) => handleRequest(agent, req, writeStream));
```

### 4.3 chat 请求处理流程

```
1. ipc.ts 收到 stdin 请求:
   { "method": "chat", "params": { "message": "...", "sessionKey": "..." } }

2. 调用 agent.chat(message, sessionKey, onDelta)
   - session.ts 从 JSONL 加载历史消息
   - agent-loop 调用 LLM
   - 每个 delta 通过 onDelta 回调实时输出到 stdout

3. 每个 token 通过 stdout 输出:
   { "method": "stream", "params": { "delta": "token", "done": false } }

4. 流结束时:
   { "method": "stream", "params": { "delta": "", "done": true } }

5. 最终响应:
   { "result": { "text": "完整回复", "sessionKey": "..." } }

6. session.ts 追加 user message + assistant message 到 JSONL
```

> ⚠️ **streaming delta 实现状态**：当前 `index.ts` 的 `chat` handler 只发送 `done: true` 事件，token delta 在内部累积后通过最终响应返回。需要在 `agent.chat()` 增加 `onDelta` 回调参数（Phase 3 收尾）。

---

## 5. Tauri Shell 设计

### 5.1 职责（极简）

Shell 只做五件事，不写任何业务逻辑：

| 职责 | 说明 |
|------|------|
| **起 Node 子进程** | 启动 node desktop-agent/src/index.ts，管理进程生命周期 |
| **验证 Node 服务健康** | 轮询 /auth/me，确认服务 ready 后创建窗口 |
| **创建窗口加载 WebView** | 窗口加载 http://localhost:PORT |
| **菜单管理** | 从 Node /config 获取菜单结构，渲染为原生菜单或 HTML 侧边栏 |
| **窗口控制** | 最小化、最大化、关闭 |
| **打包** | .exe / .dmg / .AppImage |

### 5.2 不做

- **不写业务逻辑** — Auth、Config、Agent 全部在 Node 层
- **不处理 IPC** — 不需要 Rust <-> Node 通信
- **不编译 Rust 业务代码** — Rust 只做窗口管理和进程启动

### 5.3 Node 进程管理

```rust
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

### 5.4 菜单配置

菜单结构从 Node /config 获取，由 Node 层管理：

```json
{
  "menu": [
    { "id": "dashboard", "label": "主面板", "icon": "home", "appId": "dashboard" },
    { "id": "chat",      "label": "对话",   "icon": "chat", "appId": "chat" },
    { "id": "settings",  "label": "设置",   "icon": "gear", "appId": "settings" }
  ]
}
```

Shell 通过 HTTP 请求获取菜单，渲染为原生菜单或 HTML 侧边栏。

## 6. 前端设计

### 6.1 布局

```
┌─────┬────────────────────────────────────────────┐
│     │                                            │
│  S  │                                            │
│  I  │              Main Content                  │
│  D  │              (Chat / Settings)            │
│  E  │                                            │
│  B  │                                            │
│  A  │                                            │
│  R  │                                            │
│     ├────────────────────────────────────────────┤
│     │              Input / Actions               │
└─────┴────────────────────────────────────────────┘
```

- **Sidebar**：左侧固定宽度 200px，导航 + 状态
- **Main Content**：右侧自适应，Chat 或 Settings
- **Input Area**：底部固定，消息输入框

### 6.2 Sidebar 样式

```
┌──────────┐
│  Logo    │  ← 应用名称或图标
├──────────┤
│ 💬 聊天  │  ← Tab 切换，当前 Tab 高亮 brand-600
│ ⚙ 设置  │
├──────────┤
│          │
│          │
├──────────┤
│ 就绪     │  ← 静态状态指示，无交互
└──────────┘
```

**样式细节**：
- 宽度：200px
- 背景：`bg-gray-900`
- 文字色：`text-gray-300`，高亮 `text-brand-500`
- Tab hover：`bg-gray-800`
- 状态文字：`text-gray-500 text-xs`

### 6.3 Chat UI 样式

**消息列表区域**：
- 内边距：20px
- 消息间距：16px
- 用户消息：右对齐，`bg-brand-600`，白色文字
- 助手消息：左对齐，`bg-gray-800`，灰色文字
- 消息圆角：12px
- 消息最大宽度：70%

**输入区域**：
- 内边距：16px
- 输入框：全宽，带边框 `border-gray-700`，focus `border-brand-500`
- 发送按钮：`bg-brand-600 hover:bg-brand-700`
- placeholder：`text-gray-500`

**加载状态**：
- "thinking..." 文字：`text-gray-400 text-sm`
- 左对齐，灰色背景气泡

**字体**：
- 主字体：`font-sans`（系统无衬线）
- 代码：`font-mono`
- 消息内容：`whitespace-pre-wrap`

### 6.4 Settings UI 样式

**整体**：
- 内边距：24px
- 最大宽度：640px
- 垂直间距：24px

**表单元素**：
- Label：`text-sm text-gray-400`，上方对齐
- Input/Select：`bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm`
- Focus 状态：`focus:outline-none focus:border-brand-500`
- 保存按钮：`bg-brand-600 hover:bg-brand-700 disabled:opacity-50`

**Provider 选择**：
- Select 下拉框，支持 OpenAI / Anthropic / Ollama / Azure

**字段**：
- API Type（Select）
- Base URL（Input，placeholder 示例）
- API Key（Input，type=password）
- Model ID（Input）

**保存反馈**：
- 保存中："保存中..." 禁用状态
- 已保存："已保存" 提示，2秒后消失

### 6.5 颜色系统

```css
/* 背景 */
bg-gray-950  /* 主背景 */
bg-gray-900 /* Sidebar */
bg-gray-800  /* 卡片/输入框 */

/* 边框 */
border-gray-700  /* 输入框边框 */
border-gray-800   /* 分割线 */

/* 文字 */
text-gray-100 /* 主要文字 */
text-gray-300  /* 次要文字 */
text-gray-500  /* 占位符/禁用 */

/* 品牌色 */
bg-brand-600    /* 主按钮 */
bg-brand-700    /* 按钮 hover */
text-brand-500  /* 激活状态 */

/* 错误 */
bg-red-900/30  /* 错误背景 */
border-red-800 /* 错误边框 */
text-red-300   /* 错误文字 */
```

### 6.6 Settings 字段说明

| 字段 | 说明 | 示例 |
|------|------|------|
| Provider | LLM 提供商 | openai / anthropic / ollama / azure |
| API Type | API 协议类型 | openai-responses / anthropic-messages / ollama |
| Base URL | API 端点 | `https://api.openai.com/v1` |
| API Key | 访问密钥 | `sk-...` |
| Model ID | 模型标识 | `gpt-4o` / `claude-3-5-sonnet-latest` |

---

## 7. 配置与数据存储

### 7.1 配置文件

使用 `~/.openclaw/openclaw.json`，desktop-agent 启动时读取其中 `models.providers` 配置。

```json
{
  "models": {
    "activeProvider": "openai",
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-...",
        "api": "openai-responses",
        "models": [{
          "id": "gpt-4o",
          "name": "GPT-4o",
          "contextWindow": 128000,
          "maxTokens": 8192,
          "reasoning": false,
          "input": ["text", "image"],
          "cost": { "input": 2.5, "output": 10, "cacheRead": 1.25, "cacheWrite": 10 }
        }]
      }
    }
  }
}
```

### 7.2 数据目录

| 数据 | 路径（Windows） | 路径（macOS/Linux） |
|------|-----------------|---------------------|
| 应用数据根目录 | `%LOCALAPPDATA%/desktopwork/` | `~/.local/share/desktopwork/` |
| OpenClaw 配置 | `desktopwork/.openclaw/openclaw.json` | 同 |
| Agent 会话（JSONL） | `desktopwork/.openclaw/sessions/` | 同 |
| Agent 记忆（向量） | `desktopwork/.openclaw/memory/` | 同 |
| Agent 日志 | `desktopwork/agent.log` | 同 |
| desktop-agent 源码 | `desktopwork/desktop-agent/` | 同 |

---

## 8. 日志系统

### 8.1 日志级别

| 级别 | 用途 | 输出位置 |
|------|------|----------|
| `error` | Agent 运行错误、LLM 调用失败 | stderr → agent.log |
| `warn` | 配置缺失、API 异常但可恢复 | stderr → agent.log |
| `info` | 启动完成、Session 切换、配置加载 | stderr → agent.log |
| `debug` | 详细 IPC 交互、工具调用参数 | stderr → agent.log（调试模式） |

### 8.2 日志格式

```
[2026-06-09T09:00:00.000Z] [INFO] [desktop-agent] Agent started, memory engine ready
[2026-06-09T09:00:01.234Z] [INFO] [desktop-agent] Session switched: desktop:main
[2026-06-09T09:00:05.567Z] [DEBUG] [desktop-agent] IPC → chat request, sessionKey=desktop:main
[2026-06-09T09:00:06.789Z] [ERROR] [desktop-agent] LLM request failed: API key invalid
```

**格式**：`[时间戳] [级别] [模块名] 消息`

### 8.3 Rust 侧日志收集

desktop-agent 的 stderr 由 Rust 进程收集，写入 `agent.log`：

```rust
fn spawn_output_reader<F>(child: &mut tokio::process::Child, mut line_cb: F)
where
    F: FnMut(String) + Send + 'static,
{
    if let Some(stderr) = child.stderr.take() {
        let mut reader = tokio::io::BufReader::new(stderr);
        tauri::async_runtime::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end().to_string();
                        tracing::error!("[desktop-agent] {}", trimmed);
                        line_cb(trimmed);
                    }
                    Err(_) => break,
                }
            }
        });
    }
}
```

### 8.4 日志查看

Rust 提供 Tauri Command 供前端查看日志：

```rust
#[tauri::command]
fn app_log_tail(n: Option<usize>) -> Result<String, String> {
    let log_path = resolve_state_dir().join("agent.log");
    let n = n.unwrap_or(100);
    let content = std::fs::read_to_string(&log_path).unwrap_or_default();
    let lines: Vec<&str> = content.lines().rev().take(n).collect();
    Ok(lines.into_iter().rev().collect::<Vec<_>>().join("\n"))
}
```

前端在 Settings 面板底部提供日志查看展开区。

---

## 9. 构建与发布

### 9.1 构建命令

```bash
# 开发（Tauri 起 Node + 窗口）
pnpm tauri dev

# 生产打包
pnpm tauri build
```

### 9.2 Tauri 配置（tauri.conf.json）

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "DesktopWork",
  "version": "0.1.0",
  "identifier": "com.benjamin.desktopwork",
  "build": {
    "devtools": true
  },
  "app": {
    "windows": [{
      "title": "DesktopWork",
      "width": 900,
      "height": 700,
      "minWidth": 600,
      "minHeight": 400
    }],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png"]
  }
}
```

**关键说明**：
- 无 `beforeDevCommand`：Node 服务由 Tauri Rust 侧通过 `Command::new("node")` 启动
- 无 `frontendDist`：前端是 HTML App，由 Node HTTP 服务提供
- 无 `bundle.resources`：Node进程通过 Tauri Command 启动，不作为静态资源打包

### 9.3 desktop-agent 打包

desktop-agent 是标准 Node 应用，打包时：
1. `desktop-agent/vendor/bundles/` 已纳入 git（不依赖 submodule）
2. Tauri 启动时通过 `shell/src-tauri/src/main.rs` 启动 Node 进程
3. 不需要额外打包步骤

### 9.4 开发流程

```bash
# 1. 独立运行 Node 服务（验证 API）
cd desktop-agent
node src/index.ts

# 2. Tauri 窗口内开发（热加载 HTML）
pnpm tauri dev

# 3. 生产打包
pnpm tauri build
```

## 11. 实现步骤（M1 -> M4 执行指导）

### M1：Node HTTP 服务可独立运行

> 目标：Tauri 启动前，Node 服务可以独立运行、测试

#### M1.1 目录结构
- [ ] 创建 desktop-agent/ 目录
- [ ] desktop-agent/package.json（express + TypeScript）
- [ ] desktop-agent/src/index.ts — HTTP server 入口（3737 端口）

#### M1.2 Auth Stub
- [ ] desktop-agent/src/auth.ts — Stub 实现（任意密码登录）
- [ ] POST /auth/login
- [ ] GET /auth/me
- [ ] POST /auth/logout
- [ ] JWT 生成（jsonwebtoken，临时固定密钥）

#### M1.3 Config
- [ ] desktop-agent/src/config.ts
- [ ] 配置文件：~/.config/desktopwork/config.json
- [ ] GET /config
- [ ] GET/PATCH /config/apps/:appId
- [ ] GET/PATCH /config/agent

#### M1.4 Agent Chat
- [ ] desktop-agent/src/agent.ts — buildStreamFn（协议适配层）
- [ ] 支持 OpenAI 协议（baseurl 有无 /v1 自动适配）
- [ ] 支持 Anthropic 协议自动检测
- [ ] POST /agent/chat — 流式 SSE + 非流式两种模式
- [ ] 集成 agent-loop（复用 agent-core bundle）
- [ ] 集成 loadSkills（复用 agent-core.loadSkills）

#### M1.5 Skills 薄包装
- [ ] desktop-agent/src/skills.ts — import agent-core.loadSkills
- [ ] GET /skills
- [ ] POST /skills/:id/enable|disable

#### M1.6 验证标准
- [ ] curl http://localhost:3737/auth/me 返回 401（未登录）
- [ ] curl -X POST http://localhost:3737/auth/login -d '{"username":"a","password":"b"}' 返回 token
- [ ] curl http://localhost:3737/config 返回配置
- [ ] curl -X POST http://localhost:3737/agent/chat -d '{"message":"hi"}' 返回流式响应
- [ ] 浏览器打开 http://localhost:3737/chat 能看到对话界面

---

### M2：HTML App 集成

> 目标：用户在浏览器里能看到完整的 App 界面，window.* API 正常工作

#### M2.1 共享资源
- [ ] desktop-agent/apps/_shared/auth.js — window.auth 注入
- [ ] desktop-agent/apps/_shared/config.js — window.config 注入
- [ ] desktop-agent/apps/_shared/styles.css — 共享样式

#### M2.2 dashboard App
- [ ] desktop-agent/apps/dashboard/index.html — 主面板

#### M2.3 chat App
- [ ] desktop-agent/apps/chat/index.html — 对话界面
- [ ] 调用 window.agent.chat() 流式对话
- [ ] 显示对话历史

#### M2.4 settings App
- [ ] desktop-agent/apps/settings/index.html — 设置界面
- [ ] 修改 LLM 配置（调用 PATCH /config/agent）
- [ ] 启停 Skills（调用 POST /skills/:id/enable|disable）

#### M2.5 验证标准
- [ ] 浏览器打开 http://localhost:3737/ -> dashboard
- [ ] 浏览器打开 http://localhost:3737/chat -> 对话正常
- [ ] window.auth.getUser() 能拿到用户信息
- [ ] window.config.get('chat') 能拿到配置

---

### M3：Tauri Shell

> 目标：cargo run 启动完整桌面 App

#### M3.1 Node 进程管理（Rust）
- [ ] shell/src-tauri/src/main.rs — 起 Node 子进程
- [ ] 端口检测（3737 自动检测占用）
- [ ] 等待 Node ready（轮询 /auth/me）
- [ ] 创建窗口加载 WebView

#### M3.2 菜单管理
- [ ] 从 GET /config 获取菜单结构
- [ ] 渲染为 HTML 侧边栏或原生菜单

#### M3.3 窗口控制
- [ ] 最小化、最大化、关闭

#### M3.4 验证标准
- [ ] cargo run 启动 Tauri -> Node 进程 -> 窗口显示 WebView
- [ ] 点击菜单项能切换 App
- [ ] 关闭窗口 Node 进程正确退出

---

### M4：打包发布

- [ ] pnpm build -> Windows .exe
- [ ] 双击运行，无需命令行
- [ ] 验证所有 M1-M3 功能在打包后正常

---

## 12. 潜在风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Node.js 进程崩溃 | 聊天不可用 | Tauri 监控 Node 进程退出，自动重启或提示用户 |
| JSONL 会话文件过大 | 读取慢 / 内存高 | 实现 compaction 阈值（session.ts 层面） |
| LLM API 错误传播 | 用户看到错误 | HTTP 层统一错误码，返回友好消息 |
| 配置文件变更后 Agent 未感知 | 配置不生效 | 运行时通过 PATCH /config API 立即生效 |
| 首次启动 LLM 连接慢 | 用户等待 | Agent 启动时预热 LLM 连接 |
| Windows Defender 误报 | 用户信任问题 | 代码签名或提供源码说明 |
| OpenClaw Submodule 未下载 | Bundles 缺失 | Bundles 已提交到 git，服务可独立运行不依赖 submodule |
