# my-pi-setup

Public pi coding-agent configuration.

## Contents

- `settings.json` - default provider/model and package settings
- `extensions/codex-limits.ts` - status-bar extension for Codex usage limits
- `extensions/questions.ts` - reusable `ask_question` and `ask_multi_question` tools for structured user input
- `extensions/plan.ts` - guided planning mode that uses the reusable question tools

## Not included

Sensitive and local runtime data is intentionally ignored, including:

- `auth.json`
- `sessions/`
- `bin/`
