(function () {
  'use strict';

  const PP = window.PP;
  const { CATEGORY, report } = PP;
  const api = window.electronAPI || null;

  function toRuntimeState(snapshot) {
    return {
      lastPlaylist: snapshot.playlist,
      lastCurrentIndex: snapshot.index,
      lastPlayMode: snapshot.playMode,
      lastVolume: snapshot.volume,
      lastSpeed: snapshot.speed,
      lastTrackId: snapshot.trackId,
      lastTime: snapshot.time,
      isPlaying: snapshot.wasPlaying
    };
  }

  function fromRuntimeState(state) {
    if (!state || typeof state !== 'object') return null;
    return {
      playlist: state.lastPlaylist || undefined,
      index: state.lastCurrentIndex,
      trackId: state.lastTrackId || undefined,
      playMode: state.lastPlayMode,
      volume: state.lastVolume,
      speed: state.lastSpeed,
      time: state.lastTime,
      wasPlaying: state.isPlaying
    };
  }

  function presenceEnabled() {
    return !!(api && PP.settings.get().rpcEnabled);
  }

  PP.platform = Object.freeze({
    name: 'electron',
    capabilities: Object.freeze({ keyboard: true, sidebar: false, fullscreenApi: true, extensionVideoFallback: false, flushOnHidden: false }),

    async loadStartup() {
      let settings = null;
      let session = null;
      try {
        const startup = await api?.getStartupState?.();
        if (startup && typeof startup === 'object') {
          settings = startup.settings || null;
          session = fromRuntimeState(startup.runtimeState);
        }
      } catch (error) {
        report(CATEGORY.IPC, error, { scope: 'startup', notify: false });
      }
      return { settings, session };
    },

    restoreEnabled(settings) {
      return !!settings.restoreLastState;
    },

    async saveSettings(patch) {
      if (!api?.setSettings) return null;
      return api.setSettings(patch);
    },

    async saveSession(snapshot) {
      if (!api?.saveRuntimeState) return;
      await api.saveRuntimeState(toRuntimeState(snapshot));
    },

    saveSessionFinal(snapshot) {
      if (api?.saveRuntimeStateFinal) api.saveRuntimeStateFinal(toRuntimeState(snapshot));
    },

    reportPlaybackState({ isPlaying }) {
      api?.updatePlaybackState?.({ isPlaying: !!isPlaying });
    },

    setPresence(payload) {
      if (!presenceEnabled()) return;
      if (payload) api.setRPC({ paused: false, ...payload });
      else api.setRPC({ paused: true });
    },

    clearPresence() {
      if (presenceEnabled()) api.clearRPC();
    },

    async clearCache() {
      if (!api?.clearBrowserCache) return false;
      await api.clearBrowserCache();
      return true;
    },

    async openExternal(url) {
      if (api?.openExternal) return api.openExternal(url);
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    },

    onCommand(handler) {
      return api?.onPlaybackCommand?.(handler) || (() => {});
    }
  });
}());
