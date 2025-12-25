# slack-currenttrack

Keep your Slack status in sync with whatever Apple Music or Spotify is currently playing on your Mac.

The script polls Apple Music or Spotify with AppleScript, builds a status text (for example `Daft Punk — Digital Love`), and pushes it to Slack through `users.profile.set`. When playback stops it optionally clears the status.

## Requirements

- macOS with Apple Music or Spotify
- Node.js 16+ (ships with the script)
- A Slack app installed to your workspace with the `users.profile:write` scope and a user token (starts with `xoxp-…`)

## Setup

1. [Create a Slack app](https://api.slack.com/apps) or use an existing one tied to your Slack account.
2. Under **OAuth & Permissions** add the `users.profile:write` user scope.
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
| `INCLUDE_ALBUM` (`false`) | Append the album title to the Slack status. |
| `SLACK_STATUS_PREFIX` / `SLACK_STATUS_SUFFIX` (empty) | Optional text to add before or after the generated status. |
| `UPDATE_PROFILE_PHOTO` (`false`) | If `true`, update your Slack profile photo with the current album artwork when the track changes and restore it when playback stops. |
| `STATUS_MAX_LENGTH` (`100`) | Maximum length for the Slack status text; longer values are truncated with `...` to avoid `too_long` errors. |
| `PLAYER` (`music`) | Which player to read from: `music`, `spotify`, or `auto` (prefer Spotify, then Apple Music). |
| `POLL_INTERVAL_MS` (`15000`) | How often (in milliseconds) to poll the player for the current track. |
| `DRY_RUN` (`false`) | Log the status changes (and write the cache file) without calling Slack; `SLACK_TOKEN` is optional in this mode. |
| `STATUS_CACHE_FILE` (`~/.slack-currenttrack-status.json`) | JSON file that stores the last status text/emoji. Set to an empty string to disable writing. |
| `PROFILE_PHOTO_CACHE_FILE` (`~/.slack-currenttrack-profile-photo`) | Where to store your default Slack profile photo so it can be restored. Set to an empty string to disable caching/restoring. |

Example (include the album name, custom emoji, slower polling):

```bash
SLACK_TOKEN=xoxp-123 \
SLACK_STATUS_EMOJI=':headphones:' \
INCLUDE_ALBUM=true \
POLL_INTERVAL_MS=30000 \
npm start
```

Example (use Spotify explicitly):

```bash
PLAYER=spotify npm start
```

Spotify advertisements are ignored, so the status clears (if enabled) instead of showing ad metadata.

Progress bar: include `%pb%` in `SLACK_STATUS_EMOJI` to render a 9-slot bar at the start of the status text based on elapsed time, e.g. `SLACK_STATUS_EMOJI="%pb%"` yields `[|--------]` at the start and `[----|----]` around halfway. The `%pb%` token is stripped from the emoji value to avoid Slack emoji syntax errors.

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
