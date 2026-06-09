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
│                  Desktop App (Tauri)                      │
│                                                          │
│  ┌──────────────┐      ┌────────────────────────────┐   │
│  │  React UI    │◄────►│   Rust Backend             │   │
│  │  (WebView)   │      │   - 进程生命周期管理         │   │
│  │              │      │   - stdin/stdout IPC       │   │
│  │  - Chat UI   │      │   - 配置持久化 │   │
│  │  - Settings  │      │   - 日志收集 │   │
│  └──────────────┘      └───────────┬────────────────┘   │
│                                      │                   │
│                         stdin/stdout │                   │
│                         JSON-RPC     │                   │
│                                      ▼                   │
│                         ┌────────────────────────────┐   │
│                         │   desktop-agent.mjs        │   │
│                         │   (Node.js 长期进程)        │   │
│                         │                             │   │
│                         │   OpenClaw Bundles        │   │
│                         │   (agent-core,             │   │
│                         │    memory-host-sdk,        │   │
│                         │    llm-core)               │   │
│                         └────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
用户输入消息
    ↓
React UI (App.tsx)
    ↓ Tauri invoke("chat_send")
Rust Backend (lib.rs)
    ↓ stdin/stdout IPC (JSON-RPC)
desktop-agent.mjs
    ↓
agentLoop() + memory engine + skills
    ↓ 流式输出
Rust Backend (逐行读取 stdout)
    ↓ Tauri event emit
React UI (显示流式回复)
```

### 2.3 模块职责

| 模块 | 职责 |
|------|------|
| **React UI** | 聊天界面、LLM 配置界面 |
| **Rust Backend** | 进程管理、IPC 读写、配置持久化、日志 |
| **desktop-agent (Node.js)** | Agent Loop、记忆引擎、Skills加载、LLM 调用 |
| **OpenClaw Bundle: agent-core** | 核心 Agent 循环（消息→LLM→工具→回复） |
| **OpenClaw Bundle: memory-host-sdk** | 记忆存储与检索 |
| **OpenClaw Bundle: llm-core** | LLM provider 统一抽象 |

---

## 3. IPC 协议设计

### 3.1 协议概述

Rust 与 Node.js 通过 **stdin/stdout** 交换 **JSON-RPC 2.0** 格式消息。每条消息以换行符分隔（NDJSON）。

**通信模式**：
- Rust → Node.js：`stdin` 写入请求
- Node.js → Rust：`stdout` 写入响应/事件
- stderr：Node.js 日志输出，由 Rust 收集

### 3.2 请求格式（Rust → Node.js）

```typescript
// 通用请求格式
interface Request {
  jsonrpc: "2.0";
  id: string;           // 唯一请求 ID
  method: string;       // 方法名
  params?: unknown;     // 参数对象
}

// chat — 发送聊天消息（支持流式）
{
  "jsonrpc": "2.0",
  "id": "msg-001",
  "method": "chat",
  "params": {
    "message": "你好，帮我写一个 hello world",
    "sessionKey": "desktop:main"
  }
}

// status — 查询 agent 状态
{
  "jsonrpc": "2.0",
  "id": "ping-001",
  "method": "status"
}

// shutdown — 关闭 agent 进程
{
  "jsonrpc": "2.0",
  "id": "shutdown-001",
  "method": "shutdown"
}

// reload — 重载配置（LLM 配置变更后）
{
  "jsonrpc": "2.0",
  "id": "reload-001",
  "method": "reload"
}
```

### 3.3 响应格式（Node.js → Rust）

```typescript
// 成功响应
{
  "jsonrpc": "2.0",
  "id": "msg-001",
  "result": {
    "text": "你好，有什么可以帮你？",
    "sessionKey": "desktop:main"
  }
}

// 错误响应
{
  "jsonrpc": "2.0",
  "id": "msg-001",
  "error": {
    "code": -32603,
    "message": "LLM request failed: API key invalid"
  }
}
```

### 3.4 流式事件（Node.js → Rust）

```typescript
// 流式 delta（每个 token/片段）
{
  "jsonrpc": "2.0",
  "id": "msg-001",
  "method": "stream",
  "params": {
    "delta": "你好",
    "done": false
  }
}

