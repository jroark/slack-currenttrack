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
const UPDATE_PROFILE_PHOTO = readBooleanFromEnv('UPDATE_PROFILE_PHOTO', false);
const STATUS_MAX_LENGTH = readNumberFromEnv('STATUS_MAX_LENGTH', 100);
const PLAYER = normalizePlayer(process.env.PLAYER || 'music');
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.slack-currenttrack-status.json');
const STATUS_CACHE_FILE = process.env.STATUS_CACHE_FILE === ''
  ? null
  : (process.env.STATUS_CACHE_FILE || DEFAULT_CACHE_PATH);
const DEFAULT_PROFILE_PHOTO_PATH = path.join(os.homedir(), '.slack-currenttrack-profile-photo');
const PROFILE_PHOTO_CACHE_FILE = process.env.PROFILE_PHOTO_CACHE_FILE === ''
  ? null
  : (process.env.PROFILE_PHOTO_CACHE_FILE || DEFAULT_PROFILE_PHOTO_PATH);

let profilePhotoUpdated = false;
let profilePhotoCacheUnavailable = false;
let shuttingDown = false;
let lastPayloadRef = null;

if (process.platform !== 'darwin') {
  console.error('slack-currenttrack only works on macOS because it talks to Apple Music or Spotify via AppleScript.');
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
  if (PLAYER === 'music') {
    return readAppleMusicTrack();
  }
  if (PLAYER === 'spotify') {
    return readSpotifyTrack();
  }

  const spotifyTrack = await readSpotifyTrack();
  if (spotifyTrack) {
    return spotifyTrack;
  }
  return readAppleMusicTrack();
}

async function readAppleMusicTrack() {
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
      source: 'music',
      artist: artist || 'Unknown Artist',
      title: title || 'Unknown Track',
      album: album || '',
    };
  } catch (error) {
    console.error('Failed to read Apple Music track:', error.message);
    return null;
  }
}

