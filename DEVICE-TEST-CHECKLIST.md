# DesktopWork Claude 隔离 — 设备测试 Checklist

## 1. Fresh Install 流程
- [ ] 安装 DesktopWork
- [ ] 启动应用
- [ ] 在 UI 配置 API key（填入 sk-...）
- [ ] 验证：config.json 不含明文 apiKey，只含 apiKeyRef
- [ ] 验证：OS keychain 出现 `com.benjamin.desktopwork` > `anthropic` 条目
  - Mac: Keychain Access 搜索 `desktopwork`
  - Windows: 控制面板 → 凭据管理器 → Windows 凭据
  - Linux: seahorse 或 `secret-tool list`
- [ ] 关闭应用，重启
- [ ] 验证：API key 仍可用（重启后无需重新输入）

## 2. Upgrade 流程（从 v0.1 明文 config 升级）
- [ ] 在 v0.1 中配置好 API key（明文存在 config.json）
- [ ] 安装 v0.x 新版（覆盖 install dir）
- [ ] 启动应用
- [ ] 验证：控制台输出 `[config] Migrated plaintext apiKey to OS keychain`
- [ ] 验证：config.json 不含明文 apiKey，只含 apiKeyRef
- [ ] 验证：keychain 出现条目
- [ ] 验证：API key 仍可用

## 3. API Key Update 流程
- [ ] 在 UI 改 API key 为新值
- [ ] 验证：keychain 中条目已更新为新 key
- [ ] 验证：旧 key 不再可用（用旧 key 调 API 应该失败）
- [ ] 验证：新 session 使用新 key

## 4. CLAUDE_CONFIG_DIR 验证（独立 Claude）
- [ ] 启动应用
- [ ] 发一个 chat 消息
- [ ] 检查 `APP_DATA_DIR/.claude/projects/...` 有 session 文件
- [ ] 检查 `~/.claude/`（系统级）**没有**被 DesktopWork 写入任何文件
  - 注意：如果用户本机装了 Claude Code CLI，`~/.claude/` 可能有 CLI 自己的数据，这是正常的；关键是 DesktopWork 不会触碰它

## 5. Mac 升级保留配置（特别验证）
- [ ] 装 v0.1 → 配置好 → 装 v0.x（DMG 升级）
- [ ] 验证：`~/Library/Application Support/com.benjamin.desktopwork/` 内容还在
- [ ] 验证：API key 仍可用
- [ ] 验证：所有 session 历史可读

## 已知限制
- `CLAUDE_CONFIG_DIR` 是非官方 env var，行为可能因 SDK 版本变化（[GitHub issue #3833](https://github.com/anthropics/claude-code/issues/3833)）
- `RUNTIME_DIR/.claude/settings.local.json` 会存在（SDK 的本地工作区配置），在我们的私有目录内，可接受
- macOS sandbox 暂未启用（设计决策）