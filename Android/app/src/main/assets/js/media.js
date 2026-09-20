(function () {
  'use strict';

  const PP = window.PP;
  const { C, log } = PP;

  const NORM_KEY = 'playpocket-norm-v1';
  const NORM_MAX_ENTRIES = 5000;
  const PROBE_METADATA_TIMEOUT_MS = 8000;
  const PROBE_THUMBNAIL_TIMEOUT_MS = 3000;
  const DOWNLOAD_REVOKE_DELAY_MS = 60000;
  const BASE64_DECODE_CHUNK_CHARS = 4 * 1024 * 1024;
  const BASE64_WHOLE_DECODE_LIMIT_CHARS = 64 * 1024 * 1024;

  const registry = new Map();

  const urls = {
    create(blob, owner = 'anonymous') {
      const url = URL.createObjectURL(blob);
      registry.set(url, owner);
      return url;
    },
    revoke(url) {
      if (!url) return;
      try { URL.revokeObjectURL(url); } catch {}
      registry.delete(url);
    },
    revokeOwner(owner) {
      for (const [url, entryOwner] of Array.from(registry.entries())) {
        if (entryOwner === owner) urls.revoke(url);
      }
    },
    revokeAll() {
      for (const url of Array.from(registry.keys())) urls.revoke(url);
    },
    count(owner) {
      if (owner === undefined) return registry.size;
      let n = 0;
      for (const entryOwner of registry.values()) {
        if (entryOwner === owner) n += 1;
      }
      return n;
    }
  };

  function probeVideo(file) {
    return new Promise((resolve) => {
      const url = urls.create(file, 'probe');
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      let settled = false;
      let duration = 0;
      let thumbTimer = null;

      const finish = (thumbnail) => {
        if (settled) return;
        settled = true;
        clearTimeout(metaTimer);
        clearTimeout(thumbTimer);
        try {
          video.removeAttribute('src');
          video.load();
        } catch {}
        urls.revoke(url);
        resolve({ duration, thumbnail });
      };

      const metaTimer = setTimeout(() => finish(null), PROBE_METADATA_TIMEOUT_MS);

      video.addEventListener('loadedmetadata', () => {
        duration = Number.isFinite(video.duration) ? video.duration : 0;
        thumbTimer = setTimeout(() => finish(null), PROBE_THUMBNAIL_TIMEOUT_MS);
      });
      video.addEventListener('loadeddata', () => {
        try {
          video.currentTime = 0.1;
        } catch {
          finish(null);
        }
      });
      video.addEventListener('seeked', () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const ctx = canvas.getContext('2d');
          if (!ctx) return finish(null);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.7));
        } catch {
          finish(null);
        }
      });
      video.addEventListener('error', () => finish(null));
      video.src = url;
    });
  }

  function sliceToBase64(slice) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : '');
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(slice);
    });
  }

  async function blobToBase64Parts(blob, chunkBytes = C.BASE64_CHUNK_BYTES) {
    const step = Math.max(3, chunkBytes - (chunkBytes % 3));
    const parts = [];
    for (let offset = 0; offset < blob.size; offset += step) {
      const text = await sliceToBase64(blob.slice(offset, offset + step));
      parts.push(new Blob([text]));
    }
    return parts;
  }

  function decodeChunk(text) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function base64ToBlob(base64, type) {
    if (typeof base64 !== 'string' || !base64) throw new Error('invalid base64');
    const mime = PP.util.sanitizeMimeType(type);
    try {
      if (base64.length % 4 !== 0) {
        if (base64.length > BASE64_WHOLE_DECODE_LIMIT_CHARS) throw new Error('invalid base64');
        return new Blob([decodeChunk(base64)], { type: mime });
      }
      const parts = [];
      for (let i = 0; i < base64.length; i += BASE64_DECODE_CHUNK_CHARS) {
        parts.push(decodeChunk(base64.slice(i, i + BASE64_DECODE_CHUNK_CHARS)));
      }
      return new Blob(parts, { type: mime });
    } catch (error) {
      throw new Error('invalid base64');
    }
  }

  async function downloadBlob(blob, filename) {
    if (PP.platform && typeof PP.platform.saveFile === 'function') {
      const result = await PP.platform.saveFile(blob, filename);
      if (result !== 'unsupported') return result;
    }
    const anchor = document.createElement('a');
    const url = urls.create(blob, 'download');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => urls.revoke(url), DOWNLOAD_REVOKE_DELAY_MS);
    return 'saved';
  }

  let normMap = null;
  let normTimer = null;

  function loadNorm() {
    if (normMap) return normMap;
    normMap = new Map();
    try {
      const raw = localStorage.getItem(NORM_KEY);
      if (raw) {
        const parsed = PPSchema.safeJsonParse(raw);
        if (PPSchema.isPlainObject(parsed)) {
          for (const [id, gain] of Object.entries(parsed)) {
            if (typeof gain === 'number' && Number.isFinite(gain) && gain > 0) normMap.set(id, gain);
          }
        }
      }
    } catch (error) {
      log.warn('norm', error);
    }
    return normMap;
  }

  function persistNorm() {
    normTimer = null;
    try {
      const map = loadNorm();
      while (map.size > NORM_MAX_ENTRIES) map.delete(map.keys().next().value);
      localStorage.setItem(NORM_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch (error) {
      log.warn('norm', error);
    }
  }

  function scheduleNormPersist() {
    if (normTimer) return;
    normTimer = setTimeout(persistNorm, 500);
  }

  const norm = {
    get(id) {
      const gain = loadNorm().get(id);
      return Number.isFinite(gain) ? gain : null;
    },
    set(id, gain) {
      if (typeof id !== 'string' || !Number.isFinite(gain) || gain <= 0) return;
      const map = loadNorm();
      map.delete(id);
      map.set(id, gain);
      scheduleNormPersist();
    },
    remove(ids) {
      const map = loadNorm();
      let changed = false;
      for (const id of ids) changed = map.delete(id) || changed;
      if (changed) scheduleNormPersist();
    },
    flush() {
      if (normTimer) {
        clearTimeout(normTimer);
        persistNorm();
      }
    }
  };

  PP.media = Object.freeze({
    urls,
    probeVideo,
    sliceToBase64,
    blobToBase64Parts,
    base64ToBlob,
    downloadBlob,
    norm
  });
}());
