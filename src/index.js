#!/usr/bin/env node

const { execFile } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = readNumberFromEnv('POLL_INTERVAL_MS', 15000);
const STATUS_EMOJI = process.env.SLACK_STATUS_EMOJI || ':musical_note:';
const CLEAR_STATUS_ON_PAUSE = readBooleanFromEnv('CLEAR_STATUS_ON_PAUSE', true);
const INCLUDE_ALBUM = readBooleanFromEnv('INCLUDE_ALBUM', false);
const STATUS_PREFIX = process.env.SLACK_STATUS_PREFIX || '';
const STATUS_SUFFIX = process.env.SLACK_STATUS_SUFFIX || '';
const DRY_RUN = readBooleanFromEnv('DRY_RUN', false);
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.slack-currenttrack-status.json');
const STATUS_CACHE_FILE = process.env.STATUS_CACHE_FILE === ''
  ? null
  : (process.env.STATUS_CACHE_FILE || DEFAULT_CACHE_PATH);

if (process.platform !== 'darwin') {
  console.error('slack-currenttrack only works on macOS because it talks to Apple Music via AppleScript.');
  process.exit(1);
}

if (!SLACK_TOKEN && !DRY_RUN) {
  console.error('Missing SLACK_TOKEN. Create a Slack app with users.profile:write and export the user token.');
  process.exit(1);
}

if (DRY_RUN && !SLACK_TOKEN) {
  console.warn('Running with DRY_RUN enabled and no SLACK_TOKEN. Slack will not be updated.');
}

const SCRIPT_DELIMITER = '||slack-currenttrack||';
const PLAYER_STATES = {
  PLAYING: 'playing',
  STOPPED: 'stopped',
};

async function readCurrentTrack() {
  const appleScript = `
if application "Music" is not running then
  return "${PLAYER_STATES.STOPPED}"
end if
tell application "Music"
  if player state is not playing then
    return "${PLAYER_STATES.STOPPED}"
  end if
  set trackName to name of current track
  set trackArtist to artist of current track
  set trackAlbum to album of current track
  set trackName to my cleanupValue(trackName)
  set trackArtist to my cleanupValue(trackArtist)
  set trackAlbum to my cleanupValue(trackAlbum)
  return "${PLAYER_STATES.PLAYING}${SCRIPT_DELIMITER}" & trackArtist & "${SCRIPT_DELIMITER}" & trackName & "${SCRIPT_DELIMITER}" & trackAlbum
end tell

on cleanupValue(theValue)
  if theValue is missing value then
    return ""
  end if
  set theValue to do shell script "printf %s " & quoted form of theValue
  return theValue
end cleanupValue
`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', appleScript]);
    const normalized = stdout.trim();
    if (!normalized || normalized === PLAYER_STATES.STOPPED) {
      return null;
    }

    const [state, artist, title, album] = normalized.split(SCRIPT_DELIMITER);
    if (state !== PLAYER_STATES.PLAYING) {
      return null;
    }
    return {
      artist: artist || 'Unknown Artist',
      title: title || 'Unknown Track',
      album: album || '',
    };
  } catch (error) {
    console.error('Failed to read Apple Music track:', error.message);
    return null;
  }
}

function formatStatus(track) {
  const cleanArtist = sanitizeText(track.artist);
  const cleanTitle = sanitizeText(track.title);
  const cleanAlbum = sanitizeText(track.album);

  let text = `${cleanArtist} — ${cleanTitle}`;
  if (INCLUDE_ALBUM && cleanAlbum) {
    text += ` (${cleanAlbum})`;
  }
  return `${STATUS_PREFIX}${text}${STATUS_SUFFIX}`.trim();
}

async function updateSlackStatus(statusText, statusEmoji) {
  const payload = {
    profile: {
      status_text: statusText,
      status_emoji: statusEmoji,
      status_expiration: 0,
    },
  };

  const response = await callSlackApi('users.profile.set', payload);
  if (!response.ok) {
    const errorMessage = response.error || 'unknown_error';
    throw new Error(`Slack API rejected the request: ${errorMessage}`);
  }
}

function callSlackApi(path, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'slack.com',
        path: `/api/${path}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${SLACK_TOKEN}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(text);
            resolve(parsed);
          } catch (parseError) {
            reject(new Error(`Failed to parse Slack response: ${parseError.message}. Body: ${text}`));
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function sanitizeText(value) {
  return value.replace(/\\s+/g, ' ').trim();
}

function readBooleanFromEnv(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readNumberFromEnv(key, defaultValue) {
  const value = Number.parseInt(process.env[key], 10);
  if (Number.isNaN(value)) {
    return defaultValue;
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function payloadsEqual(a, b) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.status_text === b.status_text && a.status_emoji === b.status_emoji;
}

async function persistPayload(payload) {
  if (!STATUS_CACHE_FILE) {
    return;
  }

  try {
    if (!payload) {
      await deleteFileIfExists(STATUS_CACHE_FILE);
      return;
    }

    await fs.mkdir(path.dirname(STATUS_CACHE_FILE), { recursive: true });
    const enrichedPayload = {
      status_text: payload.status_text,
      status_emoji: payload.status_emoji,
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(STATUS_CACHE_FILE, `${JSON.stringify(enrichedPayload, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error(`Failed to persist cache file at ${STATUS_CACHE_FILE}:`, error.message);
  }
}

async function deleteFileIfExists(targetPath) {
  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Failed to remove cache file at ${targetPath}:`, error.message);
    }
  }
}

async function main() {
  let lastPayload = null;
  console.log(`Watching Apple Music every ${POLL_INTERVAL_MS}ms...`);

  while (true) {
    try {
      const track = await readCurrentTrack();
      const payload = track
        ? { status_text: formatStatus(track), status_emoji: STATUS_EMOJI }
        : CLEAR_STATUS_ON_PAUSE
          ? { status_text: '', status_emoji: '' }
          : null;

      if (payload && !payloadsEqual(payload, lastPayload)) {
        if (DRY_RUN) {
          console.log(`[dry-run] Would update Slack status to: ${payload.status_text || '(cleared)'}`);
        } else {
          await updateSlackStatus(payload.status_text, payload.status_emoji);
          console.log(`Updated Slack status to: ${payload.status_text || '(cleared)'}`);
        }
        lastPayload = payload;
        await persistPayload(payload);
      } else if (!payload) {
        lastPayload = null;
      }
    } catch (error) {
      console.error('Failed to update Slack status:', error.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

process.on('SIGINT', () => {
  console.log('Exiting slack-currenttrack');
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
