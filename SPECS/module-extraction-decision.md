# Module Extraction 决策文档

> **问题**：OpenClaw 的 npm 包（`@openclaw/agent-core`、`@openclaw/llm-core`、`@openclaw/memory-host-sdk`）未被 npm publish，DesktopWork 是独立项目，不在 OpenClaw pnpm workspace 内。如何在 DesktopWork 中使用 OpenClaw 代码？

## 1. 问题背景

OpenClaw 包私有且版本快速迭代，DesktopWork 需要：
1. **版本一致性** — 使用特定 commit 的 OpenClaw 代码，不依赖 npm latest
2. **零外部依赖** — 不依赖 OpenClaw npm publish（实际 E404）
3. **可审计** — bundle 文件纳入 git，commit 可溯源
4. **最小侵入** — 不修改 OpenClaw 源码

## 2. 候选方案

### 方案 A：npm link / path workspace

```
desktop-agent/package.json:
  "dependencies": {
    "@openclaw/agent-core": "workspace:*"
  }
```

**问题**：需要 OpenClaw 发布到 npm，或两个仓库放在同一 pnpm workspace。两者均不满足。

### 方案 B：npm pack + local tarball

```
npm pack @openclaw/agent-core --pack-destination /tmp
npm install /tmp/openclaw-agent-core-*.tgz
```

**问题**：每次 OpenClaw 更新都需要重新 pack + install，CI/CD 流程复杂。

### 方案 C：git submodule + 源码编译（最终采用）

```
vendor/openclaw/          ← git submodule，指向 OpenClaw 仓库
scripts/extract-openclaw.mjs  ← esbuild 提取工具
desktop-agent/vendor/bundles/  ← 提取后的 bundle（纳入 git）
```

**核心工作流**：
```
OpenClaw submodule (vendor/openclaw)
    ↓ git pull / checkout
scripts/extract-openclaw.mjs (esbuild)
    ↓ 提取 + bundle
desktop-agent/vendor/bundles/*.esm.js (纳入项目 git)
    ↓ Tauri bundle
最终安装包（不含 submodule）
```

**为什么不用 npm install**：因为 npm 上没有包。

**为什么不用 copy-paste**： submodule 保持了与上游的链接，可追踪版本。

## 3. 关键技术决策：ESM Bundle 的 require 问题

### 3.1 问题现象

提取 `memory-host-sdk` 时，dotenv（CJS 模块）在模块顶层执行 `require('fs')`：

```javascript
// dotenv/lib/main.js
const fs = require('fs')   // ← 模块加载时立即求值
```

esbuild 在 ESM bundle 中把这个调用变成：

```javascript
var __require = ((x) =>
  typeof require !== "undefined" ? require(x) :   // ← ESM 无全局 require
  throw Error('Dynamic require of "fs" is not supported')  // ← 总是抛错
)(...)
```

结果：bundle 加载时立即抛出 `Dynamic require of "fs" is not supported`。

### 3.2 候选解法

| 方案 | 做法 | 结果 |
|------|------|------|
| **A. `--external:node:fs`** | 让 esbuild 放行 node:fs | 失败 — esbuild 仍把 CJS `require('fs')` 变成 shim，shim 在 ESM 中检查 global require 而非使用 Node.js CJS loader |
| **B. `--format=cjs`** | 输出 CJS 而非 ESM | 失败 — memory-host-sdk 源码用了 `import.meta.url`，CJS 不兼容 |
| **C. 主项目依赖 dotenv** | desktop-agent 加 `"dotenv": "^16"` | 失败 — 主项目是 ESM，`require('dotenv')` 仍走 esbuild shim，且主项目本身不需要 dotenv |
| **D. 修改 OpenClaw 源码** | 替换 dotenv 为直接 readFileSync | 失败 — 需要改 OpenClaw 源码，违反"最小侵入"原则 |
| **E. `--inject` require shim** | 注入 `globalThis.require = createRequire(...)` | ✅ **成功** — shim 在 bundle 加载前提供全局 require，dotenv 的 `require('fs')` 正常执行 |

### 3.3 结论

**方案 E（`--inject` require shim）是唯一无需修改 OpenClaw 源码的可行方案。**

原理：dotenv 的问题是它在 **CJS 模块顶层**的 `require('fs')` 调用。在 ESM 打包场景下，这个模式本质上就需要一个运行时 polyfill。`--inject` 正是提供了这个 polyfill，且只在 esbuild 层面修改 bundle，不影响 OpenClaw 源码。

注入文件（`scripts/require-shim.mjs`）：
```javascript
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
globalThis.require = req;
globalThis.__require = req;
```

### 3.4 为什么不担心"hack 感"

1. **dotenv 是问题根源** — OpenClaw 使用 CJS 模块（dotenv）且在顶层 `require('fs')`，这是 dotenv 的设计选择，非 OpenClaw 本身的问题
2. **shim 是一次性注入** — 注入代码在 bundle 加载前执行，不影响 bundle 内部逻辑
3. **esbuild 官方支持 `--inject`** — 这是 esbuild 的正式特性，非黑魔法
4. **无更好替代** — 其他方案都需要修改 OpenClaw 源码或放弃使用 dotenv，代价更高

