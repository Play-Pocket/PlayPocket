(function () {
  'use strict';

  const PP = window.PP;
  const { CATEGORY, report, util } = PP;

  let platformName = null;
  let current = null;
  let queue = Promise.resolve();
  let bound = false;

  function ensureReady() {
    if (!current) throw new Error('settings not initialised');
  }

  function init(initial) {
    platformName = PP.platform.name;
    current = PPSchema.normalizeSettings(initial, platformName);
    return current;
  }

  function get() {
    ensureReady();
    return current;
  }

  function syncUI() {
    ensureReady();
    for (const def of PPSchema.defsFor(platformName)) {
      const el = util.byId(def.key);
      if (!el) continue;
      const value = current[def.key];
      if (def.type === 'boolean') el.checked = !!value;
      else el.value = String(value);
    }
    const duration = current.crossfadeDuration;
    const label = util.byId('crossfadeDurationValue');
    if (label) label.textContent = String(duration);
    const row = util.byId('crossfadeDurationRow');
    if (row) row.classList.toggle('disabled', !current.crossfadeEnabled);
  }

  function applyResult(prev, patch, next, source) {
    current = next;
    syncUI();
    PP.bus.emit('settings', { prev, next, patch, source });
  }

  function set(partial) {
    ensureReady();
    const patch = PPSchema.sanitizeSettingsPatch(partial, platformName);
    if (Object.keys(patch).length === 0) return Promise.resolve(current);

    const run = async () => {
      const prev = current;
      let next = { ...prev, ...patch };
      try {
        const saved = await PP.platform.saveSettings(patch);
        if (saved && typeof saved === 'object') next = PPSchema.normalizeSettings(saved, platformName);
      } catch (error) {
        report(CATEGORY.IPC, error, { scope: 'settings', notify: false });
      }
      applyResult(prev, patch, next, 'user');
      return next;
    };

    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  function bindUI() {
    ensureReady();
    if (bound) return;
    bound = true;

    for (const def of PPSchema.defsFor(platformName)) {
      const el = util.byId(def.key);
      if (!el) continue;

      if (def.type === 'boolean') {
        el.addEventListener('change', PP.guard(CATEGORY.SYSTEM, () => set({ [def.key]: el.checked }), { scope: 'settings' }));
      } else if (def.type === 'enum') {
        el.addEventListener('change', PP.guard(CATEGORY.SYSTEM, () => set({ [def.key]: el.value }), { scope: 'settings' }));
      } else if (def.type === 'number') {
        el.addEventListener('input', () => {
          const label = util.byId('crossfadeDurationValue');
          if (label && def.key === 'crossfadeDuration') label.textContent = el.value;
        });
        el.addEventListener('change', PP.guard(CATEGORY.SYSTEM, () => set({ [def.key]: Number(el.value) }), { scope: 'settings' }));
      }
    }
    syncUI();
  }

  PP.settings = Object.freeze({ init, get, set, syncUI, bindUI, emitInitial: (next) => applyResult(next, {}, next, 'init') });
}());
