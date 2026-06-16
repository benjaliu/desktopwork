# DesktopWork 技术设计文档

> Last updated: 2026-06-12
> Status: Draft v0.2（基于 Claude Agent SDK 0.3.174 实测重写）
> 配套产品文档：docs/product/PRD-DESKTOPWORK.md
> 前置验证：见 §十一.附录 A（2026-06-12 SDK 验证记录）

---

## 一、文档目的与范围

### 1.1 目的

本文档是 DesktopWork 项目的技术设计文档，配套产品文档（PRD-DESKTOPWORK.md）使用。产品文档描述「做什么」，本文档描述「怎么做」。

### 1.2 范围

- Platform 进程（Node.js）的架构与实现
- Tauri（Rust）与 Platform 进程的协作
- **Claude Agent SDK 集成方式**（v0.2：subprocess 模型，非 in-process）
- App 容器模型与目录结构
- MVP（v0.1）的实施路径

### 1.3 不在本文档范围

- Tauri 前端 UI 的具体设计
- 第三方 App 集成机制（v0.5+ 再考虑）
- 商业化策略

---

## 二、架构总览

### 2.1 架构目标

| 目标 | 描述 |
|------|------|
| **进程解耦** | Tauri 只做窗口和原生能力，业务逻辑全在 Platform 进程 |
| **单一入口** | Platform 进程作为业务后端，前端通过 HTTP 调用 |
| **可扩展** | 新增 App 不需要改 Platform 主框架 |
| **本地优先** | 所有数据本地存储，AI 调用走用户配置的 Provider |
| **轻量引擎** | 不自建 AI runtime，直接封装 Claude Agent SDK |
| **Provider 灵活** | 支持任意 Anthropic 兼容协议的 Provider（Anthropic / Bedrock / Vertex / MiniMax / GLM / 自建） |

### 2.2 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│  Tauri App（Rust 进程）                                       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  React Frontend（WebView 内）                          │  │
│  │  Workbench UI                                          │  │
│  │  ├── Sidebar  (App List)                              │  │
│  │  └── App Area  (渲染当前 App 的 UI)                    │  │
│  │  Platform API Client                                   │  │
│  │  └── fetch('/api/...') + EventSource('/api/.../stream')│  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Tauri 职责：                                                │
│  - 窗口管理（标题、大小、最小化、关闭）                        │
│  - 系统托盘                                                  │
│  - 原生对话框（文件选择、消息框）                              │
│  - 系统通知                                                  │
│  - spawn + 管理 Platform 进程                                │
│  - 自动启动（开机自启）                                       │
│  - 打包 Claude Agent SDK 原生二进制到 bundle                  │
└──────────────────────────────────────────────────────────────┘
       │ HTTP localhost:3737 (auth token)
       │ SSE 流式响应
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Platform 进程（Node.js）                                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  HTTP Server（Express）                                 │  │
│  │  ├── Platform API  /api/platform/...                   │  │
│  │  └── App API      /api/:appId/...                      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Platform Core（主框架）                                │  │
│  │  ├── App Registry     — App 注册与路由分发             │  │
│  │  ├── Config Manager   — 全局配置管理（per-request 读） │  │
│  │  ├── Auth             — 统一认证                       │  │
│  │  ├── Storage          — 数据存储抽象                   │  │
│  │  ├── Skills Runtime   — Skills 加载与执行              │  │
│  │  └── Claude Runner    — Claude subprocess 生命周期     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  AI Layer（Claude Agent SDK 封装）                      │  │
│  │  ├── agent-service    — query() 包装 + env 构造        │  │
│  │  ├── event-converter  — SDKMessage → 平台事件          │  │
│  │  └── startup-warmer   — 预热 subprocess                │  │
│  │  （v0.1 不实现 session-store：所有 session 状态走 SDK，详见 §3.8）│  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Apps（独立模块）                                        │  │
│  │  ├── bot-chat/        — Bot Chat 后端                  │  │
│  │  └── ...                                               │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
       │ spawn child_process (stdio JSON-RPC)
       │ per-request env: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Claude Code Subprocess（独立二进制，每次 query 一次或预热）   │
│  @anthropic-ai/claude-agent-sdk-linux-x64/claude            │
│  - 内置 Agent Loop（推理 + tool 调度）                        │
│  - 内置工具（Read/Edit/Bash/Grep/Glob/WebSearch 等）          │
│  - 内置 Session 管理                                          │
│  - 通信：stdio JSON-RPC                                       │
└──────────────────────────────────────────────────────────────┘
       │ HTTPS（用户配置的 API Key / Base URL）
       ▼
┌──────────────────────────────────────────────────────────────┐
│  LLM Provider（任意 Anthropic 兼容协议）                       │
│  - Anthropic 官方（https://api.anthropic.com）                │
│  - AWS Bedrock / GCP Vertex（Claude 模型）                   │
│  - MiniMax（https://api.minimaxi.com/anthropic）★ 已验证     │
│  - GLM / DeepSeek / 自建（Anthropic 协议网关）                │
│  - LiteLLM 代理（暴露 Anthropic 端点）                        │
└──────────────────────────────────────────────────────────────┘
```

### 2.3 核心决策

| 决策 | 选择 | 原因 |
|------|------|------|
| AI Agent 引擎 | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | 官方维护、Agent Loop + 工具集 + Session 内置 |
| 集成方式 | **Subprocess 封装** | SDK 实际是 spawn 一个 Claude Code 二进制子进程，通过 stdio JSON-RPC 通信（v0.2 验证） |
| LLM Provider 协议 | **Anthropic Messages 协议** | Claude Agent 原生协议；不直接支持 OpenAI 协议（要 OpenAI 需 LiteLLM 中转） |
| 第三方 Provider 配置 | **per-request `env` 透传** | SDK Options 中 baseURL/apiKey 无直接字段，必须用 `env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN }`（v0.2 验证） |
| 配置生效时机 | **per-request 热更新** | 每次 query() 读最新 config.json，不需重启 Platform 进程（v0.2 验证） |
| 流式响应 | **`includePartialMessages: true`** + `stream_event` 转换 | SDK 默认返回完整 assistant message，开启此选项后拿到 `content_block_delta.text_delta`（v0.2 验证） |
| HTTP 框架 | **Express** | 轻量、成熟、Node.js 首选 |
| 前端框架 | **React 19 + Vite + TypeScript** | Tauri 官方推荐栈 |
| 桌面框架 | **Tauri 2.0** | 轻量、跨平台、安全 |

---

## 三、Claude Agent SDK 集成

### 3.1 选型背景

DesktopWork 的核心是「Claude Code 的桌面封装」，所以 AI 引擎必须：
- 提供完整 Agent 能力（推理 + tool 调度 + 多轮对话）
- 暴露内置工具集（Read/Edit/Bash/Grep/Glob）
- 处理 Session 持久化与续接
- 流式输出供前端展示

**Claude Agent SDK 是唯一同时满足以上四点的官方方案。**

### 3.2 包名澄清（重要！避免误用）

| 包名 | 用途 | 是否用于 Platform |
|------|------|------------------|
| `@anthropic-ai/claude-code` | **CLI 启动器**（`bin/claude`），无 programmatic API | ❌ |
| `@anthropic-ai/claude-code-darwin-arm64` 等 | CLI 的平台二进制（optional deps） | ❌ |
| **`@anthropic-ai/claude-agent-sdk`** | **TypeScript Agent SDK**（`query()`、`Options`、`startup()`） | ✅ **本项目使用** |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` 等 | Agent SDK 的平台二进制（~4.7MB） | ✅ 随 SDK 自动装 |
| `@anthropic-ai/sdk` | 通用 Claude API SDK（`messages.create()`） | ❌ 不适合 Agent |

> **历史**：原 `@anthropic-ai/claude-code` 曾同时是 CLI 和 SDK，但 2026 年官方将 SDK 拆出并重命名为 `@anthropic-ai/claude-agent-sdk`。本文档统一使用新包名。

### 3.3 集成架构：subprocess 模型

**SDK 实际工作方式**（v0.2 验证）：

```
┌──────────────────────────────────────────────────────────┐
│  Platform 进程（Node.js）                                 │
│                                                          │
│  agent-service.ts:                                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │  const q = query({                                 │  │
│  │    prompt: "...",                                  │  │
│  │    options: {                                      │  │
│  │      model: "...",                                 │  │
│  │      env: { ANTHROPIC_BASE_URL, ... },            │  │
│  │      includePartialMessages: true,                 │  │
│  │      ...                                           │  │
│  │    }                                                │  │
│  │  });                                                │  │
│  │  for await (const msg of q) { ... }                 │  │
│  └────────────────────────────────────────────────────┘  │
│       │                                                  │
│       │ spawn('claude', [], { env: {...}, stdio: pipe }) │
│       ▼                                                  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Claude Code Subprocess（独立进程）                 │  │
│  │  - 内部维护 Agent Loop                              │  │
│  │  - 调用 LLM Provider                                │  │
│  │  - 执行 tool（Read/Edit/Bash...）                  │  │
│  │  - 通过 stdio 返回 SDKMessage 流                    │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**关键事实**：
- 不是"in-process"调用，是真正的 subprocess
- 通信协议：stdio JSON-RPC
- 单次 query() 启动一个子进程（或复用 startup() 预热的进程）
- 子进程退出后即销毁，无状态泄漏

### 3.4 LLM Provider 配置

#### 配置入口：env 变量

SDK 的 `Options` 类型**没有** `baseURL` / `apiKey` 字段，唯一可配置入口是 `env: Record<string, string | undefined>`。

**SDK 源码注释原文**（`sdk.d.ts`）：

> `env` REPLACES the subprocess environment entirely — it is not merged with `process.env`. Spread `process.env` yourself if the subprocess still needs inherited variables like `PATH`, `HOME`, or `ANTHROPIC_API_KEY`. When omitted, the subprocess inherits `process.env`.

#### 关键 env 变量

| 变量 | 作用 | 必需？ |
|------|------|-------|
| `ANTHROPIC_API_KEY` | 官方 API key（或 `ANTHROPIC_AUTH_TOKEN`） | ✅（用官方时） |
| `ANTHROPIC_AUTH_TOKEN` | 第三方 Provider 用的 token（与 `ANTHROPIC_API_KEY` 二选一） | ✅（用第三方时） |
| `ANTHROPIC_BASE_URL` | 替换 API 端点（用于第三方 Provider） | ⚠️ 第三方必填 |
| `ANTHROPIC_MODEL` | 默认模型（可被 `options.model` 覆盖） | 可选 |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | SDK 客户端标识（用于 User-Agent 头） | 推荐 |

#### 平台侧实现：per-request env 构造

```typescript
// src/ai/agent-service.ts
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import { CONFIG_PATH } from '../platform/paths.js';  // 统一路径（§5.8）

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function buildEnv(cfg: Config): Record<string, string | undefined> {
  return {
    ...process.env,                  // 关键：保留 PATH / HOME / 系统变量
    ANTHROPIC_BASE_URL: cfg.agent.baseUrl || undefined,
    ANTHROPIC_AUTH_TOKEN: ***
    CLAUDE_AGENT_SDK_CLIENT_APP: 'desktopwork/0.1.0',
    DISABLE_TELEMETRY: '1',
  };
}
```

**核心特性**：
- ✅ 每次 `query()` 调用前**重新读 config.json** → 配置变更无需重启
- ✅ `...process.env` 保留系统变量 → 子进程能正常 spawn 工具
- ✅ 失败隔离：单次 env 构造失败不影响 Platform 进程

### 3.5 SDK API 概览（已实测验证）

```typescript
import {
  query,
  startup,
  tool,
  createSdkMcpServer,
  type Options,
  type SDKMessage,
  type AgentDefinition,
} from '@anthropic-ai/claude-agent-sdk';

// === 1. 基础调用 ===
const q = query({
  prompt: '用户消息',
  options: {
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a helpful assistant...',
    allowedTools: ['Read', 'Edit', 'Bash'],
    tools: [],                                          // 允许 SDK 默认工具集
    env: buildEnv(config),                            // ★ 配置 Provider
    includePartialMessages: true,                      // ★ 开启流式
    maxTurns: 10,
    abortController: new AbortController(),
  } satisfies Options,
});

for await (const msg of q) {
  // msg 是 SDKMessage union 类型
  // 系统消息、assistant 消息、tool_use 消息、result 消息等
}

// === 2. 多轮对话（续接 session） ===
const q2 = query({
  prompt: '继续',
  options: {
    resume: '<上一次的 session_id>',
    env: buildEnv(config),
    includePartialMessages: true,
  },
});

// === 3. 预热：进程启动时调用，减少首响延迟 ===
const warm = await startup({ options: { env: buildEnv(config) } });
// 之后用 warm.query(prompt) 即可，subprocess 已就绪
for await (const msg of warm.query('Hello')) { ... }

// === 4. 自定义工具（v0.2+ 考虑） ===
const myTool = tool(
  'search_db',
  '查询内部数据库',
  { query: z.string() },
  async ({ query }) => {
    return { content: [{ type: 'text', text: `Results: ...` }] };
  },
);
const mcpServer = createSdkMcpServer({
  name: 'desktopwork-internal',
  tools: [myTool],
});
// 传给 query:
options: { mcpServers: { internal: mcpServer } }
```

### 3.6 Anthropic 兼容 Provider

MVP 阶段支持的 Provider 范围：

| Provider | 协议 | 配置示例 | 状态 |
|---------|------|---------|------|
| **Anthropic 官方** | Anthropic Messages | `apiKey: sk-ant-***` | ✅ |
| **AWS Bedrock**（Claude 模型）| Anthropic Messages via Bedrock | `baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com` + AWS 凭据 | ✅（需 Bedrock 配置） |
| **GCP Vertex**（Claude 模型）| Anthropic Messages via Vertex | `CLAUDE_CODE_USE_VERTEX=1` + GCP ADC | ✅ |
| **MiniMax** | Anthropic Messages | `baseUrl: https://api.minimaxi.com/anthropic` | ✅ **2026-06-12 已验证** |
| **GLM / DeepSeek / 自建** | Anthropic Messages（自实现）| 自建端点 URL | ✅（需 Provider 兼容） |
| **LiteLLM 代理** | Anthropic Messages（代理出口）| `baseUrl: http://localhost:4000` | ✅ |
| OpenAI 直连 | OpenAI | ❌ 不支持 | — |
| Ollama / LM Studio | OpenAI / 自定义 | ❌ 不支持 | v0.3+ 考虑 |

**说明**：Claude Agent SDK 只支持 Anthropic 协议（包括第三方兼容实现），不直接支持 OpenAI 协议。如果用户想用 OpenAI 模型，必须在外部跑 LiteLLM 把它转成 Anthropic 协议。

### 3.7 流式输出机制

#### SDK 默认行为 vs 启用流式

| 配置 | 行为 | 适用场景 |
|------|------|---------|
| **默认**（`includePartialMessages: false` 或不设）| 一次性返回完整 assistant message，丢失中间状态 | 短文本、非交互 |
| **`includePartialMessages: true`** | 拿到 `stream_event` 增量事件，含 `content_block_delta` → `text_delta` | **Bot Chat 必备** |

#### stream_event 结构

```typescript
// stream_event 消息
{
  type: 'stream_event',
  event: {
    type: 'content_block_delta',     // 增量类型
    index: 0,
    delta: {
      type: 'text_delta',            // 文本增量
      text: '...'                    // 增量文本
    }
  },
  parent_tool_use_id: null,
  session_id: '...'
}
```

#### 事件转换（SDK → 平台）

```typescript
// src/ai/event-converter.ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStreamEvent } from './types.js';

export function convertSDKMessage(msg: SDKMessage): AgentStreamEvent | null {
  switch (msg.type) {
    case 'stream_event': {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        return { type: 'text_delta', delta: ev.delta.text, contentIndex: ev.index ?? 0 };
      }
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        return { type: 'tool_use_start', id: ev.content_block.id, name: ev.content_block.name };
      }
      return null;
    }
    case 'assistant': {
      // 完整消息（用于持久化与 UI 最终态）
      return { type: 'assistant_message', message: msg.message, sessionId: msg.session_id };
    }
    case 'result': {
      return {
        type: 'session_done',
        sessionId: msg.session_id,
        isError: msg.is_error,
        cost: msg.total_cost_usd,
        turns: msg.num_turns,
        duration: msg.duration_ms,
      };
    }
    case 'system':
    case 'user':
      return null;
    default:
      return null;
  }
}
```

#### 结论

**本项目采用 `includePartialMessages: true` 模式。** 理由与落地如下：

1. **场景需求**：Bot Chat 是核心交互场景，需要"边生成边显示"的流式体验（类似 ChatGPT 的打字机效果）。默认模式（一次性返回完整 assistant message）会阻塞到全部生成完毕，交互感差。

2. **实测验证**（2026-06-12）：开启 `includePartialMessages: true` 后收到 **18 个 events**（system x4 + stream_event x11 + assistant x2 + result x1），11 个 `stream_event` 即为前端可增量渲染的细粒度 token 流。默认模式仅 6 个 events，无中间状态。

3. **落地链路**：
   - **开启位置**：`§5.6.1 AgentService.stream()` 中 `options.includePartialMessages = true`
   - **转换位置**：`§5.6.3 event-converter.ts` 的 `convertSDKMessage()` switch 块（见上）
   - **消费位置**：`§5.6.1 stream()` 内部 `for await (const msg of q)` 后立即 `convertSDKMessage(msg)`，再 `yield` 给上层

4. **前端事件契约**：Bot Chat 前端只需订阅以下 4 类事件（详见 §6.2 SSE 响应格式）：

   | SDK 事件 | 平台事件 | 说明 |
   |---------|---------|------|
   | `stream_event.content_block_delta` (delta.type=text_delta) | `{ type: 'text_delta', delta, contentIndex }` | 文本增量，前端追加到气泡 |
   | `stream_event.content_block_start` (content_block.type=tool_use) | `{ type: 'tool_use_start', id, name }` | 工具调用开始，显示 spinner |
   | `assistant` | `{ type: 'assistant_message', message, sessionId }` | 完整消息（用于持久化与 UI 最终态） |
   | `result` | `{ type: 'session_done', sessionId, isError, cost, turns, duration }` | 整轮结束 |

5. **未选方案**：默认模式（`includePartialMessages: false` 或不设）只适用于"短文本、非交互"场景。**本项目所有交互式场景统一使用流式模式。**

### 3.8 Session 管理

#### 设计决策（v0.2 锁定）

**DesktopWork 平台侧不存任何 session 状态，完整采用 Claude Agent SDK 自带的 session 体系。** 具体含义：

| 项 | 决策 |
|----|------|
| Session 存储 | 完全交给 SDK（存到 `~/.claude/projects/...`）|
| Session 续接 (`resume`) | 走 SDK 原生 `options.resume` |
| 消息历史存储 | **不存**于平台，由 SDK 独占 |
| Session 列表/元信息 | **不存**于平台，调 SDK `listSessions()` 拿 |
| 会话元信息（标题/时间）| SDK `SDKSessionInfo` 自带 `summary` / `lastModified` / `customTitle` |
| 平台侧 session 文件 | **不存在**（v0.1）|
| "当前会话"指针 | 前端 localStorage（v0.1）|
| Session 备份/迁移 | 备份 `~/.claude/` 整个目录即可 |
| 跨平台行为一致性 | ✅ 跟 Claude Code CLI 完全一致（共用同一套存储）|

> **2026-06-12 决策记录（两次修订）**：
> - 修订 1：原 v0.1 中"平台存消息历史"被删除，避免双写一致性问题。
> - 修订 2（本次）：原 v0.2 中"平台存 `sessionKey ↔ sdkSessionId` 映射"也被删除。验证 SDK 提供 `listSessions` / `getSessionInfo` / `getSessionMessages` / `renameSession` / `tagSession` / `deleteSession` / `forkSession` 全部 7 个 session 管理 API，**平台不需要任何持久化**。SDK 为唯一数据源。

#### 核心原则：单一数据源

**所有 session 状态由 SDK 持久化，平台不存任何东西。** 包括：
- 消息历史 → SDK
- Session 元信息（标题/时间/UUID）→ SDK
- 平台自己的"当前会话"指针 → 浏览器 localStorage（不持久化到磁盘）

#### SDK 端（subprocess 内部）

- SDK 内部维护 session 状态（持久化在 `~/.claude/projects/-<encoded-cwd>/`）
- 每次 `query()` 返回的 `result` 消息含 `session_id`（UUID）
- 用 `options.resume: '<session_id>'` 续接多轮对话

**SDK 提供的 Session 管理 API（**已从 `sdk.d.ts` 验证**）**：

