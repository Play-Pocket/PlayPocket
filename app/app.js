(function () {
  'use strict';

  const PP = window.PP;
  const { util, CATEGORY, report, guard, db, state, bus } = PP;

  const ORPHAN_SWEEP_DELAY_MS = 5000;

  const el = {
    settingsModal: util.byId('settingsModal'),
    openSettings: util.byId('openSettingsBtn'),
    closeSettings: util.byId('closeSettingsBtn'),
    officialSite: util.byId('officialSiteLink'),
    clearCache: util.byId('clearCacheBtn')
  };

  function openSettings() {
    if (!el.settingsModal) return;
    el.settingsModal.classList.add('open');
    el.settingsModal.setAttribute('aria-hidden', 'false');
    PP.player.scheduleSessionSave();
  }

  function closeSettings() {
    if (!el.settingsModal) return;
    el.settingsModal.classList.remove('open');
    el.settingsModal.setAttribute('aria-hidden', 'true');
    PP.player.scheduleSessionSave();
  }

  function isSettingsOpen() {
    return !!el.settingsModal && el.settingsModal.classList.contains('open');
  }

  function closePanels() {
    let closed = false;
    if (isSettingsOpen()) {
      closeSettings();
      closed = true;
    }
    if (PP.library.isShareModalOpen()) {
      PP.library.closeShareModal();
      closed = true;
    }
    if (typeof PP.platform.closePanels === 'function' && PP.platform.closePanels()) closed = true;
    return closed;
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function handleCommand(command) {
    if (command === 'show-window') el.openSettings?.focus();
    else PP.player.handleCommand(command);
  }

  async function handleKeydown(event) {
    if (event.key === 'Escape' && closePanels()) return;
    if (!PP.platform.capabilities.keyboard) return;
    if (!PP.settings.get().keyboardShortcutsEnabled) return;
    if (isEditableTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.code) {
      case 'Space':
        event.preventDefault();
        await PP.player.togglePlayPause();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        PP.player.seekBy(event.shiftKey ? -10 : -5);
        break;
      case 'ArrowRight':
        event.preventDefault();
        PP.player.seekBy(event.shiftKey ? 10 : 5);
        break;
      case 'KeyN':
        event.preventDefault();
        await PP.player.step(1);
        break;
      case 'KeyP':
        event.preventDefault();
        await PP.player.step(-1);
        break;
      case 'KeyF':
        event.preventDefault();
        await PP.player.toggleFullscreen();
        break;
      default:
        break;
    }
  }

  function flushOnExit() {
    PP.player.flushSessionFinal();
    PP.media.norm.flush();
  }

  function bindGlobalUI() {
    el.openSettings?.addEventListener('click', openSettings);
    el.closeSettings?.addEventListener('click', closeSettings);
    el.settingsModal?.addEventListener('click', (event) => {
      if (event.target === el.settingsModal) closeSettings();
    });

    el.officialSite?.addEventListener('click', guard(CATEGORY.IPC, (event) => {
      event.preventDefault();
      return PP.platform.openExternal('https://playpocket.f5.si');
    }, { scope: 'external-link' }));

    el.clearCache?.addEventListener('click', async () => {
      try {
        await PP.platform.clearCache();
        PP.ui.alert('キャッシュを削除しました。');
      } catch (error) {
        report(CATEGORY.IPC, error, { scope: 'clear-cache', message: 'キャッシュ削除に失敗しました。' });
      }
    });

    window.addEventListener('keydown', guard(CATEGORY.SYSTEM, handleKeydown, { scope: 'keyboard' }));

    window.addEventListener('beforeunload', () => {
      flushOnExit();
      PP.media.urls.revokeAll();
    });
    window.addEventListener('pagehide', flushOnExit);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      if (PP.platform.capabilities.flushOnHidden) flushOnExit();
      else PP.player.scheduleSessionSave();
    });

    window.addEventListener('error', (event) => {
      report(CATEGORY.SYSTEM, event.error || event.message, { scope: 'window', notify: false });
    });
    window.addEventListener('unhandledrejection', (event) => {
      report(CATEGORY.SYSTEM, event.reason, { scope: 'promise', notify: false });
    });

    bus.on('settings', ({ prev, next, patch, source }) => {
      PP.player.applySettings(prev, next);
      if (source !== 'user') return;
      if ('cacheEnabled' in patch) PP.ui.alert('キャッシュ設定を保存しました。反映は再起動後です。');
      if ('hardwareAcceleration' in patch) PP.ui.alert('ハードウェアアクセラレーションの変更は再起動後に反映されます。');
    });

    PP.platform.onCommand(handleCommand);
  }

  function initFailureMessage(error) {
    if (error && error.code === 'version') {
      return 'データベースが新しいバージョンで作成されているため開けません。PlayPocketを最新版に更新してください。';
    }
    if (error && (error.code === 'open-failed' || error.code === 'db-error')) {
      return 'データベースを開けませんでした。アプリを再起動してください。';
    }
    return '初期化に失敗しました';
  }

  function scheduleOrphanSweep() {
    setTimeout(() => {
      db.pruneOrphanVideos()
        .then((removed) => {
          if (removed > 0) PP.log.info('db', `removed ${removed} orphaned video record(s)`);
        })
        .catch((error) => PP.log.warn('db', error));
    }, ORPHAN_SWEEP_DELAY_MS);
  }

  async function init() {
    await db.open();

    const startup = await PP.platform.loadStartup();
    const settings = PP.settings.init(startup.settings);

    PP.player.init();
    PP.settings.bindUI();
    PP.player.applySettings(null, settings);
    PP.library.init();
    bindGlobalUI();

    const session = startup.session;
    const restoreEnabled = PP.platform.restoreEnabled(settings) && !!session;

    await PP.player.restore(session, restoreEnabled);
    await PP.library.bootstrap(restoreEnabled ? session.playlist : null);
    PP.player.setPlayerUIState();
    PP.player.updateSeekUI();

    if (restoreEnabled && session.playlist) await PP.player.restoreTrack(session);
    if (typeof PP.platform.afterRestore === 'function') PP.platform.afterRestore(restoreEnabled ? session : null);

    PP.player.markSessionReady();
    scheduleOrphanSweep();
    return true;
  }

  PP.app = Object.freeze({ init, openSettings, closeSettings, closePanels });

  PP.ready = init().catch((error) => {
    report(CATEGORY.SYSTEM, error, { scope: 'init', message: initFailureMessage(error) });
    return false;
  });
}());
