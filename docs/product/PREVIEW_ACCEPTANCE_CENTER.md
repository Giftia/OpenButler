# OpenButler Preview Acceptance Center

`OpenButler Preview` is the morning QA channel. It installs beside the stable desktop application and opens the latest local acceptance pack without replacing stable data or processes.

## User Flow

1. Open the Preview application in the morning.
2. Read the short summary of the previous night.
3. Follow each scenario's concrete steps and expected result.
4. Mark it `通过`, `有条件通过` or `不通过` and add a comment.
5. Send the generated approval or repair command to Codex.

The user approves product behavior, not merely green tests. Codex revalidates GitHub state before merging.

## Isolation

- Product: `OpenButler Preview`.
- App id: `moe.giftia.openbutler.preview`.
- Backend process: `openbutler-backend-preview.exe`.
- User data: separate `OpenButler Preview` directory.
- Installer cleanup targets Preview processes only.

## Data Boundary

The acceptance pack may contain Issue numbers, PR numbers, commit SHAs, test names, redacted summaries and known limitations. It must not contain real activity content, URLs, screenshot paths, local paths, databases, API keys or raw model/tool output.