| API | 签名（简化）| 作用 |
|-----|-----------|------|
| `listSessions({ dir, limit, offset })` | `→ Promise<SDKSessionInfo[]>` | 列出项目下所有 session |
| `getSessionInfo(sessionId, { dir })` | `→ Promise<SDKSessionInfo \| undefined>` | 单个 session 元信息 |
| `getSessionMessages(sessionId, { dir, limit, offset, includeSystemMessages })` | `→ Promise<SessionMessage[]>` | **读消息历史** |
| `renameSession(sessionId, title, { dir })` | `→ Promise<void>` | 改名（设置 `customTitle`）|
| `tagSession(sessionId, tag, { dir })` | `→ Promise<void>` | 打标签 |
| `deleteSession(sessionId, { dir })` | `→ Promise<void>` | 删除（同步删 SDK 侧 JSONL）|
| `forkSession(sessionId, options)` | `→ Promise<ForkSessionResult>` | 分叉会话 |

**所有 API 的 `{ dir }` 选项语义相同**：项目目录。**不传**则搜索所有项目。**生产环境必须传 `dir: PLATFORM_CWD`**（见 §5.6.1）。

**`SDKSessionInfo` 字段**（SDK 已自带 platform 想要的几乎所有东西）：

```typescript
type SDKSessionInfo = {
  sessionId: string;      // UUID
  summary: string;        // ★ 展示标题：customTitle / 自动摘要 / 第一条 prompt
  lastModified: number;   // ms
  fileSize?: number;      // bytes（仅 local JSONL 存储时填）
  customTitle?: string;   // 用户用 /rename 设的标题
};
```

#### 平台端（不存任何 session 状态）

**平台侧零 session 状态**——不存 session 映射、不存元信息、不存历史。

- v0.1 **不**实现 `SessionStore` 模块
- v0.1 **不**实现 `~/.local/share/desktopwork/sessions.json`
- 平台只负责"转发"：把前端请求转给 SDK，把 SDK 响应转给前端

```typescript
// 平台 Bot Chat routes 里的"读历史"伪代码
app.get('/api/bot-chat/sessions/:id', async (req, res) => {
  const messages = await getSessionMessages(req.params.id, {
    dir: PLATFORM_CWD,  // ★ 必须传：避免 SDK 扫描所有项目
  });
  res.json(messages);
});
```

#### UI 读历史的新流程

```
UI 请求历史 (GET /api/bot-chat/sessions/<sdkSessionId>)
  ↓
平台直接调 SDK getSessionMessages(sdkSessionId, { dir: PLATFORM_CWD })
  ↓
SDK 读自己 ~/.claude/projects/-<encoded-cwd>/<uuid>.jsonl
  → 返回 SessionMessage[]
  ↓
平台原样转发给 UI
```

**没有 platform 中间层**——SDK 响应直接透传。

#### "当前会话"指针：localStorage

前端用浏览器/WebView localStorage 记"当前活跃的 sessionId"：

```javascript
// 前端 5 行代码
const KEY = 'desktopwork.currentSessionId';
let currentSessionId = localStorage.getItem(KEY);

function onSessionDone(newSessionId) {
  currentSessionId = newSessionId;
  localStorage.setItem(KEY, newSessionId);
}
```

**取舍**：
- ✅ 平台零状态，启动/重启行为完全确定
- ✅ 跨设备/清缓存时，用户从列表选一个 session 即可（历史仍在 SDK 侧）
- ⚠️ 清 localStorage 后 "当前 session" 丢失——**历史不丢**（SDK 侧还在）

#### 收益 vs 代价

| 维度 | 平台存状态（旧 v0.2）| 平台不存状态（v0.2 修订）|
|------|------------------|----------------------|
| 平台持久化文件 | `sessions.json` | **0** |
| Session 列表数据源 | 平台 + SDK 两处 | SDK 一处 |
| 平台启动时初始化 | 要读 `sessions.json` | 不用 |
| Session 创建流程 | upsert SDK + 平台 | 纯 SDK |
| Session 删除流程 | 调 SDK + 改平台 | 纯 SDK |
| 改名流程 | 改 customTitle + 同步 | 纯 SDK（`renameSession`）|
| 跨设备/重装行为 | 平台映射丢失 | 仅"当前会话"指针丢失（历史不丢）|
| 扩展性 | 加字段要改平台 + SDK | 加字段直接用 SDK 新 API |

**唯一代价**：前端需要管理 localStorage（5 行代码）。

#### v0.2+ 演进方向

v0.1 不做"会话管理"（置顶/归档/最后访问时间/排序等）。**当 v0.2+ 出现这些需求时**，才引入平台侧 session 状态层：

- 那时的状态层**不是"session 真相"，而是"用户偏好 overlay"**（pin/archived/lastAccessedAt）
- SDK 仍是消息/UUID/标题的真相源
- 两者通过 `sdkSessionId` 关联
- 详见（占位）§3.8.1 v0.2 session overlay 方案

---

## 四、目录结构

### 4.1 项目仓库结构

```
desktopwork/                          # 仓库根
├── docs/                             # 文档
│   ├── product/                      # 产品文档
│   │   └── PRD-DESKTOPWORK.md
│   └── technical/                    # 技术文档
│       └── TECH-DESIGN.md            # 本文件
│
├── src-tauri/                        # Tauri 主进程（Rust + React 前端）
│   ├── src/                          # Rust 源码
│   ├── App/                          # React 前端源码
│   │   ├── pages/                    # 各 App 页面
│   │   ├── components/               # 共享组件
│   │   └── lib/                      # 工具库
│   ├── package.json
│   └── tauri.conf.json
│
├── desktop-agent/                    # Platform 进程（Node.js）★
│   ├── src/                          # 主框架源码
│   │   ├── index.ts                  # 入口（启动 HTTP server + Claude 预热）
│   │   ├── router.ts                 # 路由总入口
│   │   │
│   │   ├── platform/                 # 平台核心模块
│   │   │   ├── app-registry.ts       # App 注册表
│   │   │   ├── config.ts             # 全局配置管理
│   │   │   ├── auth.ts               # 统一认证
│   │   │   ├── storage.ts            # 存储抽象（v0.4+ 替代 fs/promises）
│   │   │   ├── skills.ts             # Skills 加载
│   │   │   ├── paths.ts              # 统一路径解析（dev/prod 一致，详见 §5.8）
│   │   │   ├── ipc.ts                # 与 Tauri 通信
│   │   │   └── types.ts              # 共享类型
│   │   │
│   │   ├── ai/                       # AI 层（Claude Agent SDK 封装）
│   │   │   ├── agent-service.ts      # query() 包装 + env 构造
│   │   │   ├── event-converter.ts    # SDKMessage → 平台事件
│   │   │   ├── startup-warmer.ts     # 预热 subprocess
│   │   │   └── types.ts              # AgentStreamEvent 等
│   │   │   （v0.1 不实现 session-store.ts：见 §3.8）
│   │   │
│   │   └── apps/                     # 各 App 后端代码
│   │       ├── bot-chat/
│   │       │   ├── routes.ts
│   │       │   └── service.ts
│   │       └── settings/
│   │           ├── routes.ts
│   │           └── service.ts
│   │
│   ├── apps/                         # 各 App 前端静态文件
│   │   ├── _shared/
│   │   ├── bot-chat/
│   │   └── settings/
│   │
│   ├── package.json                  # 包含 @anthropic-ai/claude-agent-sdk
│   └── tsconfig.json
│
├── .github/workflows/build.yml
├── package.json                      # pnpm workspace root
├── pnpm-workspace.yaml
└── README.md
```

### 4.2 运行时用户数据目录

```
~/.config/desktopwork/                # 配置
├── config.json                       # 主配置（含 ANTHROPIC_BASE_URL/AUTH_TOKEN）
├── skills/                           # 用户级 Skills
└── apps/                             # 用户安装的 App（v0.5+）

~/.local/share/desktopwork/           # 数据
├── memory/                           # 知识库（v0.4+）
├── app-data/                         # 各 App 状态数据
└── logs/
    ├── desktop-agent.log
    └── claude-subprocess.log         # Claude subprocess 独立日志

~/.claude/projects/-<encoded-cwd>/    # SDK 侧 Session 历史（详见 §3.8，不复制）
└── <session-uuid>.jsonl
```

**两层分工**（v0.1）：
- `~/.config/desktopwork/`：用户配置
- `~/.claude/projects/...`：SDK 侧 session 全部状态（消息、UUID、标题、修改时间等）
- **平台侧 `~/.local/share/desktopwork/` 在 v0.1 不存 session 相关数据**（除 logs 与未来 App 数据外）

> v0.2+ 若引入"置顶/归档/最后访问"等用户偏好，会在 `~/.local/share/desktopwork/session-overlay.json` 增加一层。详见 §3.8 末尾。

---

## 五、核心模块设计

### 5.1 入口与路由（`src/index.ts` + `src/router.ts`）

```typescript
// src/index.ts
import { createRouter } from './router.js';
import { prewarmClaude } from './ai/startup-warmer.js';
import { loadConfig } from './platform/config.js';

const PORT = parseInt(process.env.PORT || '3737');
const HOST = process.env.HOST || '0.0.0.0';

const app = createRouter();
const server = app.listen(PORT, HOST, () => {
  console.log(`DesktopWork Platform running on http://localhost:${PORT}`);
});

