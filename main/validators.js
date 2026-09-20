'use strict';

const { isPlainObject } = require('../app/shared/schema.js');

const OFFICIAL_HOST = 'playpocket.f5.si';
const PLAYBACK_COMMANDS = Object.freeze(['toggle-play-pause', 'next-track', 'previous-track', 'toggle-fullscreen', 'show-window']);
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
const MAX_URL_LENGTH = 2048;
const RPC_TEXT_LIMIT = 128;

function cleanText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, RPC_TEXT_LIMIT);
  return text.length >= 2 ? text : fallback;
}

function plausibleTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_TIMESTAMP_MS && value <= MAX_TIMESTAMP_MS
    ? Math.floor(value)
    : undefined;
}

function sanitizeRpcPayload(data) {
  if (!isPlainObject(data)) return null;
  if (data.paused === true) return { paused: true };
  const startTimestamp = plausibleTimestamp(data.startTimestamp) ?? Date.now();
  let endTimestamp = plausibleTimestamp(data.endTimestamp);
  if (endTimestamp !== undefined && endTimestamp <= startTimestamp) endTimestamp = undefined;
  return {
    paused: false,
    title: cleanText(data.title, '再生中'),
    playlist: cleanText(data.playlist, 'PlayPocketで再生中'),
    startTimestamp,
    endTimestamp
  };
}

function sanitizePlaybackState(data) {
  if (!isPlainObject(data)) return null;
  return { isPlaying: data.isPlaying === true };
}

function sanitizePlaybackCommand(command) {
  return typeof command === 'string' && PLAYBACK_COMMANDS.includes(command) ? command : null;
}

function sanitizeExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const ok = url.protocol === 'https:' &&
    url.hostname === OFFICIAL_HOST &&
    url.port === '' &&
    !url.username &&
    !url.password;
  return ok ? url.href : null;
}

module.exports = {
  PLAYBACK_COMMANDS,
  sanitizeRpcPayload,
  sanitizePlaybackState,
  sanitizePlaybackCommand,
  sanitizeExternalUrl
};
