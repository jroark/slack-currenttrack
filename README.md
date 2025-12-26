# slack-currenttrack

Keep your Slack status in sync with whatever Apple Music or Spotify is currently playing on your Mac.

The script polls Apple Music or Spotify with AppleScript, builds a status text (for example `Daft Punk — Digital Love`), and pushes it to Slack through `users.profile.set`. When playback stops it optionally clears the status.

## Screenshots

![Slack status with current track](Screenshot%202025-12-25%20at%204.10.21%E2%80%AFPM.png)
![Slack profile photo with album artwork](Screenshot%202025-12-25%20at%204.11.18%E2%80%AFPM.png)

## Inspiration

This project is a modern take on my old Pidgin-CurrentTrack plugin for Gaim/Pidgin, which updated user info, available/away messages, and buddy icons from the currently playing track across multiple players. See the original project on SourceForge: https://sourceforge.net/projects/currenttrack/. This repo adapts the same idea to Slack on macOS with AppleScript and the Slack Web API.

## Requirements

- macOS with Apple Music or Spotify
- Node.js 16+ (ships with the script)
- A Slack app installed to your workspace with the `users.profile:write` & `users.profile:read` scopes and a user token (starts with `xoxp-…`)

## Setup

1. [Create a Slack app](https://api.slack.com/apps) or use an existing one tied to your Slack account.
2. Under **OAuth & Permissions** add the `users.profile:write` & `users.profile:read` user scopes.
3. Install the app in your workspace and copy the resulting user token.
4. Clone this repository and run the script with the token exported as an environment variable:

```bash
cd slack-currenttrack
export SLACK_TOKEN=xoxp-your-token-here
npm start
```

Keep the process running (a background terminal pane, tmux session, or a LaunchAgent works well). The script logs every time it changes your status.

## Configuration

All configuration is handled through environment variables. Defaults are shown in parentheses.

| Variable | Description |
| --- | --- |
| `SLACK_TOKEN` | **Required.** Slack user token with `users.profile:write`. |
| `SLACK_STATUS_EMOJI` (`:musical_note:`) | Emoji to use while music is playing. |
| `CLEAR_STATUS_ON_PAUSE` (`true`) | If `true`, clear the status when playback stops. Set to `false` to leave the last track in place. |
| `STATUS_FORMAT` (unset) | Custom format string for status text using tokens like `%ar%`, `%so%`, `%al%`, `%pb%`, `%bn%`, `%en%`, plus optional `{p}...{/p}` and `{q}...{/q}` blocks. |
| `UPDATE_PROFILE_PHOTO` (`false`) | If `true`, update your Slack profile photo with the current album artwork when the track changes and restore it when playback stops. |
| `STATUS_MAX_LENGTH` (`100`) | Maximum length for the Slack status text; longer values are truncated with `...` to avoid `too_long` errors. |
| `PLAYER` (`music`) | Which player to read from: `music`, `spotify`, or `auto` (prefer Spotify, then Apple Music). |
| `POLL_INTERVAL_MS` (`15000`) | How often (in milliseconds) to poll the player for the current track. |
| `DRY_RUN` (`false`) | Log the status changes (and write the cache file) without calling Slack; `SLACK_TOKEN` is optional in this mode. |
| `STATUS_CACHE_FILE` (`~/.slack-currenttrack-status.json`) | JSON file that stores the last status text/emoji. Set to an empty string to disable writing. |
| `PROFILE_PHOTO_CACHE_FILE` (`~/.slack-currenttrack-profile-photo`) | Where to store your default Slack profile photo so it can be restored. Set to an empty string to disable caching/restoring. |

Example (custom emoji, slower polling):

```bash
SLACK_TOKEN=xoxp-123 \
SLACK_STATUS_EMOJI=':headphones:' \
POLL_INTERVAL_MS=30000 \
npm start
```

Example (use Spotify explicitly):

```bash
PLAYER=spotify npm start
```

Spotify advertisements are ignored, so the status clears (if enabled) instead of showing ad metadata.

Progress formatting: set `STATUS_FORMAT` to customize the status text. Tokens:

- `%ar%` artist, `%al%` album, `%so%` song title
- `%bn%` beamed note, `%en%` eighth note
- `%pb%` progress bar (9 slots, no brackets) based on elapsed time
- `{p}...{/p}` shown when paused, `{q}...{/q}` shown when stopped/not running

Example:

```bash
STATUS_FORMAT="%pb% %so% - %ar% {p}I am Paused{/p} {q}Sitting Quietly{/q}" npm start
```

If `STATUS_FORMAT` is unset, including `%pb%` in `SLACK_STATUS_EMOJI` still prepends the progress bar to the default status text.

To test formatting without touching Slack:

```bash
DRY_RUN=true npm start
```

Profile photo updates call `users.setPhoto`; ensure your token includes any additional scopes Slack requires (for example `users.profile:read` for caching/restoring and `users.profile:write` or `users:write` for updates). If you cannot add read scope, set `PROFILE_PHOTO_CACHE_FILE` to an existing image to enable restores without fetching from Slack.

When you stop the script (Ctrl+C), it clears the Slack status if `CLEAR_STATUS_ON_PAUSE=true` and restores the cached profile photo when `UPDATE_PROFILE_PHOTO=true`.

## Development

- `npm start` – run the watcher
- `npm run lint` – quick syntax check (`node --check`)

No additional dependencies are required; Slack calls are made with Node's built-in `https` module.
