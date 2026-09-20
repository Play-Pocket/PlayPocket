(function () {
  'use strict';

  const PP = window.PP;
  const { C, log, PPError, CATEGORY, util } = PP;

  const OPEN_ATTEMPTS = 3;
  const V = C.STORE_VIDEOS;
  const P = C.STORE_PLAYLISTS;

  const MIGRATIONS = {
    1(idb) {
      if (!idb.objectStoreNames.contains(V)) idb.createObjectStore(V, { keyPath: 'id' });
      if (!idb.objectStoreNames.contains(P)) idb.createObjectStore(P, { keyPath: 'name' });
    }
  };

  let handle = null;
  let opening = null;
  let busyCount = 0;

  function toDbError(error, code) {
    if (error instanceof PPError) return error;
    const name = error && error.name;
    let resolved = code || 'db-error';
    if (name === 'QuotaExceededError') resolved = 'quota';
    else if (name === 'VersionError') resolved = 'version';
    else if (name === 'AbortError' && !code) resolved = 'aborted';
    return new PPError(resolved, (error && error.message) || resolved, { category: CATEGORY.DATABASE, cause: error });
  }

  function openOnce() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(C.DB_NAME, C.DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = (event) => {
        const idb = request.result;
        const target = event.newVersion || C.DB_VERSION;
        for (let version = event.oldVersion + 1; version <= target; version++) {
          const step = MIGRATIONS[version];
          if (step) step(idb, request.transaction);
        }
      };
      request.onblocked = () => log.warn('db', 'open blocked by another connection');
      request.onsuccess = () => {
        const idb = request.result;
        idb.onversionchange = () => {
          idb.close();
          if (handle === idb) handle = null;
        };
        idb.onclose = () => {
          if (handle === idb) handle = null;
        };
        resolve(idb);
      };
      request.onerror = () => reject(request.error || new Error('open failed'));
    });
  }

  async function open() {
    if (handle) return handle;
    if (opening) return opening;
    opening = (async () => {
      let lastError;
      for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
        try {
          handle = await openOnce();
          return handle;
        } catch (error) {
          lastError = error;
          if (error && error.name === 'VersionError') break;
          await util.delay(150 * (attempt + 1) * (attempt + 1));
        }
      }
      throw toDbError(lastError, 'open-failed');
    })();
    try {
      return await opening;
    } finally {
      opening = null;
    }
  }

  function close() {
    if (handle) {
      try { handle.close(); } catch {}
      handle = null;
    }
  }

  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('request failed'));
    });
  }

  function runOnce(idb, storeNames, mode, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = idb.transaction(storeNames, mode);
      } catch (error) {
        const wrapped = toDbError(error);
        if (error && error.name === 'InvalidStateError') wrapped.retryable = true;
        reject(wrapped);
        return;
      }

      let value;
      let failure = null;
      tx.oncomplete = () => (failure ? reject(failure) : resolve(value));
      tx.onabort = () => reject(failure || toDbError(tx.error || new Error('transaction aborted'), 'aborted'));
      tx.onerror = () => {};

      let running;
      try {
        running = Promise.resolve(work(tx));
      } catch (error) {
        running = Promise.reject(error);
      }
      running.then(
        (result) => { value = result; },
        (error) => {
          failure = toDbError(error);
          try { tx.abort(); } catch {}
        }
      );
    });
  }

  async function run(storeNames, mode, work) {
    let retried = false;
    for (;;) {
      const idb = await open();
      try {
        return await runOnce(idb, storeNames, mode, work);
      } catch (error) {
        if (!retried && error && error.retryable) {
          retried = true;
          if (handle === idb) handle = null;
          try { idb.close(); } catch {}
          continue;
        }
        throw error;
      }
    }
  }

  async function mutate(storeNames, work) {
    busyCount += 1;
    try {
      return await run(storeNames, 'readwrite', work);
    } finally {
      busyCount -= 1;
    }
  }

  async function batch(fn) {
    busyCount += 1;
    try {
      return await fn();
    } finally {
      busyCount -= 1;
    }
  }

  function referencedIds(playlists) {
    const refs = new Set();
    for (const pl of playlists) {
      if (pl && Array.isArray(pl.items)) {
        for (const id of pl.items) refs.add(id);
      }
    }
    return refs;
  }

  function normalizePlaylistRecord(record) {
    if (!record || typeof record.name !== 'string' || !Array.isArray(record.items)) return null;
    return { name: record.name, items: record.items.filter((id) => typeof id === 'string') };
  }

  function toInfo(record) {
    if (!record || typeof record.id !== 'string') return null;
    const duration = Number(record.duration);
    const size = Number(record.size);
    const norm = Number(record.normGain);
    return {
      id: record.id,
      name: util.safeText(record.name) || 'video',
      duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      mimeType: util.sanitizeMimeType(record.mimeType),
      thumbnail: util.sanitizeThumbnail(record.thumbnail),
      hasBlob: typeof Blob !== 'undefined' && record.blob instanceof Blob,
      normGain: Number.isFinite(norm) && norm > 0 ? norm : null
    };
  }

  async function getVideo(id) {
    if (typeof id !== 'string' || !id) return null;
    return run(V, 'readonly', (tx) => req(tx.objectStore(V).get(id)));
  }

  async function getVideoInfos(ids) {
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id)));
    if (unique.length === 0) return [];
    const records = await run(V, 'readonly', (tx) => {
      const store = tx.objectStore(V);
      return Promise.all(unique.map((id) => req(store.get(id))));
    });
    const infos = [];
    for (const record of records) {
      const info = toInfo(record);
      if (info) infos.push(info);
    }
    return infos;
  }

  async function putVideo(record) {
    return mutate(V, (tx) => req(tx.objectStore(V).put(record)));
  }

  async function deleteVideos(ids) {
    if (!ids || ids.length === 0) return 0;
    return mutate(V, (tx) => {
      const store = tx.objectStore(V);
      for (const id of ids) store.delete(id);
      return ids.length;
    });
  }

  async function listPlaylists() {
    const records = await run(P, 'readonly', (tx) => req(tx.objectStore(P).getAll()));
    const out = [];
    for (const record of Array.isArray(records) ? records : []) {
      const pl = normalizePlaylistRecord(record);
      if (pl && util.normalizePlaylistName(pl.name)) out.push(pl);
    }
    return out;
  }

  async function getPlaylist(name) {
    if (typeof name !== 'string' || !name) return null;
    const record = await run(P, 'readonly', (tx) => req(tx.objectStore(P).get(name)));
    return normalizePlaylistRecord(record);
  }

  async function createPlaylist(name, { failIfExists = true } = {}) {
    return mutate(P, async (tx) => {
      const store = tx.objectStore(P);
      const existing = await req(store.get(name));
      if (existing) {
        if (failIfExists) throw new PPError('exists', 'exists', { category: CATEGORY.USER_INPUT });
        return normalizePlaylistRecord(existing);
      }
      const record = { name, items: [] };
      store.put(record);
      return record;
    });
  }

  async function putPlaylist(record) {
    return mutate(P, (tx) => req(tx.objectStore(P).put({ name: record.name, items: record.items.slice() })));
  }

  async function renamePlaylist(oldName, newName) {
    if (!oldName || !newName) throw new PPError('invalid', 'invalid', { category: CATEGORY.USER_INPUT });
    if (oldName === newName) return false;
    return mutate(P, async (tx) => {
      const store = tx.objectStore(P);
      const current = normalizePlaylistRecord(await req(store.get(oldName)));
      if (!current) throw new PPError('notfound', 'notfound', { category: CATEGORY.DATABASE });
      const clash = await req(store.get(newName));
      if (clash) throw new PPError('exists', 'exists', { category: CATEGORY.USER_INPUT });
      store.put({ name: newName, items: current.items });
      store.delete(oldName);
      return true;
    });
  }

  async function addVideoToPlaylist(record, playlistName) {
    return mutate([V, P], async (tx) => {
      const playlists = tx.objectStore(P);
      const videos = tx.objectStore(V);
      const existing = normalizePlaylistRecord(await req(playlists.get(playlistName)));
      const playlist = existing || { name: playlistName, items: [] };
      videos.put(record);
      playlist.items.push(record.id);
      playlists.put(playlist);
      return playlist.items.slice();
    });
  }

  async function removeTrack(playlistName, index, expectedId) {
    return mutate([V, P], async (tx) => {
      const playlists = tx.objectStore(P);
      const videos = tx.objectStore(V);
      const playlist = normalizePlaylistRecord(await req(playlists.get(playlistName)));
      if (!playlist) return { items: [], removedId: null, deletedVideoId: null };

      let position = index;
      if (expectedId && playlist.items[position] !== expectedId) position = playlist.items.indexOf(expectedId);
      if (position < 0 || position >= playlist.items.length) {
        return { items: playlist.items.slice(), removedId: null, deletedVideoId: null };
      }

      const [removedId] = playlist.items.splice(position, 1);
      playlists.put(playlist);
      const all = await req(playlists.getAll());
      let deletedVideoId = null;
      if (!referencedIds(all).has(removedId)) {
        videos.delete(removedId);
        deletedVideoId = removedId;
      }
      return { items: playlist.items.slice(), removedId, deletedVideoId };
    });
  }

  async function deletePlaylist(name) {
    return mutate([V, P], async (tx) => {
      const playlists = tx.objectStore(P);
      const videos = tx.objectStore(V);
      const playlist = normalizePlaylistRecord(await req(playlists.get(name)));
      playlists.delete(name);
      const remaining = await req(playlists.getAll());
      const refs = referencedIds(remaining);
      const deletedVideoIds = [];
      if (playlist) {
        for (const id of playlist.items) {
          if (!refs.has(id)) {
            videos.delete(id);
            deletedVideoIds.push(id);
          }
        }
      }
      return { deletedVideoIds, remainingNames: remaining.map((r) => r.name).filter((n) => typeof n === 'string') };
    });
  }

  async function reorderPlaylist(name, fromIndex, toIndex) {
    return mutate(P, async (tx) => {
      const store = tx.objectStore(P);
      const playlist = normalizePlaylistRecord(await req(store.get(name)));
      if (!playlist) return null;
      if (fromIndex < 0 || fromIndex >= playlist.items.length || toIndex < 0 || toIndex >= playlist.items.length) {
        return playlist.items.slice();
      }
      const [moved] = playlist.items.splice(fromIndex, 1);
      playlist.items.splice(toIndex, 0, moved);
      store.put(playlist);
      return playlist.items.slice();
    });
  }

  async function pruneOrphanVideos() {
    if (busyCount > 0) return 0;
    return mutate([V, P], async (tx) => {
      if (busyCount > 1) return 0;
      const videos = tx.objectStore(V);
      const keys = await req(videos.getAllKeys());
      const playlists = await req(tx.objectStore(P).getAll());
      const refs = referencedIds(playlists);
      let removed = 0;
      for (const key of keys) {
        if (!refs.has(key)) {
          videos.delete(key);
          removed += 1;
        }
      }
      return removed;
    });
  }

  PP.db = Object.freeze({
    open,
    close,
    batch,
    isBusy: () => busyCount > 0,
    toInfo,
    getVideo,
    getVideoInfos,
    putVideo,
    deleteVideos,
    listPlaylists,
    getPlaylist,
    createPlaylist,
    putPlaylist,
    renamePlaylist,
    addVideoToPlaylist,
    removeTrack,
    deletePlaylist,
    reorderPlaylist,
    pruneOrphanVideos
  });
}());