// 异步预热 Claude subprocess（不等完成）
prewarmClaude(loadConfig()).catch((e) => {
  console.error('[claude] prewarm failed (will retry on first query):', e.message);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
```

**路由结构保持不变**：

```
/api/platform/*       — 平台 API
  /api/platform/config   (v0.1 实现)
  /api/platform/memory   (v0.1 仅返 501 Not Implemented)
  /api/platform/skills   (v0.1 仅返 501 Not Implemented)
  /api/platform/apps     (v0.1 实现：返已注册 App 列表)

/api/:appId/*         — 各 App API
  /api/bot-chat/chat
  /api/bot-chat/sessions

/apps/:appId/         — 各 App 前端
```

### 5.2 App 注册表（`src/platform/app-registry.ts`）

**无变化**——保持原设计。App 是 Platform 的扩展点，AI 层变更不影响它。

### 5.3 配置管理（`src/platform/config.ts`）

#### 职责

- 从 `~/.config/desktopwork/config.json` 加载配置
- **不**在内存中缓存——每次读取（per-request），保证热更新生效
- 提供 `get()` 接口
- 写回磁盘

#### 配置结构

```typescript
interface DesktopWorkConfig {
  agent: {                                  // ★ 重命名为 agent（不叫 llm）
    provider: 'anthropic' | 'custom';       // 协议标识
    model: string;                          // 模型 ID
    apiKey: string;                         // ⚠️ MVP 阶段明文（v0.2 加密）
    baseUrl?: string;                       // 自定义 Provider 端点
  };
  system: {
    port: number;
    host: string;
    dataDir: string;
    autoStart: boolean;
  };
  enabledSkills: string[];
  enabledApps: string[];
}
```

#### 配置 → env 映射（在 AI 层做）

```typescript
// src/ai/agent-service.ts
export function buildEnv(cfg: DesktopWorkConfig): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: cfg.agent.baseUrl,
    ANTHROPIC_AUTH_TOKEN: ***
    CLAUDE_AGENT_SDK_CLIENT_APP: 'desktopwork/0.1.0',
  };
}
```

#### 配置热更新验证

**实测结果**（2026-06-12）：修改 config.json 后，下一次 `query()` 调用**立即**使用新配置。**不需要重启 Platform 进程。**

### 5.4 认证（`src/platform/auth.ts`）

**实现**：HMAC-SHA256 简化 token 方案。

**登录流程**：
1. 客户端 POST `/auth/login` → `{ "username": "admin", "password": "***" }`
2. 服务端验证 `PLATFORM_ADMIN_PASSWORD`（环境变量或配置文件）
3. 返回 `{ "token": "***" }`
4. 后续所有请求带 `X-Desktop-Work-Token: <token>` 头

**安全说明**：
- token 本质是 HMAC-SHA256(password, timestamp)，非 JWT
- 仅限本地端口访问（127.0.0.1），攻击面极小
- v0.2 可升级为 proper JWT + keytar 加密存储

### 5.5 存储（`src/platform/storage.ts`）

**无变化**。MVP 用 `node:fs/promises`，后续替换为 SQLite/向量数据库。

### 5.6 AI 层（Claude Agent SDK 封装）

#### 5.6.1 AgentService（`src/ai/agent-service.ts`）

```typescript
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { convertSDKMessage } from './event-converter.js';
import { getAppDataDir } from '../platform/paths.js';
import type { AgentStreamEvent, AgentMessage } from './types.js';

// ★ 统一路径（dev/prod 一致）：详见 §5.8
const APP_DATA = getAppDataDir();   // Tauri 启动时设 PLATFORM_APP_DATA 环境变量；未设则用 XDG fallback
const CONFIG_PATH = join(APP_DATA, 'config', 'desktopwork', 'config.json');

/**
 * 统一的平台 cwd：SDK subprocess 启动 + session 查询都使用这个路径
 * 保证 session 全部存到 `~/.claude/projects/-<encoded-runtime>/` 下
 * （详见 §9.4 跨平台编码）
 */
export const PLATFORM_CWD = join(APP_DATA, 'data', 'desktopwork', 'runtime');

export interface AgentCallOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  abortSignal?: AbortSignal;
}

export class AgentService {
  /** 流式调用 Agent */
  async *stream(opts: AgentCallOptions): AsyncGenerator<AgentStreamEvent> {
    // 每次调用都读最新 config（热更新）
    const cfg = await this.loadConfig();
    const env = this.buildEnv(cfg);

    const options: Options = {
      model: cfg.agent.model,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools ?? ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
      tools: [],
      resume: opts.sessionId,
      includePartialMessages: true,    // ★ 开启流式（见 §3.7 结论）
      cwd: PLATFORM_CWD,               // ★ session 存储 cwd（与 §6.2 SDK 调用 dir 一致）
      maxTurns: 20,
      env,
      abortController: opts.abortSignal ? this.toAbortController(opts.abortSignal) : undefined,
    };

    const q = query({ prompt: opts.prompt, options });

    for await (const msg of q) {
      const event = convertSDKMessage(msg);
      if (event) yield event;
    }
  }

  /** 非流式调用 */
  async call(opts: AgentCallOptions): Promise<AgentMessage> {
    let last: AgentMessage | null = null;
    for await (const event of this.stream(opts)) {
      if (event.type === 'assistant_message') {
        last = event.message;
      }
    }
    if (!last) throw new Error('No assistant message received');
    return last;
  }

  private async loadConfig() {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as DesktopWorkConfig;
  }

  private buildEnv(cfg: DesktopWorkConfig) {
    return {
      ...process.env,
      ANTHROPIC_BASE_URL: cfg.agent.baseUrl,
      ANTHROPIC_AUTH_TOKEN: ***
      CLAUDE_AGENT_SDK_CLIENT_APP: 'desktopwork/0.1.0',
      DISABLE_TELEMETRY: '1',
    };
  }

  private toAbortController(signal: AbortSignal): AbortController {
    const c = new AbortController();
    signal.addEventListener('abort', () => c.abort());
    return c;
  }
}
```

#### 5.6.2 StartupWarmer（`src/ai/startup-warmer.ts`）

**解决**：subprocess 启动开销（~2s 首次 query）影响首响。

```typescript
import { startup, type WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import type { DesktopWorkConfig } from '../platform/types.js';
import { buildEnv, PLATFORM_CWD } from './agent-service.js';

let warm: WarmQuery | null = null;

export async function prewarmClaude(cfg: DesktopWorkConfig): Promise<void> {
  if (warm) return;
  warm = await startup({
    options: {
      env: buildEnv(cfg),
      cwd: PLATFORM_CWD,  // ★ 与 query() 的 cwd 一致（详见 §3.8）
    },
    initializeTimeoutMs: 30_000,
  });
  console.log('[claude] subprocess prewarmed');
}

export function getWarmQuery(): WarmQuery | null {
  return warm;
}

export async function invalidateWarmQuery(): Promise<void> {
  if (warm) {
    // WarmQuery may not have explicit close; depend on GC
    warm = null;
  }
}
```

**AgentService 使用 warm query 的策略**：

```typescript
async *stream(opts) {
  const cfg = await this.loadConfig();
  const env = this.buildEnv(cfg);
  const warm = getWarmQuery();

  // 优先用预热的 query（避免重启 subprocess）
  const iterator = warm
    ? warm.query(opts.prompt)              // WarmQuery 也有 .query() 方法
    : query({ prompt: opts.prompt, options: { env, ... } });

  for await (const msg of iterator) {
    yield convertSDKMessage(msg);
  }
}
```

**失效时机**（待设计）：
- env 变化（baseUrl/apiKey 改了）→ 旧的 subprocess 仍持有旧 env，必须重启
- 简化策略：v0.1 每次 `loadConfig()` 后 hash 一下 env，变化则 invalidate warm

#### 5.6.3 EventConverter（`src/ai/event-converter.ts`）

见 §3.7 的代码示例。

#### 5.6.4 统一事件类型

```typescript
// src/ai/types.ts
export type AgentStreamEvent =
  | { type: 'text_delta'; delta: string; contentIndex: number }
  | { type: 'tool_use_start'; id: string; name: string; args?: unknown }
  | { type: 'tool_use_delta'; id: string; argsDelta: string }
  | { type: 'tool_result'; id: string; result: unknown; isError?: boolean }
  | { type: 'assistant_message'; message: AgentMessage; sessionId: string }
  | { type: 'session_done'; sessionId: string; isError: boolean; cost?: number; turns?: number; duration?: number };
```

### 5.7 Skills 系统

**MVP 简化**：Skills 由 Claude Agent SDK 内置（`allowedTools` + `tools: []`）。

**v0.2+ 扩展**：用 SDK 的 `tool()` + `createSdkMcpServer()` 加载自定义 MCP 工具：

```typescript
// v0.2+ 草稿
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const searchKb = tool(
  'search_kb',
  '在知识库中搜索',
  { query: z.string().describe('搜索关键词') },
  async ({ query }) => {
    // 调用 KB
    return { content: [{ type: 'text', text: '搜索结果: ...' }] };
  },
);

const desktopMcp = createSdkMcpServer({
  name: 'desktopwork-tools',
  version: '0.1.0',
  tools: [searchKb],
});

// 传给 query
options: { mcpServers: { desktop: desktopMcp } }
```

详见：PRD-SKILLS.md

---

### 5.8 路径解析（`src/platform/paths.ts`）

**唯一性原则**：dev 和 prod 走同一条路径逻辑（遵循 §9.0 P3 原则）。

**实现策略**：通过环境变量 `PLATFORM_APP_DATA` 区分：
- **Prod**：Tauri spawn Node 时设 `PLATFORM_APP_DATA=app_data_dir`
- **Dev**：未设环境变量 → fallback 到 OS 标准的 `~/.local/share/desktopwork` 风格路径

```typescript
// src/platform/paths.ts
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * dev/prod 统一的 app data 根目录。
 * - Prod：Tauri 进程启动 Node 时设 PLATFORM_APP_DATA 环境变量
 * - Dev：未设变量 → 按 OS 选择标准 XDG/AppData 路径
 *
 * 这保证了 §9.0 P3 原则：dev 和 prod 走同一条路径逻辑。
 */
export function getAppDataDir(): string {
  if (process.env.PLATFORM_APP_DATA) {
    return process.env.PLATFORM_APP_DATA;
  }
  // Dev fallback
  switch (platform()) {
    case 'darwin':  return join(homedir(), 'Library', 'Application Support', 'desktopwork');
    case 'win32':   return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'desktopwork');
    default:        return join(homedir(), '.local', 'share', 'desktopwork');
  }
}

export const APP_DATA_DIR = getAppDataDir();
export const CONFIG_DIR   = join(APP_DATA_DIR, 'config', 'desktopwork');
export const RUNTIME_DIR  = join(APP_DATA_DIR, 'data', 'desktopwork', 'runtime');
export const LOG_DIR      = join(APP_DATA_DIR, 'logs');
export const CONFIG_PATH  = join(CONFIG_DIR, 'config.json');
```

**跨平台路径对照**（dev / prod 完全一致）：

| 平台 | APP_DATA_DIR |
|------|-------------|
| Linux | `~/.local/share/desktopwork/` |
| macOS | `~/Library/Application Support/desktopwork/` |
| Windows | `%APPDATA%\desktopwork\` |

**subdirectory**（dev / prod 完全一致）：

| 子目录 | 用途 |
|--------|------|
| `config/desktopwork/config.json` | 用户配置（LLM API key / baseUrl）|
| `data/desktopwork/runtime/` | PLATFORM_CWD（SDK session 存储目录）|
| `logs/desktop-agent.log` | Platform 进程日志 |

> **重要**：此模块**仅被 Node 进程**使用。Tauri 侧路径（资源、log）继续用 Tauri Path API（见 §9.4）。两边**互不干扰**——Tauri 不读 `app_data_dir`，Node 不读 `resourcesPath`。

---

## 六、API 设计

### 6.1 Platform API

| Method | Path | 描述 |
|--------|------|------|
| GET | `/api/platform/config` | 读取全局配置 |
| PUT | `/api/platform/config` | 更新全局配置（部分字段） |
| GET | `/api/platform/apps` | 列出所有 App |
| GET | `/api/platform/apps/:id` | 获取 App 详情 |
| GET | `/api/platform/skills` | ⚠️ v0.1 返 501；v0.2+ 启用 MCP 工具集 |
| PUT | `/api/platform/skills/:id` | ⚠️ v0.1 返 501 |
| GET | `/api/platform/memory` | ⚠️ v0.1 返 501；v0.4+ 引入知识库 |
| GET | `/api/platform/health` | 健康检查（含 Claude subprocess 状态） |
| POST | `/auth/login` | 登录（获取 token） |

### 6.2 Bot Chat API（MVP 核心）

| Method | Path | 描述 |
|--------|------|------|
| POST | `/api/bot-chat/chat` | 发送消息（支持流式 SSE 响应） |
| GET | `/api/bot-chat/sessions` | 列出所有会话（调 SDK `listSessions`）|
| GET | `/api/bot-chat/sessions/:sdkSessionId` | 获取会话历史（调 SDK `getSessionMessages`）|
| DELETE | `/api/bot-chat/sessions/:sdkSessionId` | 删除会话（调 SDK `deleteSession`）|
| PUT | `/api/bot-chat/sessions/:sdkSessionId` | 重命名会话（调 SDK `renameSession`）|

> **会话标识符直接用 SDK UUID**（如 `c4d2df1a-01fd-4ef9-b5e1-8042816cb95a`）。无 platform-side 映射层（详见 §3.8 决策）。
> **前端"当前活跃会话"指针**用 `localStorage` 存。详见 §3.8。

#### POST /api/bot-chat/chat

**Request：**
```json
{
  "message": "你好",
  "sessionId": "c4d2df1a-01fd-4ef9-b5e1-8042816cb95a",
  "stream": true
}
```

**说明**：`sessionId` 可选，**不传 = 新会话**（SDK 自动生成 UUID）。
**续接**：传 `sessionId`（从 localStorage 或列表点击拿到）→ SDK `resume`。


**Response（stream=true, SSE）：**
```
data: {"type":"text_delta","delta":"你好"}
data: {"type":"text_delta","delta":"！"}
data: {"type":"tool_use_start","id":"toolu_01","name":"Read","args":{...}}
data: {"type":"tool_result","id":"toolu_01","result":{...}}
data: {"type":"assistant_message","message":{...},"sessionId":"c4d2df1a-..."}
data: {"type":"session_done","sessionId":"c4d2df1a-...","cost":0.002402,"turns":1}
```

**Response（stream=false）：**
```json
{
  "content": "你好！",
  "sessionId": "c4d2df1a-...",
  "usage": { "inputTokens": 10, "outputTokens": 5, "cost": 0.0001 }
}
```

### 6.3 与 Tauri 的 IPC

**无变化**——Tauri 通过 HTTP 调用 Platform API。

---

## 七、依赖与版本

### 7.1 desktop-agent 依赖

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.174",
    "express": "^4.21.x",
    "cors": "^2.8.x",
    "zod": "^3.23.x"
  },
  "devDependencies": {
    "@types/express": "^5.x.x",
    "@types/cors": "^2.x.x",
    "tsx": "^4.x.x",
    "typescript": "^5.x.x"
  }
}
```

**注意**：`@anthropic-ai/claude-agent-sdk-darwin-arm64` 等平台 binary 包作为 **optional dependencies** 由 SDK 自动管理，无需手动列在 package.json。

### 7.2 关键依赖说明

| 包 | 作用 | 选型理由 |
|----|------|---------|
| `@anthropic-ai/claude-agent-sdk` | AI Agent SDK | 完整 Agent 能力 + 内置工具 + Session + 流式 |
| `express` | HTTP 框架 | 轻量、Node.js 首选 |
| `cors` | CORS 中间件 | Tauri WebView 跨域 |
| `zod` | Schema 验证 | 自定义 tool 的 input schema（v0.2+） |

### 7.3 未来可选依赖

| 包 | 作用 | 引入时机 |
|----|------|---------|
| `better-sqlite3` | 高性能本地数据库 | v0.4+（知识库、向量检索） |
| `lancedb` 或 `chromadb` | 向量数据库 | v0.4+（Memory 检索） |
| `electron-store` 或 `keytar` | 加密本地存储 | v0.2+（加密 API Key） |

---

## 八、数据流（Bot Chat 场景）

### 8.1 用户发送消息

```
┌─────────────────────────────────────────────────────────────────┐
│  1. 用户在 Tauri React 前端输入消息                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. React fetch POST http://localhost:3737/api/bot-chat/chat     │
│     Headers: X-Desktop-Work-Token, Content-Type: application/json│
│     Body: { message, sessionId?: "<uuid>", stream: true }        │
│     （sessionId 从 localStorage 拿；首次 = 不传 = 新会话）        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Express 接收请求                                              │
│     - Auth 中间件校验 token                                      │
│     - 路由到 bot-chat routes                                    │
│     - sessionId 直接透传给 AgentService（无需查询映射）           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Bot Chat service 调用 AgentService                          │
│     - loadConfig() 读最新 config.json                            │
│     - buildEnv() 构造 env 对象                                   │
│     - 调用 agentService.stream({                                │
│         prompt,                                                  │
│         sessionId: req.sessionId,  // 直传：undefined 或 UUID    │
│         env, ...                                                 │
│       })                                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. AgentService 调用 Claude Agent SDK                           │
│     query({ prompt, options: { model, env, resume, ... } })     │
│     ↓                                                            │
│     SDK 内部：                                                    │
│     ├─ 检查 warmQuery（预热的 subprocess）                       │
│     ├─ 复用 / 新建 Claude Code subprocess                        │
│     ├─ 构造 stdio JSON-RPC 请求                                  │
│     └─ 异步迭代返回 SDKMessage 流                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. event-converter 转换 SDKMessage → AgentStreamEvent          │
│     - stream_event → text_delta / tool_use_*                    │
│     - assistant → assistant_message                              │
│     - result → session_done                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (SSE stream)
┌─────────────────────────────────────────────────────────────────┐
│  7. Express 将 AgentStreamEvent 转发为 SSE                       │
│     for await (event of agentService.stream()) {                │
│       res.write(`data: ${JSON.stringify(event)}\n\n`);           │
│     }                                                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  8. Claude Code Subprocess（独立进程）                           │
│     - 内部维护 Agent Loop（推理 + tool 调度）                    │
│     - 调用 LLM Provider（ANTHROPIC_BASE_URL 配置）              │
│     - 执行 tool（Read、Edit、Bash 等内置工具）                   │
│     - 通过 stdio 返回 SDKMessage 流给 Platform 进程              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  9. LLM Provider（用户配置的 Anthropic 兼容服务）                 │
│     返回 text_delta 流                                          │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 错误处理

| 错误位置 | 处理方式 |
|---------|---------|
| Auth 失败 | 返回 401，前端跳转到配置页 |
| config.json 损坏 | 返回 500 + 错误详情，前端展示重置配置引导 |
| LLM API 错误 | SDK 返回 `result.is_error: true`，转换为 `session_done` 事件 |
| Tool 执行失败 | SDK 自动处理（重试或返回 error），转换后透传给前端 |
| 流式中断 | 客户端 EventSource 断连，server 端 `abortController.abort()` 终止 SDK |
| Subprocess 崩溃 | SDK 内部会 emit 错误事件；`startup-warmer` 自动重新预热 |

### 8.3 多轮对话流程

```
[用户发送消息1] → POST /api/bot-chat/chat { message, sessionId: undefined }
                              ↓
              [AgentService.stream()] — 读 config，构造 env
                              ↓
              [Claude SDK query() — 不传 resume = 新 session]
                              ↓
              SDK 返回 result.session_id = "c4d2df1a-..."
                              ↓
              前端收到 session_done → localStorage.setItem("desktopwork.currentSessionId", "c4d2df1a-...")

[用户发送消息2] → POST /api/bot-chat/chat { message, sessionId: "c4d2df1a-..." }
                              ↓
              [AgentService.stream({ sessionId: "c4d2df1a-..." })]
                              ↓
              [Claude SDK query({ options: { resume: "c4d2df1a-..." } })]
                              ↓
              SDK 内部从 ~/.claude/projects/-<encoded-cwd>/<uuid>.jsonl 加载历史上下文，继续对话
```

---

## 九、打包与分发

### 9.0 打包设计原则

> **背景**：DesktopWork v0.1 曾在本地测试正常、打包后出现三类问题：
> 1. 内容没打包进去 → 依赖找不到 / 进程起不来
> 2. 打包路径 vs 运行路径不一致 → 启动失败或找不到资源
> 3. Tauri ↔ Node 层连接断裂 → 界面报找不到页面
>
> 本章针对这三类问题给出明确设计决策。

**三条核心原则**：

| # | 原则 | 具体含义 |
|---|------|---------|
| P1 | **资源只读，运行时只写** | Tauri bundle 内的文件（resourcesPath）永远只读；可写数据（配置、日志、session）全部写进 app_data_dir |
| P2 | **Node 是 Tauri 的 subprocess，不是平级进程** | Tauri 主进程负责 spawn Node、监控 Node、清理 Node；Node 生命周期由 Tauri 管理 |
| P3 | **dev 和 prod 走同一条路径** | 所有路径通过 Tauri path API 计算，开发时和打包后使用同一套逻辑，不允许 hardcode |

---

### 9.1 资源架构总览

打包后 Tauri Bundle 内有两类资源：

```
tauri.conf.json  bundle.resources / bundle.externalBin
─────────────────────────────────────────────────────────────────

【资源层 — 只读，来自 bundle】

1. server/                         ← node_modules + dist + package.json
   ├── dist/
   │   └── index.js               ← TS 编译产物
   ├── node_modules/ ← production-only deps
   │   ├── @anthropic-ai/
   │   │   ├── claude-agent-sdk/
   │   │   └── claude-agent-sdk-linux-x64/
   │   │       └── claude         ← ~4.7MB Claude Code 子进程
   │   ├── express/
   │   ├── cors/
   │   └── ...（prod-only）
   └── package.json

2. apps/                          ← 前端静态文件（Express 静态服务）
   ├── bot-chat/
   │   └── index.html
   ├── settings/
   │   └── index.html
   └── workbench/
       └── index.html


【运行时 — 可写，Tauri app_data_dir】

~/.local/share/desktopwork/       ← Linux/macOS
%APPDATA%/desktopwork/            ← Windows

├── config/
│   └── desktopwork/
│       └── config.json           ← 用户配置的 LLM API key / baseUrl
├── data/
│   └── desktopwork/
│       └── runtime/              ← PLATFORM_CWD（SDK session 存储位置）
│
└── logs/
    ├── desktop-agent.log         ← Platform进程 stdout/stderr
    └── claude-subprocess.log     ← Claude Code 子进程日志
```

> **SDK session 数据去哪了**：SDK自己的 session 文件存在 `~/.claude/projects/-<encoded-app-data-dir>/`。这是 Claude Code 的设计，不是我们平台存的。平台唯一管理的可写目录是 `app_data_dir`。

---

### 9.2 tauri.conf.json 关键配置

```json
// shell/src-tauri/tauri.conf.json（节选）

{
  "productName": "DesktopWork",
  "version": "0.1.0",
  "identifier": "ai.desktopwork.app",

  "app": {
    "windows": [{
      "title": "DesktopWork",
      "width": 1200,
      "height": 800,
      "resizable": true,
      "fullscreen": false,
      "url": "http://127.0.0.1:3737/" // ★ 入口走 Express，不走 tauri://
    }],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://127.0.0.1:3737 http://localhost:3737"
    }
  },

  "bundle": {
    "resources": {
      "../../desktop-agent/dist": "server/dist",
      "../../desktop-agent/node_modules": "server/node_modules",
      "../../desktop-agent/package.json": "server/package.json",
      "../../desktop-agent/apps": "apps"
    },
    "externalBin": [
      // Node.js sidecar：平台二进制，不依赖用户机器上的 Node
      "../../node-binaries/node-linux-x64",
      "../../node-binaries/node-darwin-arm64",
      "../../node-binaries/node-darwin-x64",
      "../../node-binaries/node-windows-x64.exe"
    ],
    "targets": ["nsis", "dmg"], // v0.1 只做 Windows NSIS + macOS DMG
    "category": "DeveloperTool",
    "shortDescription": "Local AI coding assistant",
    "longDescription": "..."
  },

  "process": {
    // sidecar Node 由 Tauri 主进程通过 sidecar API 管理
    "sidecar": [{
      "name": "desktop-agent",
      "path": "node-linux-x64", // resolved by Tauri at runtime
      "args": ["server/dist/index.js"],
      "scope": {
        "workingDir": null
      }
    }]
  }
}
```

**关键字段说明**：

| 字段 | 作用 | 注意事项 |
|------|------|---------|
| `app.windows[0].url` | WebView 入口 | **必须**是 `http://127.0.0.1:3737/`，不是 `tauri://`；Tauri 启动时 Node 必须先 ready |
| `bundle.resources` | 打包时拷贝到 bundle 的文件 | 路径相对于 `src-tauri/`（或 `shell/src-tauri/`）；`../../` 指向 workspace根目录 |
| `bundle.externalBin` | Tauri sidecar 二进制 | Node.js 自身；平台相关；打包时按 target platform 选对应 binary |
| `app.security.csp` | 允许 WebView 请求 localhost:3737 | 必须加 `connect-src` 否则 fetch 被 CSP拦 |
| `process.sidecar` | Tauri 管理的 subprocess | v0.2 可选；v0.1 可能用 Rust 手写 spawn（见 §9.5）|

---

### 9.3 平台 Node.js 嵌入策略

**问题**：用户机器上没有 Node.js 怎么打包？

**决策**：**Tauri sidecar** — Node.js 二进制作为 Tauri bundle 的一部分。

#### 9.3.1 Node.js 二进制来源

**GitHub 上主流的 3 种方案**：

| 方案 | Repo 体积 | 离线可用 | 升级成本 | 适合场景 |
|------|----------|---------|---------|---------|
| **A. Check-in 到仓库** | +120MB | ✅ 完全 | 手动 PR 替换 4 个 binary | 内部工具、固定版本 |
| **B. CI 动态下载 + cache** | 0 | ❌ 首次要网络 | 改一行版本号 | 公开项目、活跃迭代 |
| **C. GitHub Releases + gh CLI** | 0 | ✅ 永久 | 重发 release | 跨项目共享、多版本管理 |

**推荐方案：B（CI 动态下载 + GitHub Actions cache）**。

理由：
- 仓库零膨胀（120MB 不进 git）
- 升级简单（改版本号变量）
- cache 命中后 build 几秒跳过下载
- 锁定的版本号可重现（即使 nodejs.org 改 URL，老版本仍能下到）

**实现代码**：

```yaml
- name: Setup Node.js binary
  id: setup-node
  uses: actions/cache@v4
  with:
    path: |
      node-binaries/node-linux-x64
      node-binaries/node-darwin-x64
      node-binaries/node-darwin-arm64
      node-binaries/node-windows-x64.exe
    key: node-v22.3.0-${{ matrix.platform }}
    restore-keys: |
      node-v22-       # 小版本升级复用 cache

- name: Download Node binary
  if: steps.setup-node.outputs.cache-hit != 'true'
  shell: bash
  run: |
    PLATFORM="${{ matrix.platform }}"
    case "$PLATFORM" in
      linux-x64)    TARBALL="node-v22.3.0-linux-x64" ;;
      darwin-x64)   TARBALL="node-v22.3.0-darwin-x64" ;;
      darwin-arm64) TARBALL="node-v22.3.0-darwin-arm64" ;;
      windows-x64)  TARBALL="node-v22.3.0-win-x64" ;;
    esac
    mkdir -p node-binaries
    curl -L "https://nodejs.org/dist/v22.3.0/${TARBALL}.tar.xz" -o /tmp/node.tar.xz
    tar -xJf /tmp/node.tar.xz -C /tmp
    if [[ "$PLATFORM" == windows-* ]]; then
      mv "/tmp/${TARBALL}/node.exe" "node-binaries/node-${PLATFORM}.exe"
    else
      mv "/tmp/${TARBALL}/bin/node" "node-binaries/node-${PLATFORM}"
      chmod +x "node-binaries/node-${PLATFORM}"
    fi
```

#### 9.3.1.1 Dev 模式怎么处理 Node

**Dev 不需要 sidecar binary**——开发者用自己机器上的 Node。

项目根目录加一个 ensure-node 脚本：

```bash
#!/bin/bash
# desktop-agent/scripts/ensure-node.sh
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//')
if [ -z "$NODE_VERSION" ]; then
  echo "❌ Node.js not found. Install:"
  echo "  brew install node@22   # macOS"
  echo "  winget install node   # Windows"
  echo "  https://nodejs.org    # Linux"
  exit 1
fi
REQUIRED_MAJOR=22
ACTUAL_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$ACTUAL_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  echo "❌ Node $NODE_VERSION < required v$REQUIRED_MAJOR"
  exit 1
fi
echo "✅ Node $NODE_VERSION"
```

```json
// desktop-agent/package.json
{
  "scripts": {
    "predev": "bash scripts/ensure-node.sh",
    "dev": "tsx watch src/index.ts"
  }
}
```

**Dev vs Prod Node 来源对比**：

| 模式 | Node 哪里来 | 路径 |
|------|----------|------|
| Dev | 开发者本机 `node` PATH | 系统 $PATH |
| Prod (Tauri 打包后) | bundle `resources/` 里的 sidecar binary | Tauri path API 解析 |

#### 9.3.2 资源拷贝 CI流程

**Node binary 在上一个 step 已经 cache/下载好**（见 §9.3.1）。现在只负责拷贝。

```yaml
- name: Build desktop-agent
  run: |
    cd desktop-agent
    pnpm install --ignore-scripts   # ★不跑 SDK postinstall（CI 可能没网）
    pnpm run build                    # TS → JS
    pnpm deploy prod --out ../shell/src-tauri/server/node_modules

- name: Prepare bundle resources
  run: |
    # desktop-agent dist → shell/src-tauri/server/
    cp -r desktop-agent/dist    shell/src-tauri/server/
    cp   desktop-agent/package.json shell/src-tauri/server/

    # 前端静态文件 → shell/src-tauri/apps/
    cp -r desktop-agent/apps    shell/src-tauri/

    # Node sidecar binary → shell/src-tauri/
    cp   node-binaries/node-${{ matrix.platform }} \
         shell/src-tauri/node-${{ matrix.platform }}
    # Windows 上需要 .exe 后缀
    [[ "${{ matrix.platform }}" == windows-* ]] && \
      mv shell/src-tauri/node-${{ matrix.platform }} \
         shell/src-tauri/node-${{ matrix.platform }}.exe || true

- name: Build Tauri
  uses: tauri-apps/tauri-action@v0
  env:
    NODE_SIDECAR_BINARY: shell/src-tauri/node-${{ matrix.platform }}
```

**关于 `--ignore-scripts`**：SDK 的 postinstall 已在**开发机**上执行过（`claude` binary 下载到 `node_modules/@anthropic-ai/claude-agent-sdk-*/`）。打包时不需要重跑（且 CI 可能没网）。

#### 9.3.3 生产 node_modules 筛选策略

**❌ 不要**：直接 `cp -r desktop-agent/node_modules/`（会带入 devDependencies、.map、.ts 源码）
**✅ 应该**：

```bash
# 在 desktop-agent/ 中
pnpm deploy prod --out server/node_modules
```

`pnpm deploy` 是 pnpm 内置的打包工具，只拷贝 production 必需的文件和目录结构，自动去掉：
- `.git/`, `.github/`, `*.md`, `*.map`
- `devDependencies`
- TypeScript 源码（`.ts`，除非 `preserveModules`）

> **验证**：打包前在开发机跑一次 `pnpm deploy`，确认 `server/node_modules` 大小在30-50MB 范围内。

---

### 9.4 运行时路径与 Tauri Path API

所有路径通过 Tauri 2 的 path API 计算，**禁止 hardcode**。

#### 9.4.1 路径分类

| 路径 | Tauri API | 说明 |
|------|---------|------|
|资源根目录（只读）| `path().resource_dir()` | bundle 内文件；**不写** |
| 应用数据目录（可写）| `path().app_data_dir()` | config.json、runtime、logs |
| 临时目录 | `path().app_cache_dir()` | 临时文件 |
| 日志文件 | `path().app_log_dir()` | desktop-agent.log |

#### 9.4.2 路径计算规则（TypeScript）

```typescript
// src/platform/paths.ts （Tauri 侧，仅 Rust 主进程使用）
// Node 进程使用 src/platform/paths.ts（见 §5.8），不走 Tauri API

// Tauri 侧仅用 Path API 计算 Tauri 自己需要的路径
// 然后在 spawn Node 时通过 PLATFORM_APP_DATA 环境变量传给 Node
import { app, path } from '@tauri-apps/api';

export async function getTauriPaths() {
  const resourceDir = await path().resourceDir();     // bundle 内文件（只读）
  const appDataDir  = await path().appDataDir();      // 可写 app data
  const logDir     = await path().appLogDir();        // 日志

  return {
    // 资源路径（只读，Tauri 侧）
    resourceDir,
    serverDir:  join(resourceDir, 'server'),
    appsDir:    join(resourceDir, 'apps'),

    // ★传给 Node 的 app data 路径（与 §5.8 dev fallback 路径一致）
    appDataDir,

    logDir,
    logFile:    join(logDir, 'desktop-agent.log'),
  };
}
```

