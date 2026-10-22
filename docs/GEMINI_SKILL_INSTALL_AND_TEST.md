# Gemini Skills: Install and Verify

This repository includes workspace Agent Skills for Gemini CLI in `.gemini/skills/`. They are version-controlled instructions; adding them to GitHub does not by itself install them on a device or activate them in Google AI Studio / Gemini web.

## Included skills

- `heavenzfire-provenance-auditor`: evidence-led provenance, licensing, and integrity reviews.
- `heavenzfire-operationalizer`: convert prototypes and placeholders into tested working implementations.
- `heavenzfire-sovereign-federation`: provider adapters, least privilege, portability, and audited federation.

## Install for Gemini CLI

From a clone of this repository, run in PowerShell:

```powershell
gemini skills list
gemini skills install https://github.com/HeavenzFire/UnifiedCodebase --path .gemini/skills/heavenzfire-provenance-auditor --scope user
gemini skills install https://github.com/HeavenzFire/UnifiedCodebase --path .gemini/skills/heavenzfire-operationalizer --scope user
gemini skills install https://github.com/HeavenzFire/UnifiedCodebase --path .gemini/skills/heavenzfire-sovereign-federation --scope user
gemini skills list
```

If the installed CLI does not accept `--path` in this form, use the documented `gemini skills install` syntax for the installed version or run `gemini skills link <local-skill-directory>`. Do not use `--consent` to bypass the skill review prompt by default.

## Workspace use

When working inside this repository, Gemini CLI can discover skills under `.gemini/skills/`. Start a new CLI session or run `/skills reload`, then inspect `/skills list`. Review and approve activation prompts deliberately.

## Verification protocol

1. Confirm each `SKILL.md` has YAML frontmatter with a unique lowercase hyphenated `name` and a useful `description`.
2. Run `gemini skills list` and confirm the names appear in the expected scope.
3. Ask Gemini CLI to perform a harmless repository inventory and state which skill it activated.
4. Verify it reports evidence-backed statuses and does not claim an unrun test passed.
5. Do not treat successful skill discovery as proof that Gemini API, AI Studio, Search AI Mode, local agents, or desktop execution are connected. Test each integration separately.

## Status at commit time

The skill files are committed artifacts. Device installation and live activation are separate verification steps and remain unverified until run on the user's machine.
