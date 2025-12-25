# Repository Guidelines

## Project Structure & Module Organization
- `src/index.js` contains the entire CLI/watch loop that polls Apple Music and updates Slack.
- No separate test or asset directories exist today.
- Configuration lives in environment variables read at startup (see `README.md` for the full list).

## Build, Test, and Development Commands
- `npm start` — runs the watcher with `node src/index.js`.
- `npm run lint` — runs `node --check src/index.js` for a fast syntax check.

## Coding Style & Naming Conventions
- JavaScript is CommonJS (`require`, `module.exports` not used here) and targets Node 16+.
- Indentation is 2 spaces; keep lines readable and avoid long inline ternaries.
- Use `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants.
- Keep logging user-facing and concise; prefer `console.error` for failures and `console.log` for status updates.

## Testing Guidelines
- No automated tests are present in this repository.
- If adding tests, document the framework and add a script in `package.json` (for example `npm test`).
- Keep test file names explicit (e.g., `index.test.js`) and cover Slack payload formatting and AppleScript parsing.

## Commit & Pull Request Guidelines
- Git history is not available in this workspace, so no established commit convention is detectable.
- Use short, imperative commit subjects (e.g., “Add dry-run logging”).
- PRs should include: a brief description, any new env vars, and sample output/logs when behavior changes.

## Security & Configuration Tips
- Never commit Slack user tokens; keep `SLACK_TOKEN` in the environment.
- Use `DRY_RUN=true` to validate formatting without calling Slack.
- The cache file defaults to `~/.slack-currenttrack-status.json`; set `STATUS_CACHE_FILE=""` to disable writes.