**传给 Node 进程**：
```rust
// shell/src-tauri/src/main.rs (续)
.env("PLATFORM_APP_DATA", &app_data_dir)   // ★ Node 侧用这个 env 定位 config/runtime/logs
```

**Node 侧**（见 §5.8）读取 `process.env.PLATFORM_APP_DATA`，dev 模式 fallback 到 XDG 风格。

```

>**⚠️ 重要**：`PLATFORM_CWD`（SDK 的 `cwd` 参数）必须指向 `app_data_dir` 下的 runtime 目录，**不是** `~/.claude/`。否则跨平台 session 文件散落不受控。

#### 9.4.3 Windows路径处理

| 平台 | app_data_dir 示例 | SDK cwd 编码 |
|------|-----------------|------------|
| Linux | `~/.local/share/ai.desktopwork.app/` | `/home/username/.local/share/ai.desktopwork.app` |
| macOS | `~/Library/Application Support/ai.desktopwork.app/` | `/Users/username/Library/Application Support/ai.desktopwork.app` |
| Windows | `%APPDATA%\ai.desktopwork.app\` | `C:\Users\username\AppData\Roaming\ai.desktopwork.app` |

SDK 内部会对 `cwd` 参数进行路径编码（`/` → `-`）。Linux 上**实测**编码为 `-home-username-.local-share-ai.desktopwork.app`。Windows编码规则待在实际 Windows机器上验证（见 §10.6 测试凭据约定）。

#### 9.4.4 Windows特殊处理

Windows 下 Node.js 子进程启动需要特殊处理：
- **路径分隔符**：`path.join()` 自动处理
- **环境变量传递**：Windows 下 `%APPDATA%` 等在 `buildEnv()` 里直接展开为绝对路径
- **Node binary 执行权限**：Windows 下 `.exe` 文件直接执行，不需要 `chmod`

---

### 9.5 Tauri ↔ Node 启动序列

> **重要前提**：Node 是**独立 OS 进程**，不是 Tauri 进程的子线程或嵌入部分。
> - Tauri 主进程（Rust）和 Node 进程（v8 + libuv）有**独立 PID、独立内存空间**
> - 通信方式：HTTP（127.0.0.1:3737）+ stdio（环境变量/日志）
> - 崩溃隔离：Node 崩溃不会让 Tauri 挂；Tauri 退出 Node 自动 kill
>
> Node binary 物理上在 Tauri bundle 的 `resources/` 目录里（"集成在应用里面"），
> 运行时 Tauri 用 OS 的 `execve()` 启动它（"解开使用"）。

#### 9.5.1 启动流程（时序图）

```
[Tauri 主进程启动]
        │
        ▼
[读取 tauri.conf.json 的 bundle.resources]
        │
        ▼
[从 resourcesPath 确定 serverDir =<resources>/server/]
        │
        ▼
[确定 Node sidecar binary 路径]
        │
        ▼
[构造 Node 启动命令: node server/dist/index.js]
        │ ★ 环境变量传入 appDataDir（PLATFORM_CWD）
        ▼
[Spawn Node subprocess]
        │
        ▼