// 流结束
{
  "jsonrpc": "2.0",
  "id": "msg-001",
  "method": "stream",
  "params": {
    "delta": "",
    "done": true
  }
}

// 流式错误
{
  "jsonrpc": "2.0",
  "id": "msg-001",
  "method": "stream",
  "params": {
    "error": "Connection timeout",
    "done": true
  }
}
```

### 3.5 错误码约定

| code | 含义 |
|------|------|
| -32600 | Invalid Request（格式错误） |
| -32601 | Method not found（未知方法） |
| -32602 | Invalid params（参数无效） |
| -32603 | Internal error（Agent 内部错误，如 LLM 失败） |

---

## 4. desktop-agent 模块设计

### 4.1 目录结构

```
desktopwork/
├── desktop-agent/           ← Agent 核心（Node.js）
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # 入口：stdio IPC 主循环
│       ├── ipc.ts           # JSON-RPC 编解码
│       ├── agent.ts          # agent-loop 封装
│       ├── session.ts        # Session 管理（JSONL 持久化）
│       ├── memory.ts         # memory 集成（session 持久化 + memory prompt 构建）
│       ├── skills.ts         # skills 加载
│       ├── llm.ts           # LLM 模型解析
│       └── types.ts         # 类型定义
├── src-tauri/               ← Tauri 后端
│   ├── src/
│   │   ├── lib.rs          # 进程管理、IPC 读写
│   │   └── main.rs
│   └── tauri.conf.json
└── src/                     ← React 前端
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

## 5. Rust 侧设计

### 5.1 Tauri Commands

| Command | 说明 |
|---------|------|
| `agent_start` | 启动 desktop-agent 进程 |
| `agent_stop` | 停止 desktop-agent |
| `agent_status` | 查询状态（running/stopped/error） |
| `chat_send` | 发送消息，返回流式响应 |
| `config_read` | 读取 openclaw.json |
| `config_write` | 写入 openclaw.json |
| `config_patch` | 局部更新配置 |

### 5.2 进程管理

```rust
fn spawn_desktop_agent(agent_path: &str) -> tokio::process::Child {
    let mut cmd = Command::new("node");
    cmd.arg(agent_path);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.current_dir(Path::new(agent_path).parent().unwrap());
    cmd
}
```

### 5.3 IPC 读写循环

```rust
async fn read_agent_output(stdout: tokio::process::ChildStdout, tx: mpsc::Sender<String>) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    tx.send(trimmed.to_string()).await;
                }
            }
            Err(_) => break,
        }
    }
}
```

### 5.4 chat_send 实现

```rust
#[tauri::command]
async fn chat_send(
    state: State<'_, Arc<AgentState>>,
    message: String,
    session_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let session_key = session_key.unwrap_or_else(|| "desktop:main".to_string());
    let (stream_tx, stream_rx) = mpsc::channel(100);

    // 写入 stdin
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": uuid::Uuid::new_v4().to_string(),
        "method": "chat",
        "params": { "message": message, "sessionKey": session_key }
    });
    state.stdin.write().await
        .write_all(format!("{}\n", req).as_bytes()).await
        .map_err(|e| e.to_string())?;

    // 收集流式响应
    let mut full_text = String::new();
    while let Some(line) = stream_rx.recv().await {
        if let Ok(evt) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(delta) = evt.pointer("/params/delta") {
                full_text.push_str(delta.as_str().unwrap_or(""));
            }
        }
    }

    Ok(serde_json::json!({ "text": full_text }))
}
```

---

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
# 开发构建
pnpm tauri dev