async function readSpotifyTrack() {
  const appleScript = `
if application "Spotify" is not running then
  return "${PLAYER_STATES.STOPPED}"
end if
tell application "Spotify"
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
    if (isSpotifyAdvertisement(artist, title, album)) {
      return null;
    }
    return {
      source: 'spotify',
      artist: artist || 'Unknown Artist',
      title: title || 'Unknown Track',
      album: album || '',
    };
  } catch (error) {
    console.error('Failed to read Spotify track:', error.message);
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
  return clampStatusText(`${STATUS_PREFIX}${text}${STATUS_SUFFIX}`.trim());
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

function callSlackApiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'slack.com',
        path: `/api/${path}`,
        method: 'GET',
        headers: {
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
    req.end();
  });
}

function callSlackApiMultipart(path, body, boundary) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'slack.com',
        path: `/api/${path}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
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

function isSpotifyAdvertisement(artist, title, album) {
  const fields = [artist, title, album]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  if (fields.length === 0) {
    return false;
  }
  return fields.some((value) => value.includes('advertisement'))
    || fields.some((value) => value === 'spotify');
}

function normalizePlayer(value) {
  const normalized = value.toLowerCase();
  if (['music', 'apple-music', 'applemusic', 'apple_music'].includes(normalized)) {
    return 'music';
  }
  if (normalized === 'spotify') {
    return 'spotify';
  }
  if (normalized === 'auto') {
    return 'auto';
  }
  console.warn(`Unknown PLAYER value "${value}". Falling back to "music".`);
  return 'music';
}

function clampStatusText(value) {
  if (!value) {
    return value;
  }
  if (value.length <= STATUS_MAX_LENGTH) {
    return value;
  }
  if (STATUS_MAX_LENGTH <= 3) {
    return value.slice(0, STATUS_MAX_LENGTH);
  }
  return `${value.slice(0, STATUS_MAX_LENGTH - 3)}...`;
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

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

function detectImageType(buffer) {
  if (buffer.length >= 8) {
    const isPng = buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47;
    if (isPng) {
      return { mimeType: 'image/png', extension: '.png' };
    }
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }

  return { mimeType: 'application/octet-stream', extension: '' };
}

async function fetchProfilePhotoUrl() {
  const response = await callSlackApiGet('users.profile.get');
  if (!response.ok) {
    const errorMessage = response.error || 'unknown_error';
    throw new Error(`Slack API rejected the profile fetch: ${errorMessage}`);
  }
  const profile = response.profile || {};
  return profile.image_original
    || profile.image_512
    || profile.image_192
    || null;
}

async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function cacheDefaultProfilePhoto() {
  if (!PROFILE_PHOTO_CACHE_FILE) {
    return null;
  }

  if (await fileExists(PROFILE_PHOTO_CACHE_FILE)) {
    return PROFILE_PHOTO_CACHE_FILE;
  }

  const url = await fetchProfilePhotoUrl();
  if (!url) {
    return null;
  }

  const imageData = await downloadImage(url);
  await fs.mkdir(path.dirname(PROFILE_PHOTO_CACHE_FILE), { recursive: true });
  await fs.writeFile(PROFILE_PHOTO_CACHE_FILE, imageData);
  return PROFILE_PHOTO_CACHE_FILE;
}

async function exportAlbumArt(track) {
  if (track && track.source === 'spotify') {
    return exportSpotifyAlbumArt();
  }
  return exportAppleMusicAlbumArt();
}

async function exportAppleMusicAlbumArt() {
  const appleScript = `
if application "Music" is not running then
  return ""
end if
tell application "Music"
  if player state is not playing then
    return ""
  end if
  if (count of artworks of current track) is 0 then
    return ""
  end if
  set artData to data of artwork 1 of current track
end tell
set tmpPath to do shell script "mktemp -t slack-currenttrack-artwork"
try
  set outFile to open for access POSIX file tmpPath with write permission
  set eof outFile to 0
  write artData to outFile
  close access outFile
  return tmpPath
on error
  try
    close access POSIX file tmpPath
  end try
  return ""
end try
`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', appleScript]);
    const normalized = stdout.trim();
    return normalized ? normalized : null;
  } catch (error) {
    console.error('Failed to export Apple Music artwork:', error.message);
    return null;
  }
}

async function exportSpotifyAlbumArt() {
  const appleScript = `
if application "Spotify" is not running then
  return ""
end if
tell application "Spotify"
  if player state is not playing then
    return ""
  end if
  set artUrl to artwork url of current track
end tell
if artUrl is missing value then
  return ""
end if
return artUrl
`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', appleScript]);
    const normalized = stdout.trim();
    if (!normalized) {
      return null;
    }
    const imageData = await downloadImage(normalized);
    const { extension } = detectImageType(imageData);
    const filename = `slack-currenttrack-artwork-${Date.now()}${extension}`;
    const targetPath = path.join(os.tmpdir(), filename);
    await fs.writeFile(targetPath, imageData);
    return targetPath;
  } catch (error) {
    console.error('Failed to export Spotify artwork:', error.message);
    return null;
  }
}

