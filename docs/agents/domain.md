# Domain Docs

OpenButler is currently a single-context repo for engineering-skill purposes.

## Before exploring, read these

- `AGENTS.md` for the current repository map, privacy red lines, and run/test commands.
- `docs/architecture/CURRENT_ARCHITECTURE.md` for the actual backend/frontend/api layout.
- `docs/architecture/REPO_STRUCTURE.md` for directory responsibilities.
- `docs/architecture/API_CONTRACTS.md` before changing API behavior.
- `docs/architecture/PLUGIN_RUNTIME.md` before changing plugin-related behavior.
- `docs/privacy/PRIVACY_BOUNDARIES.md` before touching user data, MineContext, evidence, strict mode, screenshots, or external calls.
- Relevant ADRs under `docs/architecture/decisions/`.

The repository does not currently use root-level `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/`. Do not create or migrate those files as part of ordinary engineering-skill setup. If future domain modeling needs a glossary, add it intentionally in a separate task.

## Layout

```text
/
├── AGENTS.md
├── backend/
├── frontend/
├── api/
├── docs/
│   ├── architecture/
│   │   ├── CURRENT_ARCHITECTURE.md
│   │   ├── REPO_STRUCTURE.md
│   │   ├── API_CONTRACTS.md
│   │   ├── PLUGIN_RUNTIME.md
│   │   └── decisions/
│   └── privacy/
│       └── PRIVACY_BOUNDARIES.md
└── .openbutler/
```

## Vocabulary and boundaries

Use the product and architecture vocabulary already established in `AGENTS.md` and `docs/product/`. For ordinary-user UX, prefer user-facing language such as "本地模式", "本机记录", "依据", and "管家提醒"; keep internal terms such as `MineContext`, `PCActivityEvent`, and raw source fields out of ordinary UI unless a document explicitly targets advanced diagnostics.

If a proposed change conflicts with an ADR under `docs/architecture/decisions/`, surface that conflict explicitly before implementing.
