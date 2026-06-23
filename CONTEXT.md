# OpenButler Domain Context

This file records product-domain vocabulary only. It is not an implementation spec.

## Glossary

### 私人整理管家

The canonical product identity for OpenButler.

OpenButler is a local-first desktop butler that helps a user understand what happened today, what deserves attention, and what to do next. It should feel like a patient personal organizer, not a technical control panel.

Avoid using "全功能管理后台" or "技术控制台" as the ordinary-user framing.

### 样例体验

The public or first-run mode that shows how OpenButler works without reading the user's real local data.

It must be clearly marked with wording like "样例体验，未读取你的真实数据。" Do not use developer words such as `mock`, `seed`, `fixture`, or "Vercel demo" in ordinary UI.

### 本地模式

The real personal-data mode that runs on the user's own computer.

It requires explicit user action before reading local signals. It must explain what will be read, what will not be read, and what can be turned off.

### 本机记录组件

The ordinary-user term for the local observation component that provides authorized computer activity records.

The underlying implementation may use MineContext, but the name "MineContext" should appear only in advanced details, diagnostics, documentation, or developer-facing flows.

### 智能整理钥匙

The ordinary-user term for the model provider API key or model configuration needed for local intelligent organization.

The product must explain where a user can obtain this key, what it is used for, and that costs and terms belong to the selected provider.

### 依据层

The trust layer that explains why a reminder, timeline event, or answer exists.

Ordinary UI should show source, confidence, boundary, and privacy notes. Internal IDs, raw refs, screenshot paths, source event IDs, and raw payloads belong only in advanced diagnostics.

### 今日中控

The daily command center view.

It should answer three questions first: what was organized today, what deserves attention, and what the user can do next.

