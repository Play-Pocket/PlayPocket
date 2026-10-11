'use strict';

module.exports = Object.freeze({
  RPC_SET: 'rpc:set',
  RPC_CLEAR: 'rpc:clear',
  PLAYBACK_STATE: 'playback:state',
  PLAYBACK_COMMAND: 'playback:command',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  STARTUP_STATE: 'app:startup-state',
  STATE_SAVE: 'state:save',
  STATE_SAVE_FINAL: 'state:save-final',
  CACHE_CLEAR: 'cache:clear',
  EXTERNAL_OPEN: 'external:open',
  TRANSCODE_TO_MP4: 'media:transcode-to-mp4',
  TRANSCODE_PROGRESS: 'media:transcode-progress'
});