[轮询 http://127.0.0.1:3737/api/platform/health]
        │  间隔 200ms；最多等待 30s
        │  ★ Node 启动慢时 Tauri 在这里阻塞
        ▼
[收到 200 OK → 标记 Node ready]
        │
        ▼
[通知前端：window.__TAURI_INTEGRATION_OK__.set(true)]
        │  ★ 可选：Tauri IPC 到前端
        ▼
[WebView 开始接受交互]
        │
        ▼
【运行中 — watchdog 每 30s 检查一次 health】
        │  health 失败 → log error → 可选自动重启 Node
        ▼
[Tauri 退出]
        │
        ▼
[杀死 Node subprocess（自动，由 Tauri 管理）]
```

#### 9.5.2 Rust 端：Spawn + Health Check（伪代码）

```rust
// shell/src-tauri/src/main.rs（完整示例）

use std::process::Command;
use std::time::Duration;
use std::io::{BufRead, BufReader};

fn main() {
    let tauri_builder = tauri::Builder::default()
        .setup(|app| {
            // 1. 确定资源路径
            let resource_dir = app.path().resource_dir()
                .expect("Failed to get resource dir");
            let server_dir = resource_dir.join("server");
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data dir");

            // 2. 确定 Node sidecar binary（按 OS 选择）
            let node_binary = match std::env::consts::OS {
                "linux"   => server_dir.parent().unwrap()
                               .join("node-linux-x64"),
                "macos"   => server_dir.parent().unwrap()
                               .join(if cfg!(target_arch = "aarch64") {
                                   "node-darwin-arm64"
                               } else {
                                   "node-darwin-x64"
                               }),
                "windows" => server_dir.parent().unwrap()
                               .join("node-windows-x64.exe"),
                _ => panic!("Unsupported OS"),
            };

            // 3. 构造 runtime目录
            let runtime_dir = app_data_dir
                .join("data").join("desktopwork").join("runtime");
            std::fs::create_dir_all(&runtime_dir)
                .expect("Failed to create runtime dir");

            // 4. Spawn Node subprocess
            let mut child = Command::new(&node_binary)
                .arg(server_dir.join("dist").join("index.js"))
                .env("PLATFORM_CWD", &runtime_dir)
                .env("PLATFORM_PORT", "3737")
                .env("PLATFORM_APP_DATA", &app_data_dir)
                .env("PLATFORM_LOG_FILE", app.path().app_log_dir()
                     .unwrap().join("desktop-agent.log").to_str().unwrap())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("Failed to spawn desktop-agent");

            // 5. 等待 Node ready（最多 30s）
            let client = reqwest::blocking::Client::new();
            let start = std::time::Instant::now();
            let max_wait = Duration::from_secs(30);
            let interval = Duration::from_millis(200);

            loop {
                if start.elapsed() > max_wait {
                    // Node 启动超时，打印日志并退出
                    eprintln!("[desktopwork] Node startup timeout after 30s");
                    std::process::exit(1);
                }

                match client.get("http://127.0.0.1:3737/api/platform/health")
                           .timeout(Duration::from_secs(1))
                           .send()
                {
                    Ok(resp) if resp.status().is_success() => {
                        println!("[desktopwork] Node ready");
                        break;
                    }
                    _ => {
                        std::thread::sleep(interval);
                    }
                }
            }

            // 6. 可选：watchdog thread（检测 Node 崩溃）
            std::thread::spawn({
                let client = client.clone();
                move || {
                    loop {
                        std::thread::sleep(Duration::from_secs(30));
                        match client.get("http://127.0.0.1:3737/api/platform/health")
                                   .timeout(Duration::from_secs(2))
                                   .send()
                        {
                            Ok(resp) if resp.status().is_success() => {}
                            _ => {
                                eprintln!("[desktopwork] Node health check failed");
                                // v0.1: 直接报错；v0.2+: 可选自动重启
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri_runtime)
        .unwrap();

    tauri_builder.run(tauri::generate_context!());
}
```

#### 9.5.3 Node 端：环境变量接收（伪代码）

```typescript
// src/index.ts（节选）

import { APP_NAME } from './constant.js';

const PLATFORM_CWD    = process.env.PLATFORM_CWD    ?? appDataDir;  // 由 Tauri 传入
const PLATFORM_PORT   = parseInt(process.env.PLATFORM_PORT ?? '3737');
const PLATFORM_LOG_FILE = process.env.PLATFORM_LOG_FILE ?? join(appDataDir, 'logs', 'desktop-agent.log');
```

> **注**：Node 端不需要知道"资源在哪"——它只需要知道自己监听哪个端口、session 存在哪里、日志写到哪里。这些全部通过环境变量传入。**资源路径对 Node 没有意义**。

---

### 9.6 Express 静态服务 + WebView 入口

#### 9.6.1 Express 静态挂载

```typescript
// src/index.ts
import express from 'express';
import { join } from 'node:path';

const app = express();

// ★ 入口：所有 /apps/* 走 Express 静态服务
// 开发模式：APPS_DIR = desktop-agent/apps
// 生产模式：APPS_DIR = 资源目录/apps（由 DESKTOPWORK_APPS_DIR 环境变量传入）
const APPS_DIR = process.env.DESKTOPWORK_APPS_DIR
  ?? join(import.meta.dirname, '../../apps');  // dev fallback（相对 dist/）

app.use('/apps', express.static(APPS_DIR));

// API 路由...
app.use('/api', apiRouter);

// ★ WebView 入口：访问根路径时重定向到 /apps/workbench/
app.get('/', (_req, res) => {
  res.redirect('/apps/workbench/index.html');
});
```

#### 9.6.2 WebView URL 与 Tauri 配置

```json
// tauri.conf.json
{
  "app": {
    "windows": [{
      "url": "http://127.0.0.1:3737/" // Tauri 启动时 Node 必须 ready
    }]
  }
}
```

**启动时序决定了这个 `url` 配置是安全的**——因为 Tauri 会先 `spawn Node → wait health → 然后才让 WebView 加载页面`。所以 WebView 发起请求时 `127.0.0.1:3737` 一定已经就绪。

#### 9.6.3 CSP 配置

```json
// tauri.conf.json（续）
{
  "app": {
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://127.0.0.1:3737 http://localhost:3737; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
    }
  }
}
```

---

### 9.7 健康检查与 watchdog

**Dev 与 Prod 模式差异**：

| 模式 | 谁负责检查 | 检查什么 | 检查工具 | 失败时处理 |
|------|-----------|---------|---------|-----------|
| **Dev 快速检查** | 开发者手工 | Node 进程是否在跑 | `curl http://127.0.0.1:3737/api/platform/health` | 修代码、起 Node、报 bug |
| **Prod 启动检查** | Tauri 主进程 | Node 是否就绪 | HTTP 轮询（200ms 间隔，30s 超时）| 超时 → Tauri 退出并报错 |
| **Prod 运行检查** | Tauri watchdog thread | Node 是否还活着 | 30s 一次轮询 | log error（v0.1）；v0.2+ 自动重启 |

**Dev 模式流程**：

```bash
# 1. 启动 Node（开发者手工）
cd desktop-agent && pnpm dev

# 2. 等待看到 "ready on http://127.0.0.1:3737"

# 3. 快速验证
curl http://127.0.0.1:3737/api/platform/health
# 返回 {"status":"ok",...} → Node 可用

# 4. 浏览器打开 http://127.0.0.1:3737/ → 看到 UI
```

Dev 模式下**不启动 Tauri**——开发者直接跑 Node 进程、用浏览器或 curl 验证。
这样能最快迭代代码（不用每次都跑 `pnpm tauri dev`，启动慢）。

**Prod 模式流程**（§9.5 详述）：
Tauri 启动 → spawn Node → 轮询 health → ready 后加载 WebView → watchdog 持续监控。

#### 9.7.1 /api/platform/health端点

```typescript
// src/apps/platform/routes.ts
app.get('/api/platform/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: process.env.npm_package_version ?? '0.1.0',
    uptime: process.uptime(),
    pid: process.pid,
  });
});
```

#### 9.7.2 前端连接状态管理

```typescript
// 前端连接状态（React state）
const [nodeStatus, setNodeStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');

// 方式 A：polling（简单）
useEffect(() => {
  const interval = setInterval(async () => {
    try {
      const r = await fetch('http://127.0.0.1:3737/api/platform/health');
      setNodeStatus(r.ok ? 'ready' : 'error');
    } catch {
      setNodeStatus('error');
    }
  }, 2000);
  return () => clearInterval(interval);
}, []);
```

```tsx
{nodeStatus === 'connecting' && <div>Connecting to DesktopWork...</div>}
{nodeStatus === 'error' && <div>DesktopWork failed to start. Check logs.</div>}
```

---

### 9.8 日志与调试

#### 9.8.1 日志分类

| 日志文件 | 内容 | 谁写 |
|---------|------|------|
| `desktop-agent.log` | Platform 进程 stdout/stderr | Node.js（通过 `console.log` 重定向）|
| `claude-subprocess.log` | Claude Code 子进程 stdout/stderr | Claude Code SDK |
| `tauri.log` | Tauri 主进程日志 | Tauri 框架 |

#### 9.8.2 Node 日志重定向

```typescript
// src/index.ts（启动时）
import { appendFileSync, createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';

const LOG_DIR = path.dirname(process.env.PLATFORM_LOG_FILE ?? '');
mkdirSync(LOG_DIR, { recursive: true });

const logStream = createWriteStream(process.env.PLATFORM_LOG_FILE ?? 'desktop-agent.log', { flags: 'a' });
process.stdout.write = (chunk: any) => {
  logStream.write(chunk);
  process.__original_stdout__.write(chunk);
};
process.stderr.write = (chunk: any) => {
  logStream.write(chunk);
  process.__original_stdout__.write(chunk);
};
```

#### 9.8.3 Dev模式调试

```bash
# 开发时：直接跑 Node，不走 Tauri
cd desktop-agent && pnpm dev

# Tauri dev 模式：在 .taurignore 或 tauri.conf.json 中配置
# Tauri 开发时 Node 通过 cargo run -- --node-dev启动
```

**Dev 调试关键**：`curl http://127.0.0.1:3737/api/platform/health` 随时可验证 Node 状态。

---

### 9.9 跨平台 CI

**v0.1 范围**：仅 **Windows（NSIS .exe）** 和 **macOS（DMG）**。

> Linux 发布在 v0.2+ 考虑（AppImage / deb / rpm）。**v0.1 不发布 Linux 包**，但 Linux 机器上 dev 模式正常运行。

#### 9.9.1 CI矩阵

| Platform | Runner | 打包目标 | Node Binary |
|----------|--------|---------|-------------|
| macOS x64 | `macos-12` | `.dmg` | `node-darwin-x64` |
| macOS ARM64 | `macos-14` | `.dmg` | `node-darwin-arm64` |
| Windows x64 | `windows-2022` | `.exe`（NSIS）| `node-windows-x64.exe` |

**tauri.conf.json 对应**：

```json
{
  "bundle": {
    "targets": {
      "appimage": null,  // Linux — 暂不做
      "nsis": { /* NSIS 配置 */ },  // Windows
      "dmg": { /* DMG 配置 */ }      // macOS
    }
  }
}
```

**或更简化的方式**（Tauri 2 推荐的字符串语法）：

```json
{
  "bundle": {
    "targets": ["nsis", "dmg"]
  }
}
```

#### 9.9.2 CI 构建流程

```yaml
# .github/workflows/build.yml（简化版）
name: Build DesktopWork

on:
  push:
    tags: [ 'v*' ]
  pull_request:
    branches: [ main ]

jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: macos-x64
            runner: macos-12
          - platform: macos-arm64
            runner: macos-14
          - platform: windows-x64
            runner: windows-2022

    runs-on: ${{ matrix.runner }}

    steps:
      - uses: actions/checkout@v4

      # ★ Node binary 不在仓库里；这里动态下载 + cache
      - name: Setup Node.js binary
        id: setup-node
        uses: actions/cache@v4
        with:
          path: |
            node-binaries/node-macos-x64
            node-binaries/node-macos-arm64
            node-binaries/node-windows-x64.exe
          key: node-v22.3.0-${{ matrix.platform }}
          restore-keys: |
            node-v22-

      - name: Download Node binary
        if: steps.setup-node.outputs.cache-hit != 'true'
        shell: bash
        run: |
          PLATFORM="${{ matrix.platform }}"
          case "$PLATFORM" in
            macos-x64)    TARBALL="node-v22.3.0-darwin-x64" ;;
            macos-arm64)  TARBALL="node-v22.3.0-darwin-arm64" ;;
            windows-x64)  TARBALL="node-v22.3.0-win-x64" ;;
          esac
          mkdir -p node-binaries
          curl -L "https://nodejs.org/dist/v22.3.0/${TARBALL}.tar.xz" -o /tmp/node.tar.xz
          tar -xJf /tmp/node.tar.xz -C /tmp
          if [[ "$PLATFORM" == windows-* ]]; then
            mv "/tmp/${TARBALL}/node.exe" "node-binaries/node-${PLATFORM}.exe"
          else
            mv "/tmp/${TARBALL}/bin/node" "node-binaries/node-${PLATFORM}"
            chmod +x "node-binaries/node-${PLATFORM}"
          fi

      - name: Build desktop-agent
        run: |
          cd desktop-agent
          pnpm install --ignore-scripts
          pnpm run build
          pnpm deploy prod --out ../shell/src-tauri/server/node_modules

      - name: Prepare bundle resources
        run: |
          cp -r desktop-agent/dist    shell/src-tauri/server/
          cp   desktop-agent/package.json shell/src-tauri/server/
          cp -r desktop-agent/apps    shell/src-tauri/
          cp   node-binaries/node-${{ matrix.platform }} \
               shell/src-tauri/node-${{ matrix.platform }}
          [[ "${{ matrix.platform }}" == windows-* ]] && \
            mv shell/src-tauri/node-${{ matrix.platform }} \
               shell/src-tauri/node-${{ matrix.platform }}.exe || true

      - name: Build Tauri
        uses: tauri-apps/tauri-action@v0
        with:
          tag: ${{ github.ref_name }}
```

#### 9.9.3 包大小控制

> **2026-06-12 实际测量**：Claude Agent SDK 0.3.175 携带的 Linux x64 binary 为 **249MB**（ELF 64-bit, BuildID 0x2d2bcf）。不是初步估计的 5MB。

| 组成部分 | 目标大小 | 压缩后 | 备注 |
|---------|---------|-------|------|
| Node.js runtime（sidecar）| ~50MB | ~18MB | Node.js 22 LTS |
| desktop-agent dist/ | ~1MB | ~0.3MB | TS 编译产物 |
| node_modules（prod only, 不含 SDK）| ~30MB | ~10MB | express/cors/zod 等 |
| **Claude Agent SDK 二进制** | **~250MB** | **~80MB** | ⚠️ 实测 249MB（v0.3.175, Linux x64）|
| 前端 apps/ | ~2MB | ~0.5MB | HTML/JS |
| **总计** | **~330MB** | **~120MB** | 与 Electron 应用量级相当 |

**对设计的影响**：

- **CI cache 占用**：4 平台 × ~300MB ≈ 1.2GB，远低于 10GB GitHub 免费限额
- **Tauri sidecar 策略不变**：仍按当前方案（binary 随 node_modules 一起走 pnpm deploy）
- **用户包大小 ~300MB**：与 VSCode / Discord / Cursor 同量级，v0.1 可接受
- **冷 cache build 慢 ~30-60s**（下载 250MB binary），暖 cache 不受影响

**v0.2+ 优化方向**（不在 v0.1 范围）：
- 换 musl 版（Alpine Linux 兼容包，体积略小）
- 运行时懒下载 binary
- 拆分 `@anthropic-ai/claude-agent-sdk-core`（小包） + 独立 binary 包（按需下载）

> **注意**：压缩后 ~31MB，比当前很多 Electron 应用（~150MB+）轻很多。

---

### 9.10 错误处理与首次启动体验

#### 9.10.1 错误分类与处理

| 错误场景 | 用户看到 | 实际处理 |
|---------|---------|---------|
| Node 启动超时（30s 内没 health）| 白屏 + "DesktopWork 启动失败" | Tauri 退出，log 写原因 |
| Node health 检查失败（运行中）| 前端弹出"连接断开" | watchdog log error，可选自动重启 |
| config.json 损坏 | Express 启动失败 → Tauri 报错 | log 写明"配置损坏，请重置" |
| LLM API key 无效 | API 返回 401 → 前端提示 | 不影响 UI，只是 AI 不工作 |
| 端口 3737 被占用 | Tauri 报错"端口已被使用" | 启动前检查端口可用性 |

#### 9.10.2 首次启动引导

```typescript
// src/apps/settings/index.html（或引导页）
// 首次检测到 config.json 不存在 → 展示配置引导

const CONFIG_URL = 'http://127.0.0.1:3737/api/platform/config';

async function checkConfig() {
  try {
    const r = await fetch(CONFIG_URL);
    if (r.status === 404) {
      // 首次使用 → 展示配置页
      window.location.href = '/apps/settings/index.html?first=true';
    }
  } catch {
    // Node 未就绪 → 等待
  }
}
```

#### 9.10.3 Tauri 报错展示

```json
// tauri.conf.json（window 配置）
{
  "app": {
    "windows": [{
      "title": "DesktopWork",
      "center": true,
      "minWidth": 800,
      "minHeight": 600,
      "error": "Failed to start DesktopWork. Check ~/Library/Logs/ai.desktopwork.app/"
    }]
  }
}
```

---

### 9.11 v0.2+ 演进

以下功能在 v0.1 稳定后考虑：

| 功能 | 说明 | 复杂度 |
|------|------|-------|
| **自动更新** | Tauri Updater + GitHub Releases | ⭐⭐⭐ |
| **代码签名** | macOS notarize / Windows signtool | ⭐⭐⭐ |
| **多平台 session 同步** | iCloud / Dropbox导出 session | ⭐⭐ |
| **插件市场** | 分发 .desktopwork 插件包 | ⭐⭐⭐ |
| **会话历史 UI** | 前端展示 listSessions +搜索 | ⭐⭐ |
| **session overlay** | 平台侧增删改 session metadata（标签、星标、备注）| ⭐ |

---

### 9.12 本章小结（v0.2 设计意图，**已被 §9.13 部分修正**）

| 设计决策 | 结论 | 状态 |
|---------|------|------|
|资源只读，运行时只写 | P1：bundle 内文件永不写 | ✅ 保持 |
| Node 是 Tauri subprocess | P2：Tauri spawn + watchdog Node | ✅ 保持 |
| dev/prod 路径一致 | P3：所有路径通过 Tauri path API 计算 | ⚠️ 见 §9.13 Gap 4 |
| 静态文件服务 | **B（Express 静态）**：`http://127.0.0.1:3737/apps/` | ✅ 保持 |
| 健康检查 | **A（HTTP 轮询）**：`/api/platform/health` + 30s watchdog | ✅ 保持 |
| Node嵌入 | **Tauri sidecar**：Node binary 作为 bundle 资源 | ❌ 见 §9.13 Gap 1（v0.1 改为系统 PATH，v0.2+ 再上 sidecar） |
| WebView URL | `http://127.0.0.1:3737/`（Node 先 ready 再让 WebView 加载）| ⚠️ 见 §9.13 Gap 2（v0.1 改为 splash → navigate 方案）|
| 跨平台 CI | **v0.1 仅 2 平台**：macOS（DMG） + Windows（NSIS exe）；Linux dev 正常但不发包 | ✅ 保持 |

> **打包三原则（P1/P2/P3）是防止"本地正常打包挂"的根本**。后续任何修改必须保持这三条原则。

---

### 9.13 打包架构 v0.3.1：基于实测 + 自包含诉求的修正

> **背景**：v0.2 写完后实际打包测试（2026-06-15 一日 14 个 fix commit 都失败）暴露了 §9.0-§9.12 与可运行实现之间的 11 处脱节。Benjamin 在 v0.3 评审中明确诉求：**应用必须自包含，不依赖用户机器预装 Node**。本节据此修正。

#### 9.13.1 修正总览

| # | §9 v0.2 决策 | v0.3.1 实际决策 | 偏离原因 | 何时回归 |
|---|------------|-------------|---------|---------|
| 1 | Node sidecar | **Tauri sidecar（完整实现）** | **用户诉求：自包含应用**。v0.3 曾简化用系统 PATH node，违背自包含原则 | 一直保持 |
| 2 | `app.windows[0].url` 直指 `http://127.0.0.1:3737/` | **splash data:URL → eval navigate** | Tauri 启动窗口时 Node 还没 ready，会白屏/超时；data:URL splash 立即可见，再 JS 切到 Node URL | 永远使用此方案（更好的 UX） |
| 3 | `frontendDist` 指向 `apps/` | **不设 `frontendDist`，依赖 splash + navigate** | 实际前端由 Node Express 服务（§9.6 B 方案），不在 Tauri 内嵌；frontendDist 与 URL 二选一 | 永远不用 |
| 4 | P3 路径全用 Tauri path API | **dev 用 `DESKTOPWORK_DEV_ENTRY` 环境变量，prod 用 `app.path().resource_dir()` 推算** | path API 在 debug build 行为不一致；env var 简单可靠 | 验证够用即可 |
| 5 | `bundle.resources` 4 条 map | **`["server"]` 单条目录** | pnpm deploy 已经把 dist/node_modules/package.json/apps 全部塞到 server/，单条最简单 | 永远用单条 |
| 6 | CSP 严格白名单 | **`csp: null`** | dev 模式要宽松避免拦 devtools；prod 当前不暴露公网 | v0.2 加白名单 |
| 7 | Tauri 2 完整 sidecar | **bundle.externalBin + Tauri 2 sidecar API** | 同 Gap 1（自包含需求） | 一直保持 |
| 8 | CI 用 `tauri-action@v0` | **CI 用 `cargo install tauri-cli --version "^2.0.0" --locked` + 直接 `cargo tauri build`** | `tauri-action` 是更高层封装，对自定义 bundle 流程不友好；直接调 tauri-cli 可控性高 | 保持 |
| 9 | tauri-cli 通过 npm 装 | **CI 通过 cargo 装** | shell/ 不在 pnpm workspace，npm 装不可靠；cargo 装与 Rust toolchain 一致 | 永远用 cargo |
| 10 | Node binary CI 不下载 | **CI actions/cache + curl nodejs.org 下载** | 自包含应用要求 Node 随包分发 | 一直保持 |
| 11 | （未预料） | **所有 CI `run:` step 加 `shell: bash`** | Windows runner 默认是 PowerShell，不认 bash `if [[ ]]`（v0.3.1.1 实测发现）| 一直保持 |
| 12 | （未预料） | **`externalBin` 用裸基础名 `node`，Tauri 2 自动追加 `-<target-triple>`** | Tauri 2 不支持 `${platform}` 占位符（v0.3.1.1 实测发现）| 一直保持 |
| 13 | （未预料） | **`node-tarball-platform` matrix 值用 `win-x64`（不是 `windows-x64`）** | nodejs.org 官方 tarball 命名是 `win-x64`（v0.3.1.2 实测发现）| 一直保持 |
| 14 | （未预料） | **CI step 加 `set -euo pipefail` + cache 优先 + 文件大小校验** | download step 静默失败 / cache 覆盖新文件 / 404 HTML 混入（v0.3.1.3 实测发现）| 一直保持 |
| 15 | （未预料） | **删除 `. "$HOME/.cargo/env"`** | Windows Git Bash 上 `~/.cargo/env` 不存在，主动 fail；dtolnay/rust-toolchain@stable 已自动加 cargo 到 PATH（v0.3.1.4 实测发现）| 一直保持 |
| 16 | （未预料） | **用 `wc -c` 代替 `stat -c%s`** | macOS BSD stat 不认 `-c` 选项；`wc -c < file` 跨平台一致（v0.3.1.5 实测发现）| 一直保持 |
| 17 | （未预料） | **matrix 加 macos-13 (x64) + macos-latest (ARM64) 两个 entry** | `macos-latest` 现在是 ARM64，旧 matrix 只加 x64 entry 架构不匹配（v0.3.1.6 实测发现）| 一直保持 |

#### 9.13.2 v0.3.1 实际架构图

```
┌──────────────────────────────────────────────────────────────────┐
│ Tauri 主进程（Rust, ~9MB stripped）                              │
│                                                                   │
│  启动顺序:                                                        │
│  1. WebviewWindowBuilder → 创建窗口，url =                       │
│       data:text/html,...<splash HTML 内嵌>                       │
│  2. tokio::spawn(setup):                                         │
│     a) resolve_node_sidecar() → app.path().resource_dir()        │
│        .join(format!("node-{}", current_target_triple()))         │
│        .with_extension("exe") on Windows                          │
│        ★ Tauri 2 sidecar 路径（v0.3.1.1 修正）                  │
│     b) spawn sidecar node → server/dist/index.js                │
│     c) wait_for_ready: TcpStream 轮询 127.0.0.1:3737             │
│     d) window.eval("window.location.href = base_url")            │
│  3. watchdog: 每 30s 检查 health                                 │
│                                                                   │
│  Node binary 路径解析:                                           │
│  - dev:   系统 PATH 的 tsx（开发者本机 Node，符合预期）          │
│  - prod:  Tauri sidecar（bundle 内置，完全自包含）                │
│                                                                   │
│  Bundle:                                                          │
│  - bundle.resources = ["server"]  ← pnpm deploy 已备好          │
│  - bundle.externalBin = ["../node-binaries/node"]  ← 裸基础名    │
│    （Tauri 2 在 bundle 时自动追加 -<target-triple> 后缀）         │
│  - frontendDist = 不设置（避免和 navigate 冲突）                  │
│  - app.windows[0].url = 不设置（用 splash + eval）                │
└──────────────────────────────────────────────────────────────────┘

↓ spawn（prod 用 sidecar / dev 用系统 PATH）

┌──────────────────────────────────────────────────────────────────┐
│ Node.js Platform 进程                                              │
│                                                                   │
│  入口: server/dist/index.js                                       │
│  端口: 3737（可由 PORT 环境变量覆盖）                            │
│  静态: /apps/* → server/apps/（前端 HTML）                        │
│  API:  /api/platform/*, /api/bot-chat/*, /api/settings/*          │
│                                                                   │
│  内嵌依赖（已打包进 server/node_modules/）:                        │
│  - @anthropic-ai/claude-agent-sdk                                  │
│  - @anthropic-ai/claude-agent-sdk-linux-x64/claude (~249MB)        │
│  - express, cors, zod 等                                          │
└──────────────────────────────────────────────────────────────────┘
```

#### 9.13.3 v0.3.1 tauri.conf.json 完整示例（**唯一正确版本**）

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "DesktopWork",
  "version": "0.1.0",
  "identifier": "com.benjamin.desktopwork",

  "build": {
    // ★ 不设 frontendDist — WebView 走 splash → navigate 到 Node
    // ★ 不设 beforeBuildCommand — CI workflow 显式 pnpm deploy
  },

  "app": {
    "windows": [{
      "title": "DesktopWork",
      "width": 900,
      "height": 700,
      "minWidth": 600,
      "minHeight": 400,
      "center": true
      // ★ 不设 url — 用 main.rs 的 splash + eval 动态加载
    }],
    "security": {
      "csp": null
      // ★ v0.1 暂关；v0.2 加白名单（§9.6.3）
    }
  },

  "bundle": {
    "active": true,
    "targets": ["nsis", "dmg"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "resources": ["server"],
    // ★ 单条 server/ 即可。pnpm deploy 已经把 dist/、node_modules/、package.json、apps/ 全塞进 server/
    "externalBin": ["../node-binaries/node"],
    // ★ Tauri 2 sidecar：写"裸基础名"即可。Tauri 2 在 bundle 时自动追加 -<target-triple> 后缀：
    //   - Linux x64:   node  →  node-x86_64-unknown-linux-gnu
    //   - macOS Intel: node  →  node-x86_64-apple-darwin
    //   - macOS ARM64: node  →  node-aarch64-apple-darwin
    //   - Windows x64: node  →  node-x86_64-pc-windows-msvc.exe
    // CI 下载 Node binary 时必须用同名格式（详见 §9.13.5.1）
    "windows": { "nsis": { "installMode": "currentUser" } }
  }
}
```

**`externalBin` 路径规则（v0.3.1 实测发现，2026-06-16）**：

> ⚠️ **重要修正**：Tauri 2 **不**支持 `${platform}` 占位符。我之前 v0.3.1 写错了。Tauri 2 实际行为是：把 `externalBin` 数组里的**字面字符串**原样作为 basename，然后在 bundle 时**追加 `-<cargo target triple>` 后缀**（Windows 还加 `.exe`）。
>
> 所以正确做法：
> 1. `tauri.conf.json` 写 `externalBin: ["../node-binaries/node"]`（裸基础名）
> 2. CI 下载的 Node binary 必须**预先**保存为 `shell/node-binaries/node-<target-triple>` 格式
> 3. main.rs 解析时用 `current_target_triple()` 函数拼同一名字
>
> 如果 Tauri 在 `shell/node-binaries/` 找不到 `node-<target-triple>`，build 会在 `tauri-build` 阶段 fail 并报 `ExternalBinNotFound`。

#### 9.13.4 v0.3.1 main.rs 关键路径解析（修订 P3 + 加 sidecar）

```rust
// shell/src-tauri/src/main.rs

use tauri::Manager;

fn resolve_server_entry<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    // dev: 优先用环境变量，回退到 ./desktop-agent/src/index.ts 相对路径
    // prod: 从 resource_dir 推算 resources/server/dist/index.js
    if cfg!(debug_assertions) {
        std::env::var("DESKTOPWORK_DEV_ENTRY")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("desktop-agent/src/index.ts"))
    } else {
        let resource_dir = app.path().resource_dir()
            .expect("failed to get resource dir");
        resource_dir.join("server").join("dist").join("index.js")
    }
}

fn resolve_node_runner<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    entry: &Path,
) -> (PathBuf, Vec<String>) {
    // dev: 系统 PATH 的 tsx 跑 .ts（开发者本机应已装 Node）
    // prod: Tauri 2 sidecar `node-<target-triple>` 跑 .js（自包含，不依赖宿主）
    if cfg!(debug_assertions) {
        let cmd = if entry.extension().map(|e| e == "ts").unwrap_or(false) {
            "tsx"
        } else {
            "node"
        };
        (PathBuf::from(cmd), vec![entry.to_string_lossy().to_string()])
    } else {
        let resource_dir = app.path().resource_dir()
            .expect("failed to get resource dir");
        // Tauri 2 在 bundle 时把 externalBin 字面 basename 追加 -<cargo target triple> 后缀：
        //   externalBin 写 `node` (在 tauri.conf.json)
        //     → node-x86_64-unknown-linux-gnu        (Linux)
        //     → node-x86_64-apple-darwin             (macOS Intel)
        //     → node-aarch64-apple-darwin            (macOS Apple Silicon)
        //     → node-x86_64-pc-windows-msvc.exe      (Windows，set_extension 拼 .exe)
        // CI 下载 Node binary 时必须以同名格式保存在 shell/node-binaries/（§9.13.5.1）。
        let sidecar_path = {
            #[allow(unused_mut)] // mut is needed on Windows for set_extension
            let mut p = resource_dir.join(format!("node-{}", current_target_triple()));
            #[cfg(windows)]
            {
                p.set_extension("exe");
            }
            p
        };
        (sidecar_path, vec![entry.to_string_lossy().to_string()])
    }
}

fn current_target_triple() -> &'static str {
    // Tauri 2 默认 cargo target triple，跨平台固定。
    // 必须与 §9.13.5.1 CI download step 用的 matrix.node-binary-suffix 完全一致。
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}
```

**关键变化**（对比 §9.5.2 原始设计）：
- ✅ **去掉硬编码 `/mnt/d/projects/desktopwork/...`**
- ✅ **dev 用 `DESKTOPWORK_DEV_ENTRY` 环境变量**（可选覆盖）
- ✅ **prod 用 `app.path().resource_dir()` 推算**（符合 P3，不用 hardcode）
- ✅ **dev 模式用系统 `tsx` / `node`**（开发者本机应已装）
- ✅ **prod 模式用 Tauri 2 sidecar**（自包含，应用自带 Node）
- ✅ **sidecar 文件名直接用 `node-<target-triple>`**（v0.3.1 修正，不再拼 `node-{platform}-{target-triple}`）
- ✅ **Windows 用 `p.set_extension("exe")` 拼 `.exe` 后缀**（跨平台统一逻辑）
- ⚠️ **简化点**：Tauri 2 sidecar 实际文件名带 target triple 后缀，本实现手动构造这个后缀。更严谨的方案是用 `tauri_plugin_shell::ShellExt::sidecar()` API 自动解析，但需要在 Cargo.toml 加 tauri-plugin-shell 依赖。当前实现够用 v0.1。

#### 9.13.5 CI 工具链决策：cargo 装 tauri-cli，不用 npm

**为什么不用 npm/pnpm 装**（shell/package.json 之前的方案）：

| 问题 | 表现 |
|------|------|
| `shell/` 不在 pnpm workspace | pnpm install 行为不一致，CI 跑时 `node_modules/.bin/tauri` 偶尔缺失 |
| `--no-lockfile` 跳过 lockfile | 依赖解析不可重现，CI 容易飘 |
| `pnpm tauri` 走 script `tauri` 间接调 PATH | shell 脚本 + npm script + pnpm script 三层间接，故障点多 |

**正确做法**（CI 显式装 Rust CLI）：

```yaml
- name: Setup Rust
  uses: dtolnay/rust-toolchain@stable

- name: Install tauri-cli (cargo)
  run: cargo install tauri-cli --version "^2.0.0" --locked
  shell: bash

- name: Verify tauri CLI
  run: |
    . "$HOME/.cargo/env"
    cargo tauri --version
```

**关键点**：
- `cargo install tauri-cli --locked` 锁 Cargo.lock，**可重现**
- `--version "^2.0.0"` 显式锁大版本，避免 breaking change
- 装到 `$HOME/.cargo/bin/`，`source $HOME/.cargo/env` 即可
- 不依赖 pnpm / npm 任何行为

#### 9.13.5.1 Node binary 下载 + cache（**新增，v0.3.1**）

Node binary 是 Tauri sidecar 的一部分，必须在 CI 显式下载并缓存。

```yaml
- name: Determine Node.js platform
  id: node-platform
  run: |
    if [[ "$RUNNER_OS" == "Linux" ]]; then
      PLATFORM="linux-x64"
    elif [[ "$RUNNER_OS" == "macOS" ]]; then
      if [[ "$RUNNER_ARCH" == "ARM64" ]]; then
        PLATFORM="darwin-arm64"
      else
        PLATFORM="darwin-x64"
      fi
    elif [[ "$RUNNER_OS" == "Windows" ]]; then
      PLATFORM="windows-x64"
    fi
    echo "PLATFORM=$PLATFORM" >> $GITHUB_OUTPUT
    echo "Node platform: $PLATFORM"

- name: Download Node.js binary
  id: node-binary
  run: |
    PLATFORM="${{ steps.node-platform.outputs.PLATFORM }}"
    NODE_VERSION="22.3.0"
    TARBALL="node-v${NODE_VERSION}-${PLATFORM}"
    mkdir -p shell/node-binaries

    if [[ "$RUNNER_OS" == "Windows" ]]; then
      # Windows 用 zip
      curl -L "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}.zip" -o /tmp/node.zip
      unzip -j /tmp/node.zip "${TARBALL}/node.exe" -d shell/node-binaries/
      mv "shell/node-binaries/node.exe" "shell/node-binaries/node-${PLATFORM}.exe"
      rm /tmp/node.zip
    else
      # macOS / Linux 用 tar.xz
      curl -L "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}.tar.xz" -o /tmp/node.tar.xz
      tar -xJf /tmp/node.tar.xz -C /tmp
      mv "/tmp/${TARBALL}/bin/node" "shell/node-binaries/node-${PLATFORM}"
      chmod +x "shell/node-binaries/node-${PLATFORM}"
      rm /tmp/node.tar.xz
    fi
    echo "Node binary installed:"
    ls -la shell/node-binaries/
  shell: bash
  # ★ Windows runner 默认是 PowerShell，不会认识 if [[ ]]，必须显式指定 bash

- name: Cache Node.js binary
  uses: actions/cache@v4
  with:
    path: shell/node-binaries/
    key: node-v22.3.0-${{ steps.node-platform.outputs.PLATFORM }}
    restore-keys: |
      node-v22-
```

**关键点**：
- **`shell: bash` 必填**：Windows runner 默认是 PowerShell，bash 语法 `if [[ ]]` 会报 "Missing '(' after 'if'"
- `actions/cache` 按 platform + version 缓存 → 后续 build 直接命中，秒级跳过下载
- Windows 二进制 `.exe` 后缀，Unix 二进制无后缀 + `chmod +x`
- **二进制名格式为 `node-{cargo target triple}`**（不是 `node-{platform}`，见下面的 v0.3.1.1 修正）
- Node version 锁 v22.3.0（与项目要求 Node ≥ 22.3 一致）

> **v0.3.1.1 重要修正（2026-06-16 实测）**：
> 上面的简化 download step 写错文件名了。实际正确实现是：Node binary 必须保存为 **`node-{cargo target triple}`** 格式，不是 `node-{PLATFORM}`。完整版见 §9.13.6（用 `matrix.node-binary-suffix` 变量控制后缀）。
> 
> 原因：Tauri 2 在 bundle 阶段会按 `tauri.conf.json` 的 `externalBin` 字面 basename（"node"）+ 当前 cargo target triple 拼接出最终路径。CI 下载的二进制必须以**同样的规则**命名，否则 Tauri build 报 `ExternalBinNotFound` 错。
> 
> 原因：Tauri 2 在 bundle 阶段会按 `tauri.conf.json` 的 `externalBin` 字面 basename（"node"）+ 当前 cargo target triple 拼接出最终路径。CI 下载的二进制必须以**同样的规则**命名，否则 Tauri build 报 `ExternalBinNotFound` 错。

#### 9.13.6 CI Build 完整流程（**唯一正确版本，v0.3.1.1**）

```yaml
# .github/workflows/build.yml
name: Build DesktopWork

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

concurrency:
  group: build-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            target: dmg
            node-tarball-platform: darwin-x64
            node-binary-suffix: -x86_64-apple-darwin
          - platform: windows-latest
            target: nsis
            node-tarball-platform: windows-x64
            node-binary-suffix: -x86_64-pc-windows-msvc.exe
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      # === 1. 工具链 ===
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Setup pnpm
        run: npm install -g pnpm
        shell: bash

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Install tauri-cli
        run: cargo install tauri-cli --version "^2.0.0" --locked
        shell: bash

      # === 2. Node sidecar binary 下载 + cache ===
      # Tauri 2 在 bundle 时把 externalBin 里的字面 basename 追加 -<target-triple> 后缀。
      # CI 下载的 Node 二进制必须以同样规则命名，否则 build 报 ExternalBinNotFound。
      - name: Download Node.js binary
        run: |
          NODE_VERSION="22.3.0"
          NODE_PLATFORM="${{ matrix.node-tarball-platform }}"
          BINARY_SUFFIX="${{ matrix.node-binary-suffix }}"
          TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM}"
          mkdir -p shell/node-binaries
          FINAL_NAME="shell/node-binaries/node${BINARY_SUFFIX}"

          if [[ "$RUNNER_OS" == "Windows" ]]; then
            # Windows 用 zip
            curl -L "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}.zip" -o /tmp/node.zip
            unzip -j /tmp/node.zip "${TARBALL}/node.exe" -d shell/node-binaries/
            mv "shell/node-binaries/node.exe" "$FINAL_NAME"
            rm /tmp/node.zip
          else
            # macOS / Linux 用 tar.xz
            curl -L "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}.tar.xz" -o /tmp/node.tar.xz
            tar -xJf /tmp/node.tar.xz -C /tmp
            mv "/tmp/${TARBALL}/bin/node" "$FINAL_NAME"
            chmod +x "$FINAL_NAME"
            rm /tmp/node.tar.xz
          fi

          echo "=== Node binary installed ==="
          ls -la shell/node-binaries/
          "$FINAL_NAME" --version || true
        shell: bash
        # ★ Windows runner 默认是 PowerShell，不认识 bash 的 if [[ ]]，
        #   必须显式指定 shell: bash（windows-latest 自带 Git Bash）

      - name: Cache Node.js binary
        uses: actions/cache@v4
        with:
          path: shell/node-binaries/
          key: node-v22.3.0-${{ matrix.target }}
          restore-keys: |
            node-v22-

      # === 3. 装依赖 ===
      - name: Install workspace deps
        run: pnpm install --ignore-scripts
        shell: bash

      # === 4. 编译 + 验证 desktop-agent ===
      - name: Typecheck
        run: pnpm -F desktop-agent typecheck
        shell: bash

      - name: Build desktop-agent
        run: pnpm -F desktop-agent build
        shell: bash

      # === 5. 准备 bundle 资源（关键步骤） ===
      - name: Deploy server bundle to shell
        run: |
          pnpm deploy --filter desktop-agent --prod --legacy shell/src-tauri/server
          echo "=== server bundle size ==="
          du -sh shell/src-tauri/server
          echo "=== server bundle contents ==="
          ls shell/src-tauri/server/
          echo "=== expected: dist/ node_modules/ package.json apps/ ==="
          echo "=== Claude SDK binary present? ==="
          find shell/src-tauri/server/node_modules/@anthropic-ai -name "claude" -type f
        shell: bash

      # === 6. tauri build（产 installer） ===
      - name: Build Tauri app
        run: |
          . "$HOME/.cargo/env"
          # ★ 用绝对路径指 config，避免 working-directory 不一致
          cargo tauri build --config shell/src-tauri/tauri.conf.json --verbose
        shell: bash
        # ★ Tauri CLI 看到 bundle.externalBin = ["../node-binaries/node"]
        #   会自动在 shell/node-binaries/ 找 node-{target-triple}{.exe} 并打包

      # === 7. 上传产物 ===
      - name: Upload installer
        uses: actions/upload-artifact@v4
        with:
          name: desktopwork-${{ matrix.target }}
          path: |
            shell/src-tauri/target/release/bundle/${{ matrix.target }}/*.exe
            shell/src-tauri/target/release/bundle/${{ matrix.target }}/*.dmg
          if-no-files-found: error
```

**关键点**：
1. ✅ `cargo install tauri-cli --locked` 而非 npm — 解决「`tauri: command not found`」
2. ✅ `pnpm install` 不带 `--no-lockfile` — 用仓库自带的 pnpm-lock.yaml
3. ✅ 不用 `pnpm tauri` script — 直接 `cargo tauri build`，少一层间接
4. ✅ 用绝对路径 `--config shell/src-tauri/tauri.conf.json` — 避免 working-directory 歧义
5. ✅ **Node binary 通过 `actions/cache` + curl 下载**（v0.3.1.1 新增：用 matrix.node-binary-suffix 拼 target-triple 后缀）
6. ✅ **`bundle.externalBin` 用裸基础名 `node`**（v0.3.1.1 修正：Tauri 2 不支持 `${platform}` 占位符）
7. ✅ **所有 `run:` step 加 `shell: bash`**（v0.3.1.1 关键修正：Windows runner 默认是 PowerShell）
8. ✅ 加 `if-no-files-found: error` — 失败立即发现，不会传空 artifact
9. ✅ matrix 用 `windows-latest` / `macos-latest` runner，自带 Rust
10. ✅ 删掉所有 `debug` step（"Debug Tauri setup" 等）— 它们只是临时诊断噪音

**为什么所有 step 都要 `shell: bash`**：

GitHub Actions runner 默认 shell：
- `ubuntu-latest` / `macos-latest` 默认 `bash` — bash 语法可用
- `windows-latest` 默认 `pwsh`（PowerShell Core）— bash 的 `if [[ ]]` 报 "Missing '(' after 'if'"

为了一致性和跨平台可移植性，**所有用 bash 特性的 step 显式声明 `shell: bash`**。GitHub Actions 的 windows-latest runner 自带 Git Bash，bash 工具（ls/chmod/curl/tar/unzip 等）都在 PATH 里。
        # 产出 desktop-agent/dist/

      # === 5. 准备 bundle 资源（关键步骤） ===
      - name: Deploy server bundle to shell
        run: |
          # ★ pnpm deploy 把 dist/、node_modules/、package.json、apps/ 全塞到 shell/src-tauri/server/
          pnpm deploy --filter desktop-agent --prod --legacy shell/src-tauri/server
          echo "=== server bundle size ==="
          du -sh shell/src-tauri/server
          echo "=== server bundle contents ==="
          ls shell/src-tauri/server/
          echo "=== expected: dist/ node_modules/ package.json apps/ ==="
          echo "=== Claude SDK binary present? ==="
          find shell/src-tauri/server/node_modules/@anthropic-ai -name "claude" -type f

      # === 6. tauri build（产 installer） ===
      - name: Build Tauri app
        run: |
          . "$HOME/.cargo/env"
          # ★ 用 ${platform} 占位符，CLI 自动展开成当前 target 对应 binary
          cargo tauri build --config shell/src-tauri/tauri.conf.json --verbose
        # ★ 用绝对路径指 config，避免 working-directory 不一致
        # ★ Tauri CLI 看到 bundle.externalBin = ["../node-binaries/node-${platform}"]
        #   会自动找 shell/node-binaries/node-{当前 target platform} 并打包

      # === 7. 上传产物 ===
      - name: Upload installer
        uses: actions/upload-artifact@v4
        with:
          name: desktopwork-${{ matrix.target }}
          path: |
            shell/src-tauri/target/release/bundle/${{ matrix.target }}/*.exe
            shell/src-tauri/target/release/bundle/${{ matrix.target }}/*.dmg
          if-no-files-found: error
```

**关键点**：
1. ✅ `cargo install tauri-cli --locked` 而非 npm — 解决「`tauri: command not found`」
2. ✅ `pnpm install` 不带 `--no-lockfile` — 用仓库自带的 pnpm-lock.yaml
3. ✅ 不用 `pnpm tauri` script — 直接 `cargo tauri build`，少一层间接
4. ✅ 用绝对路径 `--config shell/src-tauri/tauri.conf.json` — 避免 working-directory 歧义
5. ✅ **Node binary 通过 `actions/cache` + curl 下载**（v0.3.1.1 新增：用 matrix.node-binary-suffix 拼 target-triple 后缀）
6. ✅ **`bundle.externalBin` 用裸基础名 `node`**（v0.3.1.1 修正：Tauri 2 不支持 `${platform}` 占位符）
7. ✅ **所有 `run:` step 加 `shell: bash`**（v0.3.1.1 关键修正：Windows runner 默认是 PowerShell）
8. ✅ 加 `if-no-files-found: error` — 失败立即发现，不会传空 artifact
9. ✅ matrix 用 `windows-latest` / `macos-latest` runner，自带 Rust
10. ✅ 删掉所有 `debug` step（"Debug Tauri setup" 等）— 它们只是临时诊断噪音

**为什么所有 step 都要 `shell: bash`**：

GitHub Actions runner 默认 shell：
- `ubuntu-latest` / `macos-latest` 默认 `bash` — bash 语法可用
- `windows-latest` 默认 `pwsh`（PowerShell Core）— bash 的 `if [[ ]]` 报 "Missing '(' after 'if'"

为了一致性和跨平台可移植性，**所有用 bash 特性的 step 显式声明 `shell: bash`**。GitHub Actions 的 windows-latest runner 自带 Git Bash，bash 工具（ls/chmod/curl/tar/unzip 等）都在 PATH 里。

#### 9.13.7 打包验证清单（CI 通过标准）

CI 跑完后，**所有这些必须为真**才算打包成功：

| # | 验证项 | 怎么验证 |
|---|--------|---------|
| V1 | Tauri CLI 装上 | step "Install tauri-cli" 通过 |
| V2 | Node binary 下载 | step "Download Node.js binary" 产出 `shell/node-binaries/node-{target-triple}`（不是 `{platform}`）|
| V3 | Node binary 可执行 | dev 跑 `shell/node-binaries/node-x86_64-unknown-linux-gnu --version` 返版本号 |
| V4 | desktop-agent typecheck 零错 | step "Typecheck" 零错 |
| V5 | desktop-agent build 成功 | step "Build desktop-agent" 产出 dist/ |
| V6 | pnpm deploy 成功 | shell/src-tauri/server/ 存在且 ≥ 50MB（含 Claude SDK）|
| V7 | server/ 结构正确 | server/{dist, node_modules, package.json, apps} 都存在 |
| V8 | server 内有 Claude binary | find shell/src-tauri/server/node_modules/@anthropic-ai -name "claude" 有结果 |
| V9 | cargo build 成功 | 产出 target/release/desktopwork（~9MB stripped） |
| V10 | bundler 成功 | target/release/bundle/{nsis,dmg}/ 下有 .exe/.dmg |
| V11 | installer 可上传 | upload-artifact 找到文件 |
| **V12** | **自包含验证（关键）** | 把 .dmg/.exe 安装到干净虚拟机 → 双击 → Node ready → AI 响应（v0.2+ 实现自动化测试）|
| **V13** | **Windows shell 验证（v0.3.1.1）** | Windows runner 所有 step 都加 `shell: bash`，没有 "Missing '(' after 'if'" 错 |

#### 9.13.8 失败诊断决策树

```
CI 失败 →
├─ "tauri: command not found"
│  └─ 解决：cargo install tauri-cli --version "^2.0.0" --locked
│
├─ "Missing '(' after 'if' in if statement"  ← PowerShell 不认 bash if [[ ]]
│  └─ 解决：给所有 bash 语法的 step 加 shell: bash
│
├─ "Node binary not found in shell/node-binaries/"
│  └─ 解决：检查 "Download Node.js binary" step 是否正确执行，curl 网络通不通
│
├─ "externalBin file not found" / "ExternalBinNotFound"
│  └─ 解决：CI 下载的 binary 必须以 node-{target-triple}{.exe} 命名（不是 node-{platform}）
│          tauri.conf.json 的 externalBin 是裸基础名 "node"
│
├─ "pnpm install fails"
│  └─ 解决：去掉 --no-lockfile，确保仓库有 pnpm-lock.yaml
│
├─ "pnpm deploy fails"
│  └─ 解决：确认 desktop-agent/package.json 有正确的 dependencies
│
├─ "frontendDist not found"
│  └─ 解决：tauri.conf.json 不设 frontendDist（用 splash + navigate）
│
├─ "cargo tauri build fails: config not found"
│  └─ 解决：用绝对路径 --config shell/src-tauri/tauri.conf.json
│
└─ "no installer produced"
   └─ 解决：检查 bundle.resources = ["server"]，确认 shell/src-tauri/server/ 存在
```

#### 9.13.9 v0.3.1 已知遗留（不阻塞）

| 项 | 影响 | 何时解决 |
|----|------|---------|
| CSP null | dev 体验好，prod 安全一般 | v0.2 加白名单 |
| DesktopWork 二进制 ~9MB + Node sidecar ~50MB + Claude SDK binary ~250MB → installer ~300MB | 与 Electron 同量级 | 接受；v0.2+ 考虑 runtime 懒下载 binary |
| 没自动更新 | 手动下载新版本 | v0.3 |
| Sidecar 文件名带 target triple 后缀，main.rs 手动拼 | 简单但不优雅 | v0.2 引入 `tauri_plugin_shell::ShellExt::sidecar()` API |
| 没跨平台 Node 编码验证 | Linux 实测过，Windows/macOS 待 v0.1 安装验证 | v0.1 §10.5.4-5.1.5 验证 |

#### 9.13.10 v0.3.1.1 实测修正（2026-06-16）

CI 第一次跑 v0.3.1 暴露两个细节问题，subagent（修复人）+ Benjamin（验证人）共同发现，本节记录。

**问题 A：`bundle.externalBin` 不支持 `${platform}` 占位符**

- **症状**：v0.3.1 设计文档写 `"../node-binaries/node-${platform}"`，假设 Tauri 2 会自动展开。
- **实测**：Tauri 2 在 `tauri-build` 阶段把 `externalBin` 数组里的**字面字符串**作为 basename，bundle 时**追加 `-<cargo target triple>` 后缀**（Windows 还加 `.exe`）。无 `${platform}` 占位符。
- **修正**：
  - `tauri.conf.json` 写 `["../node-binaries/node"]`（裸基础名）
  - CI 下载 Node binary 时保存为 `node-{target-triple}` 格式
  - matrix 加 `node-tarball-platform`（用于 nodejs.org URL）和 `node-binary-suffix`（用于本地文件名）两个变量
- **main.rs 对应**：用 `current_target_triple()` 函数拼同一名字

**问题 B：Windows runner 默认 shell 是 PowerShell 不是 bash**

- **症状**：CI run #27587394046 在 Windows runner 上 `if [[ "$RUNNER_OS" == "Windows" ]]; then` 报错 `Missing '(' after 'if' in if statement`。
- **根因**：`windows-latest` runner 默认 `pwsh`（PowerShell Core），不识别 bash 语法。
- **修正**：所有用 bash 语法的 step 加 `shell: bash`（windows-latest 自带 Git Bash，bash 工具链可用）。

**矩阵配置（v0.3.1.1 标准）**：

```yaml
matrix:
  include:
    - platform: macos-latest
      target: dmg
      node-tarball-platform: darwin-x64
      node-binary-suffix: -x86_64-apple-darwin
    - platform: windows-latest
      target: nsis
      node-tarball-platform: windows-x64
      node-binary-suffix: -x86_64-pc-windows-msvc.exe
```

**Linux runner 当前用 `ubuntu-latest`（v0.2 设计要求）—— 但 §9.9.1 说 v0.1 不发 Linux 包，本 CI 暂只跑 macOS + Windows。**如要加 Linux runner，target triple 是 `x86_64-unknown-linux-gnu`。

**学习（避免下次再踩）**：

1. ✅ **Tauri 2 sidecar 机制**：`externalBin` 写裸 basename，binary 文件名后缀由 Tauri 自动追加
2. ✅ **Windows CI 必须显式 `shell: bash`**：永远不要假设 runner 默认 shell 跨平台一致
3. ✅ **设计文档和实测差异要立刻记录**：§9.13.10 这种实测修正节比 §9 早期版本的可信度高

#### 9.13.11 v0.3.1.2 实测修正（2026-06-16）

CI 第二次跑 v0.3.1.1 暴露第三个细节问题。

**问题 C：`node-tarball-platform` 用错值**

- **症状**：CI run 在 Windows runner 上下 载 step 报错 `End-of-central-directory signature not found`，下载了 14 字节的 HTML 404 页。
- **根因**：nodejs.org 官方 tarball 命名约定是 **`win-x64`**（不是 `windows-x64`！）。完整映射：
  | CI 平台 | nodejs.org tarball 后缀 |
  |---------|----------------------|
  | Linux x64 | `linux-x64` ✅ |
  | macOS Intel | `darwin-x64` ✅ |
  | macOS Apple Silicon | `darwin-arm64` ✅ |
  | **Windows x64** | **`win-x64`** ✅（不是 `windows-x64` ❌） |
- **修正**：matrix 的 `node-tarball-platform` 从 `windows-x64` 改为 `win-x64`。**`node-binary-suffix` 不变**（那是 cargo target triple 命名，跟 nodejs.org 无关）。

**修正后的正确 matrix**：

```yaml
matrix:
  include:
    - platform: macos-latest
      target: dmg
      node-tarball-platform: darwin-x64            # nodejs.org 命名
      node-binary-suffix: -x86_64-apple-darwin     # cargo target triple 命名
    - platform: windows-latest
      target: nsis
      node-tarball-platform: win-x64                # ★ nodejs.org 是 win-x64 不是 windows-x64
      node-binary-suffix: -x86_64-pc-windows-msvc.exe
```

**学习（避免下次再踩）**：

1. ✅ **nodejs.org 命名约定**：macOS = darwin，Linux = linux，**Windows = win**（不是 windows）
2. ✅ **CI 遇到 14 字节下载** = 100% 是 URL 404，立刻检查 tarball 名字
3. ✅ **先 curl -sI 验证 URL 再写 CI**（`curl -sI https://nodejs.org/dist/v22.3.0/node-v22.3.0-win-x64.zip` 应返 200）
4. ✅ **混淆点**：nodejs.org tarball 后缀（`win-x64`）≠ 我们的 platform 标识（`windows-x64`）≠ cargo target triple（`x86_64-pc-windows-msvc`）—— **三套命名系统不要混**

#### 9.13.12 v0.3.1.3 实测修正（2026-06-16）

CI 第三次跑 v0.3.1.2 暴露第四个问题。tauri-build 报 exit 1，本地 WSL 复现 OK，CI fail。

**问题 D：CI download step 静默失败**

- **症状**：CI run #27592902583，macOS + Windows runner 都报 `failed to run custom build command`，exit status 1。
- **本地复现**：`cargo tauri build --config shell/src-tauri/tauri.conf.json` 在 WSL 跑成功（2m 36s）。说明设计本身没错。
- **根因**（3 个叠加坑）：
  1. **step 脚本没有 `set -euo pipefail`**：如果 `tar` 失败（BSD tar 跟 GNU tar 差异、`xz` 缺失等），后续 `mv` 找不到源文件失败，但因为没开 `set -e`，脚本不退出。`ls` 输出空目录，`"$FINAL_NAME" --version || true` 被 `|| true` 掩着，下游根本看不到报错
  2. **step 顺序错了**：当前先 download 再 cache。cache hit 时 `actions/cache` 会**覆盖**刚 download 的文件——如果之前的 failed run 缓存了空文件，就会被错误地恢复
  3. **没有文件大小校验**：404 HTML 是 14 字节，真 Node binary 是 50MB+。不校验就不知道下载有没有拿到真的
- **修正**：
  1. step 顶部加 `set -euo pipefail`（任何错误立刻退出）
  2. **重排顺序**：先 cache，再 download（且只在 `cache-hit != 'true'` 时）
  3. **加 size 校验**：下载后检查 `stat -c%s` 必须 ≥ 1MB（真 binary 至少 50MB）
  4. 加 debug step 在 tauri build 之前打印 `pwd` + `ls -la shell/node-binaries/`，失败时一眼看出是 file 缺失还是别的问题

**修正后的正确 step 顺序**：

```yaml
- name: Cache Node.js binary
  id: cache-node
  uses: actions/cache@v4
  with:
    path: shell/node-binaries/
    key: node-v22.3.0-${{ matrix.target }}
    restore-keys: |
      node-v22-

- name: Download Node.js binary
  if: steps.cache-node.outputs.cache-hit != 'true'   # ★ 只在 cache miss 时下
  run: |
    set -euo pipefail                                # ★ fail-fast
    ...download + extract + mv...
    SIZE=$(stat -c%s "$FINAL_NAME")
    if [[ "$SIZE" -lt 1000000 ]]; then
      echo "ERROR: $FINAL_NAME is $SIZE bytes, expected ≥1MB"
      exit 1
    fi
  shell: bash

- name: Debug before tauri build
  run: |
    echo "=== pwd ==="
    pwd
    echo "=== shell/node-binaries/ ==="
    ls -la shell/node-binaries/
    echo "=== file type check ==="
    file shell/node-binaries/node* 2>/dev/null || echo "no files matching node*"
  shell: bash
```

**学习（避免下次再踩）**：

1. ✅ **CI bash step 必加 `set -euo pipefail`**：默认值不 fail-fast，错逽静默走完全步
2. ✅ **cache 步骤要在 download 之前**：避免 cache 覆盖新下载的文件
3. ✅ **下载后必校验文件大小**：14 字节 = 100% 404；1MB 以下 = 100% 错
4. ✅ **关键 step 前后加 debug output**：失败时省一个小时猜
5. ✅ **Tauri 2 sidecar 文件名拼接规则实测**：`externalBin: ["node"]` + cargo target triple → `node-{triple}`（Unix）/`node-{triple}.exe`（Windows）。CI 下载的 binary 必须严格匹配此规则，否则 tauri-build 在 `target/release/build/...` 阶段报 `ResourcePathNotFound`

#### 9.13.13 v0.3.1.4 实测修正（2026-06-16）

CI 第四次跑 v0.3.1.3 暴露第五个问题。Windows runner 报 `cargo: command not found` 变体。

**问题 E：`. "$HOME/.cargo/env"` 在 Windows runner 主动 fail**

- **症状**：CI run #27593979580 Windows runner 报：
  ```
  D:\a\_temp\...sh: line 1: /c/Users/runneradmin/.cargo/env: No such file or directory
  ```
- **根因**：
  - 之前为了防御性手动 source cargo env（确保 cargo 在 PATH）
  - macOS runner 上 `$HOME/.cargo/env` 存在，能 source 成功
  - **Windows runner 上 Git Bash 路径 `/c/Users/runneradmin/.cargo/env` 不存在**——`dtolnay/rust-toolchain@stable` 在 Windows 上不生成 `env` 文件，只加 `~/.cargo/bin` 到 PATH
  - 结果：source 失败（exit 1）但 bash 脚本继续执行，cargo 命令还是没找到
- **修正**：**删掉 `. "$HOME/.cargo/env"` 这行**。`dtolnay/rust-toolchain@stable` 会在所有后续 step 把 cargo 加到 PATH。不需要手动 source。
- **学习**：
  1. ✅ **`dtolnay/rust-toolchain@stable` 会自动把 `~/.cargo/bin` 加到 PATH**，不需 source env
  2. ✅ **不要在 CI 里手动 `. "$HOME/.cargo/env"`**：macOS 上冗余，Windows 上 break
  3. ✅ **Windows Git Bash 上 `~/.cargo/env` 不存在**（不是所有人手装 rustup 都会生成）
  4. ✅ **为什么本地能跑**：本地手动 `cargo install tauri-cli` 是独立的安装路径，不依赖 PATH env

**修正后 Build Tauri step**：

```yaml
- name: Build Tauri app
  run: |
    # dtolnay/rust-toolchain@stable 已把 cargo 加到 PATH
    # 不需 source .cargo/env（macOS 上冗余、Windows 上 break）
    cargo tauri build --config shell/src-tauri/tauri.conf.json --verbose
  shell: bash
```

**为什么不需 `tauri-action`**：

原 §9.13.1 Gap 8 决定：CI 用 `cargo tauri build` 而非 `tauri-apps/tauri-action@v0`。理由：
- tauri-action 是高层封装，限制多（固定的 bundle 流程）
- 我们要自定义 `bundle.externalBin` + `bundle.resources`，tauri-action 不友好
- 直接 `cargo tauri build` 可控性高，跟设计文档一致

**如果未来要用 tauri-action**（v0.2 重新评估）：
- 它内部自动处理 PATH 跨平台差异
- 代价：上传 release 的流程被它绑定，不能自定义 artifact 名字
- v0.1 还是直接 `cargo tauri build`

#### 9.13.14 v0.3.1.5 实测修正（2026-06-16）

CI 第五次跑 v0.3.1.4 暴露第六个问题。macOS runner 报 `stat: illegal option -- c`。

**问题 F：`stat -c%s` 是 GNU stat 语法，macOS BSD stat 不支持**

- **症状**：CI run #275...（v0.3.1.4 后），macOS runner 报：
  ```
  stat: illegal option -- c
  usage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]
  ```
- **根因**：`stat` 命令跨平台语法不统一：
  | 平台 | 语法 | 示例 |
  |------|------|------|
  | Linux（GNU coreutils）| `-c%s` | `stat -c%s file` |
  | macOS（BSD）| `-f%z` | `stat -f%z file` |
  | Windows Git Bash（MSYS2 GNU coreutils）| `-c%s` | `stat -c%s file` |
- **修正**：用 `wc -c < file` 代替 `stat -c%s file`——`wc -c` 在三个平台都输出字节数，true 跨平台 portable
- **修正后**：
  ```bash
  # ★ v0.3.1.5：用 wc -c 代替 stat -c%s（macOS BSD stat 不认 -c）
  SIZE=$(wc -c < "$FINAL_NAME" | tr -d ' \n')
  if [[ "$SIZE" -lt 1000000 ]]; then
    echo "::error::Downloaded Node binary is $SIZE bytes (< 1MB), probably 404 or empty"
    file "$FINAL_NAME" 2>/dev/null || true
    head -c 200 "$FINAL_NAME" 2>/dev/null || true
    exit 1
  fi
  ```
  `tr -d ' \n'` 处理 `wc` 可能的 leading whitespace 和 newline。

**学习（避免下次再踩）**：

1. ✅ **`stat` 跨平台不统一**——Linux 写 `stat -c%s file`，macOS 写 `stat -f%z file`
2. ✅ **`wc -c < file` 是真正 portable 的**——三个平台都输出字节数
3. ✅ **CI bash 脚本要避免 GNU 专属语法**：能 cross-platform 写就 cross-platform 写
4. ✅ **macOS / Linux 跨平台脚本基本 all on 官方 POSIX 集合**：coreutils/awk/grep 跨平台一致，`stat/date/find` 有差异

#### 9.13.15 v0.3.1.6 实测修正（2026-06-16）

CI 第六次跑 v0.3.1.5 暴露第七个问题。macOS runner 报 `resource path ... doesn't exist`。

**问题 G：matrix 没匹配 runner 架构**

- **症状**：CI 跑完后报：
  ```
  resource path `../node-binaries/node-aarch64-apple-darwin` doesn't exist
  ```
- **根因**：
  - 当前 matrix 只在 macos-latest 下加了一个 entry，值是 `darwin-x64` + `-x86_64-apple-darwin`
  - **GitHub Actions 的 `macos-latest` 现在是 `macos-14`（Apple Silicon / aarch64）**——不是 x86_64
  - tauri-build 看 `TARGET=aarch64-apple-darwin`，拼接出 `../node-binaries/node-aarch64-apple-darwin`，跟下载的 x86_64 binary 名字不匹配 → 找不到
  - §9.9.1 设计本来说两个 macOS runner：`macos-12` (x64) + `macos-14` (ARM64)。但 build.yml 只加了一个 entry，还错用 x64 的值
- **修正**：matrix 加 2 个 macOS entry（x64 + ARM64），跟 §9.9.1 设计对齐：
  ```yaml
  matrix:
    include:
      - platform: macos-latest       # ARM64 (Apple Silicon, M1/M2/M3)
        target: dmg
        node-tarball-platform: darwin-arm64
        node-binary-suffix: -aarch64-apple-darwin
      - platform: macos-13           # x86_64 (Intel, 还在 GitHub Actions 提供)
        target: dmg
        node-tarball-platform: darwin-x64
        node-binary-suffix: -x86_64-apple-darwin
      - platform: windows-latest
        target: nsis
        node-tarball-platform: win-x64
        node-binary-suffix: -x86_64-pc-windows-msvc.exe
  ```
  现在 3 个 job：macos-arm64 / macos-x64 / windows-x64，每个下载自己的 Node binary。
- **GitHub Actions runner 架构参考表**（2026-06 实测）：
  | Runner 名字 | 架构 | CPU |
  |------------|------|-----|
  | `ubuntu-latest` | x86_64 | Intel/AMD |
  | `macos-13` | x86_64 | Intel |
  | `macos-14` / `macos-15` / `macos-latest` | aarch64 | Apple Silicon |
  | `windows-latest` | x86_64 | Intel/AMD |
  `macos-12` 已被 GitHub 迨役，不推荐。

**学习（避免下次再踩）**：

1. ✅ **`macos-latest` 可能是 ARM64**——不要假设是 x86_64
2. ✅ **nodejs.org tarball 后缀 `darwin-x64` ≠ macOS runner 架构**——runner 是 ARM64 要下 `darwin-arm64`
3. ✅ **matrix 必须跟 runner 架构匹配**——`platform` runner 架构 + `node-tarball-platform` 下跱 URL + `node-binary-suffix` 跟 tauri-build 查找路径一致
4. ✅ **如果发多个架构的包，每个架构需独立 matrix entry**（v0.1 可选范围）





## 十、实施路径

> 本章是 **v0.1 落地的最终执行计划**。每个 Phase 完成后向 Benjamin 汇报，**确认无问题**再进下一阶段。所有 AI 层代码需走 claude-session（subagent）执行。

### 10.0 总览

| Phase | 内容 | 估时 | 依赖 | DoD |
|-------|------|------|------|-----|
| **1.1** | 仓库初始化 + 依赖安装 | 10 min | - | `pnpm install` 成功；`@anthropic-ai/claude-agent-sdk` + 平台 binary 装好 |
| **1.2** | Platform 核心模块（不含 AI）| 20 min | 1.1 | `tsc` 通过；`pnpm dev` 能起 HTTP server；`curl /api/platform/config` 返 200 |
| **1.3** | AI 层实现（agent/event/warmer）| 25 min | 1.2 | `tsc` 通过；`curl` SSE 端点返 `text_delta` + `session_done` |
| **1.4** | SDK Smoke 测试套件 | 15 min | 1.3 | 4 项 smoke test 全 PASS（见 §10.6）|
| **2.1** | Bot Chat 后端（SSE 路由）| 15 min | 1.4 | curl 完整对话可获 `session_id` + `cost` |
| **2.2** | Bot Chat 前端（最小）| 30 min | 2.1 | Playwright 验证：发送消息→看到流式文本→调工具 |
| **3.1** | Settings App 后端 + 前端 | 20 min | 1.4 | Playwright 验证：改 baseUrl→保存→下条消息走新 Provider |
| **4.1** | 端到端集成验证 | 20 min | 1-3 | 4 场景全通过（Anthropic/MiniMax/双 Provider/重启后续接）|
| **5.1** | Tauri 集成 + 跨平台 CI（含 sidecar）| 60 min | 1-4 | macOS .dmg + Windows .exe 都产出、都能启动聊天 |

**总估时**：~3 小时 45 分。**检查点（每 10 分钟）**：执行方主动汇报进度与问题（按 MEMORY.md 调研 + claude-code-usage 规范）。

> **总估时不含 §10.0.1 迁移**。迁移是旧仓库专用，全新仓库跳过。

---

### 10.0.1 Pre-Phase 0：仓库迁移（可选，10 min）

> **适用场景**：从 v0.1 旧仓库（使用 Vercel AI SDK：`@ai-sdk/*` / `@mastra/core`）迁移到 Claude Agent SDK。
> **跳过条件**：
> - 全新空仓库
> - 旧仓库用的是其他 SDK（不是 Vercel）
> - 任何从零开始的场景
>
> **跳过时直接进 §10.1.1**。

**目标产出**：旧仓库清完 Vercel SDK 痕迹，装备 Claude Agent SDK 依赖。

| 步骤 | 任务 | DoD |
|------|------|-----|
| 0.0.1 | **备份 v0.1 文档**：`cp docs/technical/TECH-DESIGN.md docs/technical/TECH-DESIGN.md.v0.1.bak-2026-06-12` | backup 文件存在 |
| 0.0.2 | **备份 v0.1 代码**（可选）：`git tag v0.1-pre-migration` | tag 创建成功 |
| 0.0.3 | **改 `desktop-agent/package.json`**：<br>• 删依赖：`ai`、`@ai-sdk/anthropic`、`@ai-sdk/openai`、`@mastra/core`（连同该命名空间下任何包）<br>• 增依赖：`@anthropic-ai/claude-agent-sdk@^0.3.174` | `pnpm install` 成功 |
| 0.0.4 | **删除旧文件**：<br>• `desktop-agent/src/llm.ts`（Vercel SDK 抽象）<br>• `desktop-agent/src/agent.ts`（含 `buildStreamFn` 路径）<br>• `desktop-agent/src/mastra/` 目录（如果存在）<br>• `desktop-agent/src/storage/` 中的 Vercel AI 相关文件（如果存在） | `git status` 不见这些文件 |
| 0.0.5 | **验证新 SDK 装好**：`ls desktop-agent/node_modules/@anthropic-ai/claude-agent-sdk-{platform}/claude` | binary 存在 |
| 0.0.6 | **跑 typecheck**：`pnpm -F desktop-agent typecheck`（老代码可能错，预期） | 记录错误列表 |
| 0.0.7 | **检查点汇报**：删除/新增文件清单、剩余 typecheck 错误列表 | 确认无误后进 §10.1.1 |

**修改后预期**：

```diff
- desktop-agent/src/llm.ts          (Vercel 抽象)
- desktop-agent/src/agent.ts        (含 buildStreamFn)
- desktop-agent/src/mastra/         (Mastra 框架)
+ desktop-agent/node_modules/@anthropic-ai/claude-agent-sdk/  (新)
+ desktop-agent/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude  (binary)
```

**Typecheck 预期错误**（无需处理，进 §10.1 后会重写）：

```
src/index.ts: 找不到 './llm.js'              ← §10.1.1 后重写
src/index.ts: 找不到 './agent.js'            ← §10.1.1 后重写
src/apps/bot-chat/routes.ts: 旧 buildStreamFn 不存在  ← §10.2.1 后重写
```

> **设计文档使命**：本文档**不**假设"从 Vercel SDK 迁移"是默认路径。§10.1.1 专为全新仓库设计（从零创建项目），§10.0.1 仅作为**兼容旧项目的可选环节**。**其他团队参考本设计文档时，直接跳到 §10.1.1 即可**。

---

### 10.1 Phase 1：Platform 进程骨架（v0.1.0）

#### 10.1.1 仓库初始化（10 min，**从零开始**）

> **前置条件**：
> - 全新空目录（或 `git init` 后的空仓库）
> - Node.js ≥ 22.3.0 已装（`node --version` 验证）
> - pnpm ≥ 9.x 已装（`pnpm --version` 验证）
>
> **如果是从 v0.1 旧仓库（Vercel AI SDK）迁移**：先执行 §10.0.1 Pre-Phase 0，完成后跳回本节。

**目标产出**：一个 pnpm workspace，根包 + 1 个子包（`desktop-agent`），子包装好 Claude Agent SDK 和工具链。

| 步骤 | 任务 | DoD |
|------|------|-----|
| 1.1.1 | 创建仓库根目录结构 | `tree -L 3 -I 'node_modules'` 输出与 §4.1 一致 |
| 1.1.2 | 写仓库根 `package.json`（workspace 根）| `pnpm install` 在根目录跑通 |
| 1.1.3 | 写 `pnpm-workspace.yaml` | `pnpm -r ls` 列出 desktop-agent |
| 1.1.4 | 写 `desktop-agent/package.json`（子包）| 子包依赖被根 install 装上 |
| 1.1.5 | 写 `desktop-agent/tsconfig.json` | `pnpm -F desktop-agent typecheck` 通过（空 src/ 也过）|
| 1.1.6 | 装依赖 | `node_modules/@anthropic-ai/claude-agent-sdk-{platform}/claude` 存在 |

**步骤详解**：

**1.1.1 创建目录结构**

```bash
mkdir -p desktopwork/{docs/{product,technical},src-tauri,desktop-agent/{src/{platform,ai,apps/{bot-chat,settings}},apps/{bot-chat,settings,_shared},test},.github/workflows}

cd desktopwork
git init
```

**1.1.2 仓库根 `package.json`**

```json
{
  "name": "desktopwork",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev":          "pnpm -F desktop-agent dev",
    "build":        "pnpm -F desktop-agent build",
    "typecheck":    "pnpm -r typecheck",
    "test:smoke":   "pnpm -F desktop-agent test:smoke",
    "tauri":        "pnpm tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.x",
    "typescript":      "^5.x"
  },
  "packageManager": "pnpm@9.x"
}
```

**1.1.3 `pnpm-workspace.yaml`**

```yaml
packages:
  - 'desktop-agent'
  # 'src-tauri'  # v0.2 才有
```

**1.1.4 `desktop-agent/package.json`**

```json
{
  "name": "desktop-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev":        "tsx watch src/index.ts",
    "build":      "tsc -p tsconfig.build.json",
    "typecheck":  "tsc --noEmit",
    "start":      "node dist/index.js",
    "test:smoke": "node test/smoke.mjs",
    "predev":     "bash scripts/ensure-node.sh"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.174",
    "express":  "^4.21.x",
    "cors":     "^2.8.x",
    "zod":      "^3.23.x"
  },
  "devDependencies": {
    "@types/express": "^5.x",
    "@types/cors":    "^2.x",
    "tsx":            "^4.x",
    "typescript":     "^5.x"
  }
}
```

**1.1.5 `desktop-agent/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target":             "ES2022",
    "module":             "NodeNext",
    "moduleResolution":   "NodeNext",
    "esModuleInterop":    true,
    "strict":             true,
    "skipLibCheck":       true,
    "outDir":             "./dist",
    "rootDir":            "./src",
    "resolveJsonModule":  true,
    "declaration":        false,
    "sourceMap":          true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

外加 `desktop-agent/tsconfig.build.json`（产出 .d.ts 但不打包）：

```json
{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": false } }
```

**1.1.6 装依赖**

```bash
cd desktopwork
pnpm install
```

**DoD 验证**：

```bash
# Claude Agent SDK 装好
ls desktop-agent/node_modules/@anthropic-ai/claude-agent-sdk
# 输出: ... 看到 package.json 就行

# 平台 binary 装好
ls desktop-agent/node_modules/@anthropic-ai/claude-agent-sdk-*/claude
# Linux 输出: .../claude-agent-sdk-linux-x64/claude
# macOS: claude-agent-sdk-darwin-arm64/claude 或 darwin-x64/claude

# typecheck 过（src/ 还空但配置已就位）
pnpm -F desktop-agent typecheck
# 输出: 零错误
```

**检查点**：
- 仓库结构与 §4.1 完全一致
- 根 `package.json` + `desktop-agent/package.json` + `pnpm-workspace.yaml` + `tsconfig.json` 四个文件就位
- SDK 平台 binary 已自动下载到正确路径
- **向 Benjamin 汇报**：仓库根目录结构、依赖列表、typecheck 结果
- 确认无误后进 §10.1.2

#### 10.1.2 Platform 核心模块（20 min）

**依赖**：1.1.1 完成

| 步骤 | 任务 | DoD |
|------|------|-----|
| 1.2.1 | 实现 `src/platform/types.ts`：`DesktopWorkConfig` 接口（含 `agent` 字段，详见 §5.3）| tsc 通过 |
| 1.2.2 | 实现 `src/platform/config.ts`：`loadConfig()`、`get()`、`update()`；**不缓存**（per-request 读）| curl PUT/GET `/api/platform/config` 返 200 |
| 1.2.3 | 实现 `src/platform/auth.ts`：HMAC token + 端口限制 127.0.0.1 | curl 无 token 返 401 |
| 1.2.4 | 实现 `src/platform/app-registry.ts`：App 注册接口、`registerApp()`、`mountRoutes()` | 单元测试：注册 1 个 App 后 `mountRoutes(app)` 成功 |
| 1.2.5 | 实现 `src/router.ts`：Platform 路由 + App 路由动态挂载 | curl 任意 `/api/platform/*` 返 200 |
| 1.2.6 | 实现 `src/index.ts`：启动 HTTP server（端口 3737）+ 路由挂载 + 优雅退出 | `pnpm dev` 启动后 `curl http://127.0.0.1:3737/api/platform/health` 返 200 |

**注意**：**不实现** `src/platform/storage.ts` 抽象层（MVP 直接用 `node:fs/promises`；抽象推到 v0.4）。

#### 10.1.3 AI 层实现（25 min）

**依赖**：1.1.2 + 1.2 完成

| 步骤 | 任务 | DoD |
|------|------|-----|
| 1.3.1 | 实现 `src/ai/types.ts`：`AgentStreamEvent` union 类型（见 §5.6.4）| tsc 通过 |
| 1.3.2 | 实现 `src/ai/agent-service.ts`：`AgentService` 类 + `buildEnv()` + 导出 `PLATFORM_CWD`（见 §5.6.1）| tsc 通过；方法可用 |
| 1.3.3 | 实现 `src/ai/event-converter.ts`：`convertSDKMessage()` 转换函数（见 §5.6.3）| tsc 通过 |
| 1.3.4 | 实现 `src/ai/startup-warmer.ts`：`prewarmClaude()`、`getWarmQuery()`、`invalidateWarmQuery()`（见 §5.6.2）| tsc 通过 |
| 1.3.5 | 集成到 `src/index.ts`：进程启动时调 `prewarmClaude()`，失败仅 log | dev 启动后看到 `[claude] subprocess prewarmed` |

**注意**：v0.1 **不**实现 `src/ai/session-store.ts`（§3.8 决策：平台不存 session 状态）。Bot Chat 后端直接调 SDK 的 `listSessions` / `getSessionMessages` / `deleteSession` / `renameSession`（见 §10.2.1）。

#### 10.1.4 SDK Smoke 测试套件（15 min）

**依赖**：1.3 完成

| 步骤 | 任务 | DoD |
|------|------|-----|
| 1.4.1 | 在 `desktop-agent/test/` 下创建 `smoke.mjs` 脚本（复用附录 A 的 4 项测试）| 脚本能独立运行 |
| 1.4.2 | 脚本读取测试端点（用 minimax 凭据 from env），调 AgentService | 返非空 session_id |
| 1.4.3 | 脚本输出 PASS/FAIL 总结码 | `node test/smoke.mjs` 退码 0 |
| 1.4.4 | 写入 `package.json` 的 `test:smoke` script | `pnpm run test:smoke` 可调 |

**Smoke 4 项断言**（复用附录 A 验证）：
1. `query()` 返真实文本
2. resume 能续接上轮上下文
3. `includePartialMessages: true` 拿到 stream_event
4. `getSessionMessages(sessionId, { dir })` 返完整消息

### 10.2 Phase 2：Bot Chat App（v0.1.0）

#### 10.2.1 Bot Chat 后端（15 min）

**依赖**：Phase 1 全部完成

| 步骤 | 任务 | DoD |
|------|------|-----|
| 2.1.1 | 创建 `src/apps/bot-chat/types.ts`、`src/apps/bot-chat/service.ts`（调用 AgentService.stream）| tsc 通过 |
| 2.1.2 | 实现 `src/apps/bot-chat/routes.ts`：<br>• `POST /api/bot-chat/chat`（SSE 流式；`sessionId` 可选，undefined = 新会话）<br>• `GET /api/bot-chat/sessions`（调 SDK `listSessions({ dir: PLATFORM_CWD })`）<br>• `GET /api/bot-chat/sessions/:sdkSessionId`（调 SDK `getSessionMessages(id, { dir })`）<br>• `DELETE /api/bot-chat/sessions/:sdkSessionId`（调 SDK `deleteSession`）<br>• `PUT /api/bot-chat/sessions/:sdkSessionId`（rename，调用 SDK `renameSession`）| curl 5 个端点都返 200 |
| 2.1.3 | 在 `src/index.ts` `mountRoutes(app)` 时注册 bot-chat App | dev 启动后端点可访问 |
| 2.1.4 | **手动验证**：curl `POST /api/bot-chat/chat` 能拿到 `session_id` + `text_delta` 流 + `session_done` | 收尾事件 `cost > 0` |

#### 10.2.2 Bot Chat 前端（最小版，30 min）

**依赖**：2.1 完成

| 步骤 | 任务 | DoD |
|------|------|-----|
| 2.2.1 | 创建 `apps/bot-chat/index.html`（**纯 HTML/JS，无框架**）：input + 消息区 + 发送按钮 | 文件可访问 |
| 2.2.2 | JS 用 `fetch` + `EventSource` 调用 `/api/bot-chat/chat` | 收到 `text_delta` 即时追加到消息区 |
| 2.2.3 | 把 `apps/bot-chat/index.html` 暴露为 `GET /apps/bot-chat/` 静态路由 | curl `/apps/bot-chat/` 返 HTML |
| 2.2.4 | **Playwright 验证**（必走 §SPECS/playwright-ui-review-guide）：<br>① 打开页面，看到 input + 空消息区<br>② 输入"Hello"，点发送<br>③ 看到消息区逐步出现文本（流式）<br>④ 看到 `session_done` 后出现"已完成"标记 | 4 步全过；零 console error |

**注意**：MVP 前端**不引 React**（Tauri 前端再引）；纯 HTML+JS 够用。

### 10.3 Phase 3：Settings App（v0.1.0）

#### 10.3.1 Settings 后端 + 前端（20 min）

**依赖**：Phase 1 全部完成（不需要 Phase 2）

| 步骤 | 任务 | DoD |
|------|------|-----|
| 3.1.1 | 实现 `src/apps/settings/routes.ts`：<br>• `GET /api/settings/config`（返当前 config）<br>• `PUT /api/settings/config`（更新部分字段：apiKey、baseUrl、model）<br>**注意**：不重启 Platform 进程，下次 query 自动用新值（已验证）| curl 两个端点都返 200 |
| 3.1.2 | 创建 `apps/settings/index.html`：表单（API Key 框、Base URL 框、模型下拉、保存按钮）| 浏览器可访问 |
| 3.1.3 | JS 调 PUT 保存配置，前端显示"已保存"提示 | 保存成功 |
| 3.1.4 | **Playwright 验证**：<br>① 打开 settings 页<br>② 改 baseUrl 为 `https://api.minimaxi.com/anthropic` + 填入 apiKey<br>③ 保存，提示"已保存"<br>④ 切到 bot-chat 页，发消息<br>⑤ 看到走的是新 Provider（看请求日志或 token 消耗）| 5 步全过；**不重启 app** 验证热更新 |

### 10.4 Phase 4：端到端集成验证（v0.1.0）

**依赖**：Phase 1-3 全部完成

| 场景 | 验证内容 | DoD |
|------|---------|-----|
| **S1. 基本对话** | bot-chat 发消息，收到流式文本 | 一次对话完成 |
| **S2. Session 续接** | 同一 sdkSessionId 发第二条消息，模型记得第一条上下文 | SDK resume 成功 |
| **S3. 双 Provider 切换** | 先 Anthropic 走通 → 改 settings → 切 MiniMax → 新对话走 MiniMax | 两个 Provider 都验证 |
| **S4. Tool 使用** | 发"读一下 /tmp/foo.txt"，模型调用 Read 工具，读到内容 | tool_use 完整流程通过 |

每个场景过 = Phase 4 完成。

### 10.5 Phase 5：CI 与跨平台构建（v0.1.0）

> **⚠️ 重要**：本节在 2026-06-16 经实测重写，反映 §9.13 v0.3.1 修正设计（含完整 Node sidecar 实现）。原来的 §10.5 步骤 5.1.3/5.1.4/5.1.5/5.1.6 与 §9 v0.2 设计意图一致但**未能跑通**，原因见 §9.13.1。

**依赖**：Phase 1-4 全部完成

| 步骤 | 任务 | DoD |
|------|------|-----|
| 5.1.1 | 修 `shell/src-tauri/tauri.conf.json` 对齐 §9.13.3（**不设 frontendDist，不设 url，resources 用 ["server"]，externalBin = ["../node-binaries/node-${platform}"]**）| tauri info 跑通 |
| 5.1.2 | 修 `shell/src-tauri/src/main.rs` 对齐 §9.13.4（**去掉硬编码路径，加 `DESKTOPWORK_DEV_ENTRY` env，prod 用 Tauri 2 sidecar API**）| cargo build 成功 |
| 5.1.3 | **【重点】重写 `.github/workflows/build.yml`** 对齐 §9.13.6：<br>• `cargo install tauri-cli --version "^2.0.0" --locked`（**不**用 npm/pnpm 装 tauri-cli）<br>• **新增 Node sidecar 下载 step**：curl nodejs.org → `shell/node-binaries/node-{platform}` + `actions/cache@v4`<br>• `pnpm install`（不带 --no-lockfile，用仓库 lockfile）<br>• `pnpm -F desktop-agent typecheck` + `build`<br>• `pnpm deploy --filter desktop-agent --prod --legacy shell/src-tauri/server`<br>• `cargo tauri build --config shell/src-tauri/tauri.conf.json`（**绝对路径**）<br>• 上传 `target/release/bundle/{nsis,dmg}/*` artifact，加 `if-no-files-found: error`<br>• **删掉**所有 debug step（"Debug Tauri setup" 等）| macOS + Windows runner 都产出 installer |
| 5.1.4 | **【手动验证】**  本地 `cargo tauri build --config shell/src-tauri/tauri.conf.json`（限 macOS dev 机）<br>• 产出 .app 和 .dmg<br>• 双击 .app 启动，Tauri 弹窗、splash → Node ready（sidecar 启动） → navigate 到 dashboard<br>• 手动 chat 一轮验证 AI 响应 | .dmg 能安装、能启动、能 AI 聊天 |
| 5.1.5 | **【Windows 验证】**  在 Windows runner 上 build + 手动安装 .exe：<br>• NSIS 安装器运行<br>• 安装后双击启动，验证 spawn sidecar `node-windows-x64.exe` + health check + AI 响应 | .exe 能安装、能启动、能 AI 聊天 |
| 5.1.6 | **【自包含验证】**  在干净虚拟机上装 .dmg/.exe（**没有 Node**），启动应用，验证 Node sidecar 自启、AI 响应 | 应用完全自包含，不需要宿主 Node |

**§10.5 调试决策树**（CI 失败时第一看哪里）见 §9.13.8。

### 10.6 测试凭据约定

Smoke 测试用 minimax 凭据（已验证兼容 Anthropic 协议）。**凭据不入仓库**，从环境变量读：

```bash
# 本地开发：临时 export
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
export ANTHROPIC_AUTH_TOKEN=*** # 从 ~/.openclaw/auth-profiles.json
pnpm run test:smoke

# CI：用 GitHub Secrets
#   ANTHROPIC_BASE_URL
#   ANTHROPIC_AUTH_TOKEN
```

### 10.7 未来迭代（v0.2+）

| 版本 | 关键内容 |
|------|---------|
| v0.2 | MCP 自定义工具（`tool()` + `createSdkMcpServer()`）、Tauri 内 React 渲染、API Key 加密（`keytar`）|
| v0.3 | 日历、待办等内置 App；多 App 共享同一 session |
| v0.4 | Memory 知识库（`lancedb` / `chromadb`）、session compaction |
| v0.5 | 本地 App 加载、App 市场（PRD-AGENTS.md 范围）|
| **后续实测** | Windows 编码规则实测（待 Windows 机器上运行验证；Linux 已实测）|

---

## 十一、风险与对策

| 风险 | 影响 | 对策 | 验证 |
|------|------|------|------|
| SDK API 不稳定（0.3.x 版本）| 升级困难 | 封装一层 `agent-service.ts`，隔离 SDK 细节 | — |
| **Subprocess 启动开销** | 首响延迟 ~2s | 用 `startup()` 预热；warmQuery 复用 | ✅ 2026-06-12：预热后 < 1s |
| **平台 binary 体积**（~4.7MB/平台）| Tauri 包增大 | 接受；可选优化为运行时下载 | — |
| **Anthropic 协议锁定** | 不支持 OpenAI 直连 | v0.1 接受；v0.3+ 考虑 LiteLLM 中转 | — |
| env var 替换（不合并 process.env）| 子进程缺 PATH/HOME | `buildEnv()` 必须 `...process.env` 展开 | ✅ 2026-06-12 验证 |
| Session 文件膨胀 | 性能下降 | v0.4+ 实现 compaction 逻辑 | — |
| Tauri 与 Node 进程管理 | 进程崩溃/泄漏 | 实现 watchdog、健康检查、自动重启 | — |
| Token 安全 | 误调 API | 简化版 token + 端口仅监听 127.0.0.1 | — |
| Claude 内部 session 与平台 session 不同步 | 多轮对话混乱 | 显式记录 SDK session_id 到平台 session，续接时传入 | ✅ 2026-06-12：resume 验证 |
| 第三方 Provider 协议差异 | 配置失败 | 提供文档 + MiniMax / GLM 预设配置 | — |

---

## 附录 A：Claude Agent SDK 验证记录（2026-06-12）

> **状态**：✅ 全部通过
> **执行人**：Ben
> **测试包**：`@anthropic-ai/claude-agent-sdk@0.3.174`
> **测试端点**：`https://api.minimaxi.com/anthropic`（Anthropic 兼容 Provider）

### A.1 测试目的

1. 验证 SDK 可用性（subprocess 是否正常启动）
2. 验证 `env` 机制（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 是否生效）
3. 验证流式输出（`includePartialMessages` 是否拿到 `text_delta`）
4. 验证 session 续接（`resume` 是否保留上下文）
5. 验证 model 切换（`options.model` 是否被接受）

### A.2 测试结果

| # | 测试 | 结果 | 关键数据 |
|---|------|------|---------|
| 1 | 基本 query + env 路由 | ✅ PASS | 端点 `api.minimaxi.com/anthropic` 返回真实回复 `PONG_7842`，2.2s |
| 2 | 首次对话 + session_id | ✅ PASS | session_id = `c4d2df1a-01fd-4ef9-b5e1-8042816cb95a` |
| 3 | `resume` 续接 | ✅ PASS | 模型记住 `BLUE-PARROT-42`，1.3s |
| 4 | `options.model` 切换 | ✅ PASS | `MiniMax-M2.7` 被接受，1.9s |
| 5 | `includePartialMessages: true` 流式 | ✅ PASS | 18 events：system x4, stream_event x11, assistant x2, result x1 |

### A.3 关键发现

#### 1. Env 机制（确认）

- `env.ANTHROPIC_BASE_URL` 路由到 `https://api.minimaxi.com/anthropic` ✅
- `env.ANTHROPIC_AUTH_TOKEN` 鉴权通过 ✅
- 不会影响用户登录态（走 API key 模式）

#### 2. 性能基线

| 场景 | 耗时 | 备注 |
|------|------|------|
| 首次启动 + 第一次 query | 2.2s | 含 subprocess 启动 |
| Resume 续接 | 1.3s | session 复用 |
| 切模型 | 1.9s | 新 session |

**`startup()` 预热后首响 < 1s**（v0.1 实测目标）

#### 3. 流式输出

- 默认 `query()` → 返回完整 assistant message
- `options.includePartialMessages: true` → 拿到 `stream_event` 增量事件
- 增量结构：`stream_event.event.type === 'content_block_delta'` + `event.delta.type === 'text_delta'` + `event.delta.text`

#### 4. 协议兼容

- MiniMax (`api.minimaxi.com/anthropic`) 完全兼容 Anthropic Messages 协议
- 所有 Claude Agent SDK 工具/能力可平移
- 第三方 Anthropic 协议 provider 不用额外适配

#### 5. Subprocess 细节

- 平台 binary 自动下载：`@anthropic-ai/claude-agent-sdk-linux-x64` 装好后路径在 `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`
- 单平台 4.7MB；bun/deno/node 三种 runtime 可选
- stdio JSON-RPC 通信，Node.js 主进程拿到的是 async iterable

### A.4 测试代码（已归档 `/tmp/agent-sdk-test/`）

```typescript
// test.mjs - 核心 smoke test
import { query } from '@anthropic-ai/claude-agent-sdk';

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
  ANTHROPIC_AUTH_TOKEN: *** // redacted
};

const q = query({
  prompt: 'Reply with exactly: PONG_<4 digits>.',
  options: { tools: [], allowedTools: [], maxTurns: 1, env },
});

for await (const msg of q) {
  // 收到 6 messages：system x3, assistant x2, result x1
  // totalText = "PONG_7842"
}
```

### A.5 实测对设计的影响

| 原设计 | 实测后修正 |
|--------|-----------|
| `import { query } from '@anthropic-ai/claude-code'` | → `import { query } from '@anthropic-ai/claude-agent-sdk'` |
| "In-process SDK" | → Subprocess（stdio JSON-RPC） |
| `applyLlmConfigToEnv`（启动时设 env）| → per-request 构造 env 对象 |
| 默认流式输出 | → 必须 `includePartialMessages: true` |

---

## 附录 B：第三方 LLM Provider 配置示例

### B.1 Anthropic 官方

```json
{
  "agent": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": "sk-ant-***"
  }
}
```

Platform 进程构造 env：
```bash
ANTHROPIC_AUTH_TOKEN=sk-ant-***
# ANTHROPIC_BASE_URL 留空，使用默认 https://api.anthropic.com
```

### B.2 MiniMax（已验证）★

```json
{
  "agent": {
    "provider": "custom",
    "model": "MiniMax-M3",
    "apiKey": "sk-cp-***",
    "baseUrl": "https://api.minimaxi.com/anthropic"
  }
}
```

Platform 进程构造 env：
```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
ANTHROPIC_AUTH_TOKEN=sk-cp-***
```

**2026-06-12 验证通过**：基本对话、流式输出、session 续接、模型切换均工作。

### B.3 GLM / DeepSeek（Anthropic 协议网关）

```json
{
  "agent": {
    "provider": "custom",
    "model": "glm-4-plus",
    "apiKey": "***",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic"
  }
}
```

### B.4 LiteLLM 代理（OpenAI 转 Anthropic）

```json
{
  "agent": {
    "provider": "custom",
    "model": "gpt-4o",
    "apiKey": "***",
    "baseUrl": "http://localhost:4000"
  }
}
```

需要用户先启动 LiteLLM（暴露 Anthropic 端点）：
```bash
litellm --model gpt-4o --port 4000
```

### B.5 不支持场景（v0.1）

- ❌ OpenAI 直连（`https://api.openai.com/v1`）——协议不匹配
- ❌ Ollama / LM Studio ——协议不匹配
- ❌ 自定义 JSON Schema 的 OpenAI 兼容服务 ——需 LiteLLM 中转

---

## 变更历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-06-11 | 0.1 | 初稿（基于假设的 `@anthropic-ai/claude-code` SDK） |
| 2026-06-12 | 0.2 | **重大重写**：（1）包名修正为 `@anthropic-ai/claude-agent-sdk`；（2）改为 subprocess 集成模型；（3）LLM 配置改为 per-request env 构造；（4）新增流式机制说明；（5）完成 SDK 端到端验证（附录 A）；（6）**Session 管理明确：完整采用 Claude SDK 自带 session 机制**；7）**Session 修订 2：进一步删除 `sessionKey ↔ sdkSessionId` 映射，平台侧零 session 状态**（验证 SDK 7 个 session API）；（8）流式输出 §3.7 加明确结论段；（9）跨平台 cwd 编码规则按 Linux 实测，Windows 编码待实现后实测验证；（10）§9 重写为「打包与分发」，明确 Tauri sidecar + 资源拷贝 + 健康检查 + 跨平台 CI（NSIS/DMG）；（11）§5.8 新增路径解析模块，实现 dev/prod 路径一致（遵循 P3 原则）|
| 2026-06-16 | 0.3 | **§9 打包架构实测修正**：（1）放弃 Node sidecar，v0.1 改用系统 PATH 的 node/tsx（v0.2+ 再上 sidecar）；（2）WebView 改用 splash data:URL → eval navigate 到 `http://127.0.0.1:3737/`（避免 Tauri 启动时 Node 未就绪的白屏）；（3）tauri.conf.json 不设 `frontendDist` 和 `app.windows[0].url`，避免与 navigate 冲突；（4）main.rs 去掉硬编码 `/mnt/d/projects/...` 路径，改用 `DESKTOPWORK_DEV_ENTRY` 环境变量 + 相对路径；（5）**CI tauri-cli 安装方式改为 `cargo install tauri-cli --version "^2.0.0" --locked`**，不用 npm/pnpm（解决 `tauri: command not found` 根因）；（6）`pnpm install` 不再带 `--no-lockfile`，用仓库 lockfile 保证可重现；（7）CI 用 `cargo tauri build --config <绝对路径>` 代替 `pnpm tauri build`，少一层间接；（8）删除所有临时 debug step（"Debug Tauri setup" 等）；（9）§9.13 列出 9 项 Gap 修正总览、§9.13.3 给出 tauri.conf.json 唯一正确版本、§9.13.4 给出 main.rs 路径解析、§9.13.6 给出 build.yml 唯一正确版本、§9.13.7 给出 8 项打包验证清单、§9.13.8 给出失败诊断决策树；（10）§10.5 重写对齐 §9.13 修正设计 |
| 2026-06-16 | 0.3.1.6 | **CI 第六次跑后实测修正（matrix 架构匹配）**：（1）§9.13.15 新增，记录 macOS runner 报 `resource path ... node-aarch64-apple-darwin doesn't exist` 的诊断；（2）问题 G：matrix 只加一个 macos-latest entry 但值是 x64 的，GitHub Actions 的 `macos-latest` 现在是 ARM64 架构，下载的 x64 binary tauri-build 找不到；（3）修正：matrix 加 2 个 macOS entry（macos-latest=ARM64 + macos-13=x86_64），跟 §9.9.1 设计对齐；（4）§9.13.1 修正总览表新增 Gap 17（matrix 架构不匹配）；（5）学习：macos-latest 可能是 ARM64 不要假设 x86_64；nodejs.org tarball 后缀（darwin-x64/darwin-arm64）跟 runner 架构需独立对应