## 4. 提取工具设计

### 4.1 入口点选择

memory-host-sdk 有两个可能的入口点：

| 入口 | 导出 | 问题 |
|------|------|------|
| `src/engine.ts` | 重导出为主 | dotenv 依赖在深层，`require('fs')` 加载时立即执行 |
| `src/runtime.ts` | 底层工具函数 | 无 dotenv 依赖，可以正常加载 |

最终选择 `src/runtime.ts`，导出：
- `loadConfig`、`getRuntimeConfig`
- `buildActiveMemoryPromptSection`
- `getMemoryCapabilityRegistration`
- `resolveStateDir`、`listMemoryFiles`

### 4.2 各 Bundle 入口点

| Bundle | 入口文件 | external | inject |
|--------|----------|----------|--------|
| llm-core | `src/index.ts` | （无） | （无） |
| agent-core | `src/index.ts` | `ignore`、`yaml` | （无） |
| memory-host-sdk | `src/runtime.ts` | （无） | `scripts/require-shim.mjs` |

### 4.3 为什么不 external 所有 node 内建模块

对于 agent-core 和 llm-core，我们 external 了 `ignore` 和 `yaml`（因为它们是纯 JS 的可选依赖）。但 `fs`、`path`、`crypto` 等 node 内建模块没有 external，原因是：

- 它们是 Node.js 内建模块，不存在"加载失败"的问题
- esbuild 会将它们的引用保留为 `node:fs` / `node:crypto` 等，在 Node.js ESM 中直接可用

## 5. 文件结构

```
desktopwork/
├── scripts/
│   └── extract-openclaw.mjs     ← 提取工具
└── desktop-agent/
    └── vendor/
        └── bundles/           ← 提取后的 bundle（纳入 git）
            ├── llm-core.esm.js
            ├── agent-core.esm.js
            ├── memory-host-sdk.esm.js
            └── OPENCLAW_VERSIONS.json
```

**当前实现**：`vendor/openclaw/` 已初始化（包含 packages/llm-core、agent-core、memory-host-sdk），`scripts/require-shim.mjs` 位于项目内。提取工具默认使用 `vendor/openclaw`，不再依赖外部目录。

**完整结构**：
```
desktopwork/
├── vendor/
│   └── openclaw/              ← OpenClaw 包副本（含 packages/llm-core、agent-core、memory-host-sdk）
├── scripts/
│   ├── extract-openclaw.mjs     ← 提取工具
│   └── require-shim.mjs ← ESM require shim（项目内）
└── desktop-agent/
    └── vendor/
        └── bundles/           ← 提取后的 bundle（纳入 git）
```

**关键点**：
- `require-shim.mjs` 位于 `scripts/`（项目内），不随 OpenClaw 包副本更新
- 提取工具通过 `--inject scripts/require-shim.mjs` 注入
- bundle 文件本身不包含 shim 源码（运行时注入生效）
- **注意**：当前 `vendor/openclaw/` 仅包含需要提取的包源码，不含完整 node_modules。提取时需保证 desktop-agent 的 `node_modules` 中有所需依赖（typebox 等）

## 6. 更新流程

```bash
# 1. 更新 submodule 到目标 commit
cd vendor/openclaw && git pull origin main

# 2. 重新提取 bundle
node scripts/extract-openclaw.mjs \
  --openclaw vendor/openclaw \
  --out desktop-agent/vendor/bundles

# 3. 验证 bundle 可加载
node --input-type=module --eval "
import * as mem from 'desktop-agent/vendor/bundles/memory-host-sdk.esm.js';
console.log('buildActiveMemoryPromptSection:', typeof mem.buildActiveMemoryPromptSection);
"

# 4. 提交
git add desktop-agent/vendor/bundles vendor/openclaw
git commit -m "chore: update OpenClaw bundle to $(git -C vendor/openclaw rev-parse --short HEAD)"
```

## 7. 已知限制

1. **memory-host-sdk 的 `createEngine` 不存在** — 设计文档曾假设 memory-host-sdk 导出一个 `createEngine` 工厂函数，实际它只导出底层工具函数。DesktopWork 的 session 持久化使用 agent-core 的 `JsonlSessionStorage`，memory prompt 构建使用 `buildActiveMemoryPromptSection`。

2. **dotenv 依赖** — memory-host-sdk 深层依赖 dotenv（通过 `src/config/config.ts` → `src/infra/dotenv.ts` → dotenv），这是 OpenClaw 的架构选择，不可避免。

3. **bundle 体积** — memory-host-sdk 当前约 7.6MB（包含 sqlite-vec 和所有 embedding providers）。如需减小体积，可考虑按 provider 拆分提取，但目前优先级不高。