# 生产构建
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
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
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
    "icon": ["icons/32x32.png", "icons/128x128.png"],
    "resources": {
      "../desktop-agent": "desktop-agent"
    }
  }
}
```

**关键配置说明**：
- `bundle.resources`：将 `desktop-agent/` 目录打包为 `desktop-agent` 资源
- `bundle.identifier`：反向域名标识符，用于系统集成
- `app.windows`：默认窗口大小 900×700，最小 600×400

### 9.3 desktop-agent 打包

desktop-agent 不使用 pnpm workspace 链接，依赖预编译的 OpenClaw Bundle。

**打包流程**：
1. （可选）运行 `node scripts/extract-openclaw.mjs` 更新 bundle
2. 将 `desktop-agent/vendor/bundles/` 整体打包入 Tauri 资源目录
3. 不需要 TypeScript 编译（源码即分发）

**package.json 配置**：

```json
{
  "name": "desktop-agent",
  "version": "0.1.0",
  "type": "module",
  "main": "vendor/bundles/agent-core.esm.js",
  "scripts": {
    "build": "echo 'Bundles pre-built via scripts/extract-openclaw.mjs'",
    "extract": "node ../../scripts/extract-openclaw.mjs --openclaw ../../vendor/openclaw --out vendor/bundles"
  },
  "dependencies": {
    "ignore": "^7.0.5",
    "typebox": "^1.1.39",
    "yaml": "^2.9.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

> 注意：`dependencies` 中不再有 OpenClaw 包，它们通过 `vendor/bundles/` 引入。

### 9.4 构建输出

| 平台 | 输出 |
|------|------|
| Windows | `src-tauri/target/release/bundle/nsis/*.exe` |
| macOS | `src-tauri/target/release/bundle/dmg/*.app` |
| Linux | `src-tauri/target/release/bundle/deb/*.deb` |

---

## 10. 内存占用预估

| 组件 | 预估内存 |
|------|----------|
| Node.js 运行时 | ~30MB |
| OpenClaw Bundle: agent-core | ~10MB |
| OpenClaw Bundle: memory-host-sdk | ~8MB |
| OpenClaw Bundle: llm-core | ~5MB |
| 其他（skills loader 等） | ~5MB |
| **总计** | **~55-60MB** |

---

## 11. 实现步骤

### Phase 1：基础设施

1. 创建 `desktop-agent/` 目录结构
2. 配置 `package.json`（依赖 OpenClaw Bundle，不使用 workspace 链接）
3. 实现 `ipc.ts`（JSON-RPC stdio loop）
4. 实现 `index.ts`（入口，验证可启动）

### Phase 2：核心功能

5. 实现 `llm.ts`（配置解析）
6. 实现 `agent.ts`（agent-loop 封装）
7. 实现 `session.ts`（JSONL 持久化）
8. 实现 `chat` 请求处理（单轮对话验证）

### Phase 3：完整功能

9. 实现 `memory.ts`（session 持久化 + buildActiveMemoryPromptSection）
10. 实现 `skills.ts`（skills 加载）
11. 实现流式输出（`stream` 事件）
12. 实现 `status` / `shutdown` / `reload` 请求

### Phase 4：Rust 集成

13. 创建 `src-tauri/src/lib.rs`：实现 `spawn_desktop_agent`
14. 实现 Rust 侧 IPC 读写循环
15. 更新 `chat_send` 命令（走 stdin/stdout）
16. 更新 `agent_start/stop/status` 命令
17. 新建 React 前端（Chat UI + Settings UI）

### Phase 5：测试与调优

18. 端到端聊天测试
19. 记忆持久化验证
20. 配置变更热重载
21. 内存占用测量
22. 构建验证（Windows / macOS / Linux）

---

## 12. 潜在风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Node.js 进程崩溃 | 聊天不可用 | Rust 监控进程退出，自动重启 |
| JSONL 会话文件过大 | 读取慢 / 内存高 | 实现 compaction 阈值 |
| LLM API 错误传播 | 用户看到错误 | IPC 层统一错误码，Rust 转换为友好消息 |
| 配置文件变更 | Agent 未感知 | `reload` 方法重读配置 |
| 首次启动 LLM 连接慢 | 用户等待 | Agent 启动时预热 LLM 连接 |
| Windows Defender 误报 | 用户信任问题 | 代码签名或提供源码说明 |