async function updateSlackProfilePhoto(imagePath) {
  const imageData = await fs.readFile(imagePath);
  const { mimeType, extension } = detectImageType(imageData);
  const boundary = `----slack-currenttrack-${Date.now()}`;
  const filename = `album-art${extension}`;
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="image"; filename="${filename}"`,
    `Content-Type: ${mimeType}`,
    '',
    '',
  ].join('\r\n');
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    imageData,
    Buffer.from(footer, 'utf8'),
  ]);

  const response = await callSlackApiMultipart('users.setPhoto', body, boundary);
  if (!response.ok) {
    const errorMessage = response.error || 'unknown_error';
    throw new Error(`Slack API rejected the photo update: ${errorMessage}`);
  }
}

async function restoreDefaultProfilePhoto() {
  if (!PROFILE_PHOTO_CACHE_FILE) {
    return false;
  }
  if (!(await fileExists(PROFILE_PHOTO_CACHE_FILE))) {
    return false;
  }
  await updateSlackProfilePhoto(PROFILE_PHOTO_CACHE_FILE);
  return true;
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
  let lastTrackKey = null;
  const playerLabel = PLAYER === 'auto'
    ? 'Spotify or Apple Music'
    : PLAYER === 'spotify'
      ? 'Spotify'
      : 'Apple Music';
  console.log(`Watching ${playerLabel} every ${POLL_INTERVAL_MS}ms...`);

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
        lastPayloadRef = payload;
        await persistPayload(payload);
      } else if (!payload) {
        lastPayload = null;
        lastPayloadRef = null;
      }

      if (track) {
        const trackKey = `${track.source}||${track.artist}||${track.title}||${track.album}`;
        if (UPDATE_PROFILE_PHOTO && trackKey !== lastTrackKey) {
          if (DRY_RUN) {
            console.log('[dry-run] Would update Slack profile photo with album artwork.');
          } else {
            if (!profilePhotoCacheUnavailable) {
              try {
                await cacheDefaultProfilePhoto();
              } catch (error) {
                profilePhotoCacheUnavailable = true;
                if (error.message && error.message.includes('missing_scope')) {
                  console.error('Profile photo caching disabled: missing Slack scope users.profile:read.');
                  console.error('Set PROFILE_PHOTO_CACHE_FILE to an existing image to enable restore.');
                } else {
                  console.error('Profile photo caching disabled due to an error:', error.message);
                }
              }
            }
            const artPath = await exportAlbumArt(track);
            if (artPath) {
              await updateSlackProfilePhoto(artPath);
              console.log('Updated Slack profile photo with album artwork.');
              profilePhotoUpdated = true;
              await deleteFileIfExists(artPath);
            } else {
              console.log('No album artwork available for the current track.');
            }
          }
        }
        lastTrackKey = trackKey;
      } else {
        if (UPDATE_PROFILE_PHOTO && profilePhotoUpdated) {
          if (DRY_RUN) {
            console.log('[dry-run] Would restore the default Slack profile photo.');
          } else {
            const restored = await restoreDefaultProfilePhoto();
            if (restored) {
              console.log('Restored the default Slack profile photo.');
            } else {
              console.log('No cached default profile photo to restore.');
            }
          }
          profilePhotoUpdated = false;
        }
        lastTrackKey = null;
      }
    } catch (error) {
      console.error('Failed to update Slack status or profile photo:', error.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Exiting slack-currenttrack (${signal})`);

  let hasCachedProfilePhoto = false;
  if (PROFILE_PHOTO_CACHE_FILE) {
    hasCachedProfilePhoto = await fileExists(PROFILE_PHOTO_CACHE_FILE);
  }

  if (UPDATE_PROFILE_PHOTO && (profilePhotoUpdated || hasCachedProfilePhoto)) {
    if (DRY_RUN) {
      console.log('[dry-run] Would restore the default Slack profile photo.');
    } else {
      try {
        const restored = await restoreDefaultProfilePhoto();
        if (restored) {
          console.log('Restored the default Slack profile photo.');
        } else {
          console.log('No cached default profile photo to restore.');
        }
      } catch (error) {
        console.error('Failed to restore the default Slack profile photo:', error.message);
      }
    }
  }

  if (CLEAR_STATUS_ON_PAUSE && lastPayloadRef) {
    if (DRY_RUN) {
      console.log('[dry-run] Would clear Slack status.');
    } else {
      try {
        await updateSlackStatus('', '');
        await persistPayload(null);
        console.log('Cleared Slack status.');
      } catch (error) {
        console.error('Failed to clear Slack status:', error.message);
      }
    }
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
