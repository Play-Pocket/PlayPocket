(function () {
  'use strict';

  const PP = window.PP;
  const { C, util, log, CATEGORY, report, guard, db, media, state, bus, PPError } = PP;

  const el = {
    fileInput: util.byId('fileInput'),
    dropZone: util.byId('dropZone'),
    playlists: util.byId('playlists'),
    newName: util.byId('newPlaylistName'),
    createBtn: util.byId('createPlaylistBtn'),
    trackList: util.byId('trackList'),
    totalDuration: util.byId('totalDuration'),
    exportMeta: util.byId('exportMetaBtn'),
    exportBlobs: util.byId('exportWithBlobsBtn'),
    importFile: util.byId('importFile'),
    shareBtn: util.byId('sharePlaylistBtn'),
    shareModal: util.byId('shareModal'),
    closeShare: util.byId('closeShareBtn'),
    shareSummary: util.byId('sharePlaylistSummary'),
    downloadShare: util.byId('downloadSharePackageBtn'),
    copyCode: util.byId('copyShareCodeBtn'),
    codeInput: util.byId('shareCodeInput'),
    importCode: util.byId('importShareCodeBtn'),
    shareStatus: util.byId('shareStatus')
  };

  let renderToken = 0;
  let addQueue = Promise.resolve();
  let dragOverEl = null;
  let highlightedId = null;

  function infoCache() {
    return PP.cache.videoInfo;
  }

  function applyItems(items) {
    const prev = state.items;
    state.items = items.slice();
    PP.player.onPlaylistChanged(prev);
  }

  async function loadCurrent() {
    if (!state.currentPlaylist) {
      state.items = [];
      return state.items;
    }
    const playlist = await db.getPlaylist(state.currentPlaylist);
    state.items = playlist ? playlist.items.slice() : [];
    return state.items;
  }

  function pruneInfoCache() {
    const keep = new Set(state.items);
    if (state.currentTrackId) keep.add(state.currentTrackId);
    for (const id of Array.from(infoCache().keys())) {
      if (!keep.has(id)) infoCache().delete(id);
    }
  }

  function forget(ids) {
    for (const id of ids) infoCache().delete(id);
    media.norm.remove(ids);
  }

  function saveErrorMessage(error, fallback) {
    if (error && error.code === 'quota') return '保存先の空き容量が不足しているため保存できませんでした。';
    return fallback;
  }

  function updateTotalDuration() {
    let total = 0;
    for (const id of state.items) total += infoCache().get(id)?.duration || 0;
    if (el.totalDuration) el.totalDuration.textContent = util.formatTime(total);
  }

  function renderTrackItem(info, index, isPlaying) {
    const li = document.createElement('li');
    li.className = 'track-item';
    li.dataset.index = String(index);
    li.dataset.id = info.id;
    li.draggable = true;
    if (isPlaying) li.classList.add('playing');

    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = 'サムネイル';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = util.sanitizeThumbnail(info.thumbnail) ?? '';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = util.displayTitle(info.name);

    const sub = document.createElement('div');
    sub.className = 'sub';
    const sizeMB = Number.isFinite(info.size) ? Math.round(info.size / 1024 / 1024) : 0;
    sub.textContent = `${util.formatTime(info.duration)} • ${sizeMB} MB`;

    meta.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'track-actions';

    const playNow = document.createElement('button');
    playNow.className = 'small-btn play-now';
    playNow.type = 'button';
    playNow.textContent = '再生';

    const remove = document.createElement('button');
    remove.className = 'small-btn remove';
    remove.type = 'button';
    remove.textContent = '削除';

    actions.append(playNow, remove);
    li.append(img, meta, actions);
    return li;
  }

  function renderTrackList() {
    const fragment = document.createDocumentFragment();
    state.items.forEach((id, index) => {
      const info = infoCache().get(id);
      if (!info) return;
      fragment.appendChild(renderTrackItem(info, index, id === state.currentTrackId));
    });
    highlightedId = state.currentTrackId;
    el.trackList.replaceChildren(fragment);
  }

  async function refreshTrackList() {
    const token = ++renderToken;
    const missing = state.items.filter((id) => !infoCache().has(id));
    if (missing.length > 0) {
      const infos = await db.getVideoInfos(missing);
      if (token !== renderToken) return;
      for (const info of infos) infoCache().set(info.id, info);
    }
    renderTrackList();
    updateTotalDuration();
  }

  function updateHighlight() {
    const id = state.currentTrackId;
    if (id === highlightedId) return;
    highlightedId = id;
    for (const li of el.trackList.children) li.classList.toggle('playing', li.dataset.id === id);
  }

  async function refreshPlaylistsUI() {
    const playlists = await db.listPlaylists();
    const fragment = document.createDocumentFragment();

    for (const playlist of playlists) {
      const label = util.normalizePlaylistName(playlist.name);
      if (!label) continue;

      const li = document.createElement('li');
      li.className = 'playlist-item';
      li.dataset.name = playlist.name;
      if (playlist.name === state.currentPlaylist) li.classList.add('active');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'playlist-name';
      nameSpan.textContent = label;
      nameSpan.title = PP.platform.capabilities.renameGesture === 'dblclick'
        ? 'クリックで選択 / ダブルクリックで名前変更'
        : 'クリックで選択 / 右クリックで名前変更';

      const del = document.createElement('button');
      del.className = 'small-btn';
      del.type = 'button';
      del.textContent = '削除';

      li.append(nameSpan, del);
      fragment.appendChild(li);
    }
    el.playlists.replaceChildren(fragment);
  }

  function markActivePlaylist() {
    for (const li of el.playlists.children) {
      li.classList.toggle('active', li.dataset.name === state.currentPlaylist);
    }
  }

  async function refreshAll() {
    await refreshPlaylistsUI();
    await refreshTrackList();
    PP.player.updateSeekUI();
  }

  async function switchTo(name) {
    const playlist = name ? await db.getPlaylist(name) : null;
    state.currentPlaylist = playlist ? name : (name || null);
    state.items = playlist ? playlist.items.slice() : [];
    PP.player.onPlaylistSwitched();
    pruneInfoCache();
  }

  async function selectPlaylist(name) {
    if (state.currentPlaylist === name) return;
    await switchTo(name);
    markActivePlaylist();
    await refreshTrackList();
    PP.player.updateSeekUI();
    PP.player.scheduleSessionSave();
    bus.emit('library:playlist-selected', { name });
  }

  async function createPlaylist() {
    const name = util.normalizePlaylistName(el.newName.value);
    if (!name) return;
    try {
      await db.createPlaylist(name);
    } catch (error) {
      if (error && error.code === 'exists') {
        PP.ui.alert('同名のプレイリストが既に存在します');
        return;
      }
      throw error;
    }
    el.newName.value = '';
    await switchTo(name);
    await refreshAll();
    PP.player.scheduleSessionSave();
    bus.emit('library:playlist-selected', { name });
  }

  async function renamePlaylist(oldName) {
    const input = await PP.dialogs.promptText({
      title: 'プレイリスト名を変更',
      label: 'プレイリスト名',
      value: oldName,
      okLabel: '変更',
      maxLength: C.MAX_PLAYLIST_NAME_LENGTH
    });
    if (input === null) return;

    const next = util.normalizePlaylistName(input);
    if (!next) {
      PP.ui.alert('無効な名前です');
      return;
    }
    if (next === oldName) return;

    try {
      await db.renamePlaylist(oldName, next);
    } catch (error) {
      log.warn('library', error);
      PP.ui.alert(error && error.code === 'exists' ? '同名のプレイリストが既に存在します' : '名前変更に失敗しました');
      return;
    }
    if (state.currentPlaylist === oldName) state.currentPlaylist = next;
    await refreshAll();
    PP.player.scheduleSessionSave();
  }

  async function deletePlaylist(name) {
    if (!PP.ui.confirm(`プレイリスト「${name}」を削除しますか？`)) return;
    const { deletedVideoIds, remainingNames } = await db.deletePlaylist(name);
    forget(deletedVideoIds);
    if (state.currentPlaylist === name) await switchTo(remainingNames[0] || null);
    pruneInfoCache();
    await refreshAll();
    PP.player.scheduleSessionSave();
  }

  async function removeTrackAt(index, id) {
    if (!state.currentPlaylist) return;
    const result = await db.removeTrack(state.currentPlaylist, index, id);
    if (!result.removedId) {
      await loadCurrent();
      await refreshTrackList();
      return;
    }
    applyItems(result.items);
    if (result.deletedVideoId) forget([result.deletedVideoId]);
    await refreshTrackList();
    PP.player.updateSeekUI();
    PP.player.scheduleSessionSave();
  }

  async function reorderTrack(fromIndex, toIndex) {
    if (!state.currentPlaylist) return;
    const items = await db.reorderPlaylist(state.currentPlaylist, fromIndex, toIndex);
    if (!items) return;
    applyItems(items);
    renderTrackList();
    PP.player.scheduleSessionSave();
  }

  function isSupportedVideoFile(file) {
    if (!(file instanceof File)) return false;
    if (typeof file.type === 'string' && file.type.startsWith('video/')) return true;
    if (PP.platform.capabilities.extensionVideoFallback) return /\.(mp4|webm|mov|m4v|ogg|mkv)$/i.test(file.name || '');
    return false;
  }

  async function doAddFiles(files) {
    if (!state.currentPlaylist) {
      state.currentPlaylist = 'Default';
      state.items = [];
      PP.player.onPlaylistSwitched();
    }
    const target = state.currentPlaylist;
    let failure = null;

    await db.batch(async () => {
      for (const file of files) {
        try {
          const { duration, thumbnail } = await media.probeVideo(file);
          const record = {
            id: util.uid(),
            name: util.safeText(file.name) || 'video',
            duration: util.clampNumber(duration, 0),
            mimeType: util.sanitizeMimeType(file.type),
            blob: file.slice(0, file.size, file.type || 'video/mp4'),
            thumbnail,
            size: file.size
          };
          const items = await db.addVideoToPlaylist(record, target);
          infoCache().set(record.id, db.toInfo(record));
          if (state.currentPlaylist === target) applyItems(items);
        } catch (error) {
          failure = error;
          break;
        }
      }
    });

    if (failure) {
      report(CATEGORY.DATABASE, failure, {
        scope: 'add-files',
        message: saveErrorMessage(failure, '動画の保存に失敗しました。もう一度お試しください。')
      });
    }
    await refreshAll();
    PP.player.scheduleSessionSave();
  }

  function addFiles(fileList) {
    const accepted = Array.from(fileList || [])
      .filter(isSupportedVideoFile)
      .slice(0, C.MAX_VIDEO_FILES_PER_DROP);
    if (accepted.length === 0) return Promise.resolve();
    const run = () => doAddFiles(accepted);
    addQueue = addQueue.then(run, run);
    return addQueue;
  }

  function uniquePlaylistName(baseName, suffix, existing) {
    const normalized = util.normalizePlaylistName(baseName) || 'プレイリスト';
    const make = (tail) => `${normalized.slice(0, Math.max(1, C.MAX_PLAYLIST_NAME_LENGTH - tail.length))}${tail}`;
    const initial = make(suffix);
    if (!existing.has(initial)) return initial;
    for (let index = 2; index <= 999; index++) {
      const candidate = make(`${suffix} ${index}`);
      if (!existing.has(candidate)) return candidate;
    }
    throw new PPError('name-unavailable', 'playlist-name-unavailable', { category: CATEGORY.IMPORT_EXPORT });
  }

  async function importPlaylistPayload(payload, suffix) {
    const baseName = util.normalizePlaylistName(payload?.name);
    if (!baseName || !Array.isArray(payload?.items)) {
      throw new PPError('invalid', 'invalid playlist payload', { category: CATEGORY.IMPORT_EXPORT });
    }

    const existing = new Set((await db.listPlaylists()).map((playlist) => playlist.name));
    const name = uniquePlaylistName(baseName, suffix, existing);
    const ids = [];

    await db.batch(async () => {
      try {
        for (const item of payload.items.slice(0, C.MAX_IMPORTED_ITEMS)) {
          if (!item || typeof item !== 'object') continue;

          const mimeType = util.sanitizeMimeType(item.mimeType);
          let blob = null;
          if (typeof item.blobBase64 === 'string' && item.blobBase64.length > 0) {
            blob = media.base64ToBlob(item.blobBase64, mimeType);
            item.blobBase64 = null;
          }

          const record = {
            id: util.uid(),
            name: util.normalizePlaylistName(item.name) || 'video',
            duration: util.clampNumber(Number(item.duration), 0),
            mimeType,
            blob,
            thumbnail: util.sanitizeThumbnail(item.thumbnail),
            size: util.clampNumber(Number(item.size), 0) || (blob ? blob.size : 0)
          };
          await db.putVideo(record);
          ids.push(record.id);
          infoCache().set(record.id, db.toInfo(record));
        }
        await db.putPlaylist({ name, items: ids });
      } catch (error) {
        try { await db.deleteVideos(ids); } catch (cleanupError) { log.warn('library', cleanupError); }
        for (const id of ids) infoCache().delete(id);
        throw error;
      }
    });

    await switchTo(name);
    await refreshAll();
    PP.player.scheduleSessionSave();
    bus.emit('library:playlist-selected', { name });
    return { name, itemCount: ids.length };
  }

  async function readPlaylistMeta() {
    const playlist = await db.getPlaylist(state.currentPlaylist);
    if (!playlist) throw new PPError('playlist-not-found', 'playlist-not-found', { category: CATEGORY.IMPORT_EXPORT });
    const infos = await db.getVideoInfos(playlist.items);
    const byId = new Map(infos.map((info) => [info.id, info]));
    const items = [];
    for (const id of playlist.items) {
      const info = byId.get(id);
      if (info) items.push(info);
    }
    return { name: playlist.name, items };
  }

  async function buildExportBlob({ includeBlobs, header = '', maxBytes = Infinity }) {
    const playlist = await db.getPlaylist(state.currentPlaylist);
    if (!playlist) throw new PPError('playlist-not-found', 'playlist-not-found', { category: CATEGORY.IMPORT_EXPORT });

    if (includeBlobs && Number.isFinite(maxBytes)) {
      const infos = await db.getVideoInfos(playlist.items);
      const estimate = infos.reduce((sum, info) => sum + Math.ceil(info.size / 3) * 4, 0);
      if (estimate > maxBytes) throw new PPError('too-large', 'export too large', { category: CATEGORY.IMPORT_EXPORT });
    }

    const parts = [`{${header}"name":${JSON.stringify(playlist.name)},"items":[`];
    let first = true;

    for (const id of playlist.items) {
      const record = await db.getVideo(id);
      if (!record) continue;
      const info = db.toInfo(record);
      if (!info) continue;

      const item = {
        id: util.safeText(info.id) || util.uid(),
        name: info.name,
        duration: info.duration,
        mimeType: info.mimeType,
        size: info.size,
        thumbnail: info.thumbnail
      };
      const separator = first ? '' : ',';
      first = false;

      if (includeBlobs && record.blob instanceof Blob) {
        parts.push(`${separator}${JSON.stringify(item).slice(0, -1)},"blobBase64":"`);
        const encoded = await media.blobToBase64Parts(record.blob);
        for (const part of encoded) parts.push(part);
        parts.push('"}');
      } else {
        parts.push(`${separator}${JSON.stringify(item)}`);
      }
    }

    parts.push(']}');
    return { name: playlist.name, blob: new Blob(parts, { type: 'application/json' }) };
  }

  function setShareStatus(message = '', tone = '') {
    if (!el.shareStatus) return;
    el.shareStatus.textContent = message;
    el.shareStatus.className = `share-status${tone ? ` ${tone}` : ''}`;
  }

  function openShareModal() {
    if (!el.shareModal) return;
    const name = state.currentPlaylist || 'プレイリスト';
    if (el.shareSummary) {
      el.shareSummary.textContent = `「${name}」を共有します。${state.items.length} 本の動画が含まれています。`;
    }
    setShareStatus();
    el.shareModal.classList.add('open');
    el.shareModal.setAttribute('aria-hidden', 'false');
  }

  function closeShareModal() {
    if (!el.shareModal) return;
    el.shareModal.classList.remove('open');
    el.shareModal.setAttribute('aria-hidden', 'true');
  }

  function isShareModalOpen() {
    return !!el.shareModal && el.shareModal.classList.contains('open');
  }

  async function assertEmbeddedExportAllowed() {
    const limit = PP.platform.embeddedExportLimitBytes;
    if (!Number.isFinite(limit)) return;
    const playlist = await db.getPlaylist(state.currentPlaylist);
    if (!playlist) return;
    const infos = await db.getVideoInfos(playlist.items);
    const total = infos.reduce((sum, info) => sum + info.size, 0);
    if (total > limit) {
      throw new PPError('device-too-large', 'embedded export too large for this device', { category: CATEGORY.IMPORT_EXPORT });
    }
  }

  async function downloadSharePackage() {
    try {
      setShareStatus('共有ファイルを作成しています。動画の容量によっては時間がかかります。');
      el.downloadShare.disabled = true;
      await assertEmbeddedExportAllowed();
      const { name, blob } = await buildExportBlob({
        includeBlobs: true,
        header: '"format":"playpocket-share","version":1,"mediaIncluded":true,',
        maxBytes: C.MAX_SHARED_PACKAGE_BYTES
      });
      if (blob.size > C.MAX_SHARED_PACKAGE_BYTES) throw new PPError('too-large', 'share-package-too-large', { category: CATEGORY.IMPORT_EXPORT });
      const result = await media.downloadBlob(blob, `${util.sanitizeFilename(name)}${C.SHARE_PACKAGE_EXTENSION}`);
      if (result === 'cancelled') setShareStatus('保存をキャンセルしました。');
      else if (result === 'failed') setShareStatus('共有ファイルを保存できませんでした。空き容量を確認して、もう一度試してください。', 'error');
      else setShareStatus(PP.platform.name === 'android'
        ? '共有ファイルを端末に保存しました。ファイルアプリなどから他のアプリに送信してください。'
        : '共有ファイルを作成しました。ダウンロードしたファイルを相手に送ってください。', 'success');
    } catch (error) {
      const expected = error && (error.code === 'too-large' || error.code === 'device-too-large');
      report(expected ? CATEGORY.USER_INPUT : CATEGORY.IMPORT_EXPORT, error, { scope: 'share-package', notify: false });
      let message = '共有ファイルを作成できませんでした。動画の容量を確認して、もう一度試してください。';
      if (error && error.code === 'too-large') message = '共有ファイルは 500MB までです。動画を減らして、もう一度試してください。';
      else if (error && error.code === 'device-too-large') message = 'この端末では動画の合計サイズが大きすぎて共有ファイルを作成できません。動画を減らすか、軽量共有コードをお使いください。';
      setShareStatus(message, 'error');
    } finally {
      el.downloadShare.disabled = false;
    }
  }

  async function copyShareCode() {
    try {
      const playlist = await readPlaylistMeta();
      const code = window.PlayPocketShare.createCode({
        version: 1,
        kind: 'playlist-metadata',
        playlist: {
          name: playlist.name,
          items: playlist.items.map(({ name, duration, mimeType, size }) => ({ name, duration, mimeType, size }))
        }
      });
      await window.PlayPocketShare.copyText(code);
      setShareStatus('共有コードをコピーしました。動画データは含まれません。', 'success');
    } catch (error) {
      report(CATEGORY.IMPORT_EXPORT, error, { scope: 'share-code', notify: false });
      setShareStatus('共有コードをコピーできませんでした。プレイリストを短くして、もう一度試してください。', 'error');
    }
  }

  async function importShareCode() {
    try {
      const decoded = window.PlayPocketShare.parseCode(el.codeInput?.value || '');
      if (decoded?.version !== 1 || decoded?.kind !== 'playlist-metadata') {
        throw new PPError('invalid', 'invalid-share-code', { category: CATEGORY.IMPORT_EXPORT });
      }
      const imported = await importPlaylistPayload(decoded.playlist, ' (shared)');
      if (el.codeInput) el.codeInput.value = '';
      setShareStatus(`「${imported.name}」を読み込みました。動画データは含まれません。`, 'success');
    } catch (error) {
      report(CATEGORY.IMPORT_EXPORT, error, { scope: 'share-code-import', notify: false });
      setShareStatus('共有コードを読み込めませんでした。コード全体を貼り付けてください。', 'error');
    }
  }

  async function exportPlaylist(includeBlobs) {
    if (!state.currentPlaylist) {
      PP.ui.alert('プレイリストを選択してください');
      return;
    }
    try {
      if (includeBlobs) await assertEmbeddedExportAllowed();
      const { name, blob } = await buildExportBlob({ includeBlobs });
      const suffix = includeBlobs ? '.playlist.full.json' : '.playlist.json';
      const result = await media.downloadBlob(blob, `${util.sanitizeFilename(name)}${suffix}`);
      if (result === 'failed') PP.ui.alert('エクスポートに失敗しました。空き容量を確認して、もう一度お試しください。');
    } catch (error) {
      if (error && error.code === 'device-too-large') {
        report(CATEGORY.USER_INPUT, error, {
          scope: 'export',
          message: 'このプレイリストは動画の合計サイズが大きく、この端末では埋め込みエクスポートに失敗する可能性があります。動画を減らすか、埋め込みなしのエクスポートをお使いください。'
        });
        return;
      }
      report(CATEGORY.IMPORT_EXPORT, error, { scope: 'export', message: 'エクスポートに失敗しました' });
    }
  }

  async function importFromFile(file) {
    const maxBytes = file.name.toLowerCase().endsWith(C.SHARE_PACKAGE_EXTENSION)
      ? C.MAX_SHARED_PACKAGE_BYTES
      : C.MAX_IMPORTED_JSON_BYTES;
    if (file.size > maxBytes) throw new PPError('file-too-large', 'file-too-large', { category: CATEGORY.IMPORT_EXPORT });
    let text = await file.text();
    const payload = PPSchema.safeJsonParse(text);
    text = null;
    if (!PPSchema.isPlainObject(payload)) throw new PPError('invalid', 'invalid', { category: CATEGORY.IMPORT_EXPORT });
    return importPlaylistPayload(payload, ' (import)');
  }

  function clearDragOver() {
    if (dragOverEl) {
      dragOverEl.classList.remove('drag-over');
      dragOverEl = null;
    }
  }

  function bindTrackList() {
    el.trackList.addEventListener('click', guard(CATEGORY.SYSTEM, async (event) => {
      const li = event.target.closest('.track-item');
      if (!li) return;
      if (event.target.closest('.play-now')) {
        await PP.player.playTrackById(li.dataset.id);
      } else if (event.target.closest('.remove')) {
        await removeTrackAt(parseInt(li.dataset.index, 10), li.dataset.id);
      }
    }, { scope: 'track-list' }));

    el.trackList.addEventListener('dragstart', (event) => {
      const li = event.target.closest('.track-item');
      if (!li) return;
      event.dataTransfer.setData('text/plain', li.dataset.index);
      event.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });

    el.trackList.addEventListener('dragend', (event) => {
      event.target.closest?.('.track-item')?.classList.remove('dragging');
      clearDragOver();
    });

    el.trackList.addEventListener('dragover', (event) => {
      const li = event.target.closest('.track-item');
      if (!li) return;
      event.preventDefault();
      if (dragOverEl && dragOverEl !== li) dragOverEl.classList.remove('drag-over');
      li.classList.add('drag-over');
      dragOverEl = li;
    });

    el.trackList.addEventListener('dragleave', (event) => {
      const li = event.target.closest('.track-item');
      if (li && !li.contains(event.relatedTarget)) li.classList.remove('drag-over');
    });

    el.trackList.addEventListener('drop', guard(CATEGORY.SYSTEM, async (event) => {
      const li = event.target.closest('.track-item');
      if (!li) return;
      event.preventDefault();
      clearDragOver();
      const fromIndex = parseInt(event.dataTransfer.getData('text/plain'), 10);
      const toIndex = parseInt(li.dataset.index, 10);
      if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) return;
      await reorderTrack(fromIndex, toIndex);
    }, { scope: 'reorder' }));
  }

  function bindPlaylists() {
    el.playlists.addEventListener('click', guard(CATEGORY.SYSTEM, async (event) => {
      const li = event.target.closest('.playlist-item');
      if (!li || !el.playlists.contains(li)) return;
      const name = li.dataset.name;
      if (event.target.closest('button')) {
        event.stopPropagation();
        await deletePlaylist(name);
      } else if (event.target.closest('.playlist-name')) {
        event.stopPropagation();
        await selectPlaylist(name);
      }
    }, { scope: 'playlists' }));

    const renameEvent = PP.platform.capabilities.renameGesture === 'dblclick' ? 'dblclick' : 'contextmenu';
    el.playlists.addEventListener(renameEvent, guard(CATEGORY.SYSTEM, async (event) => {
      const li = event.target.closest('.playlist-item');
      if (!li || !event.target.closest('.playlist-name')) return;
      event.preventDefault();
      event.stopPropagation();
      await renamePlaylist(li.dataset.name);
    }, { scope: 'rename' }));
  }

  function bindFileInputs() {
    el.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      el.dropZone.classList.add('drag');
    });
    el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag'));
    el.dropZone.addEventListener('drop', guard(CATEGORY.SYSTEM, async (event) => {
      event.preventDefault();
      el.dropZone.classList.remove('drag');
      await addFiles(event.dataTransfer.files);
    }, { scope: 'drop' }));

    el.fileInput.addEventListener('change', guard(CATEGORY.SYSTEM, async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      await addFiles(files);
    }, { scope: 'file-input' }));

    el.importFile.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        await importFromFile(file);
      } catch (error) {
        report(CATEGORY.IMPORT_EXPORT, error, { scope: 'import', message: 'インポートに失敗しました' });
      } finally {
        el.importFile.value = '';
      }
    });
  }

  function bindShare() {
    el.shareBtn?.addEventListener('click', () => {
      if (!state.currentPlaylist) {
        PP.ui.alert('共有するプレイリストを選択してください');
        return;
      }
      openShareModal();
    });
    el.closeShare?.addEventListener('click', closeShareModal);
    el.shareModal?.addEventListener('click', (event) => {
      if (event.target === el.shareModal) closeShareModal();
    });
    el.downloadShare?.addEventListener('click', downloadSharePackage);
    el.copyCode?.addEventListener('click', copyShareCode);
    el.importCode?.addEventListener('click', importShareCode);
    el.exportMeta?.addEventListener('click', () => exportPlaylist(false));
    el.exportBlobs?.addEventListener('click', () => exportPlaylist(true));
  }

  function init() {
    bindTrackList();
    bindPlaylists();
    bindFileInputs();
    bindShare();
    el.createBtn.addEventListener('click', guard(CATEGORY.SYSTEM, () => createPlaylist(), { scope: 'create-playlist' }));
    bus.on('player:track-changed', updateHighlight);
  }

  async function bootstrap(preferredPlaylist) {
    let playlists = await db.listPlaylists();
    if (playlists.length === 0) {
      await db.createPlaylist('Default', { failIfExists: false });
      playlists = await db.listPlaylists();
    }
    const preferred = preferredPlaylist ? playlists.find((playlist) => playlist.name === preferredPlaylist) : null;
    state.currentPlaylist = (preferred || playlists[0]).name;
    await loadCurrent();
    await refreshAll();
  }

  PP.library = Object.freeze({
    init,
    bootstrap,
    addFiles,
    importPlaylistPayload,
    buildExportBlob,
    refreshAll,
    refreshTrackList,
    isShareModalOpen,
    closeShareModal,
    loadCurrent
  });
}());
