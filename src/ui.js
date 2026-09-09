/* Absolute Cinema — settings UI, used as both the toolbar popup and the
   options page. Writes straight to storage; content scripts pick up changes
   through storage.onChanged, so there is nothing to message. */
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;

  const DEFAULTS = {
    enabled: true,
    quality: 'hd2160',
    fpsCap: 0,
    fpsMode: 'cinematic',
    badge: true,
    diag: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const radios = (name) =>
    [...document.querySelectorAll(`input[name="${name}"]`)];

  const els = {
    enabled: $('#enabled'),
    quality: $('#quality'),
    badge: $('#badge'),
    diag: $('#diag'),
    warn: $('#warn'),
    saved: $('#saved'),
  };

  /* Settings are written to BOTH storage areas, deliberately.
     content.js loads by merging local then sync, letting sync win. If the
     popup were to write only local — because sync threw, is disabled, or the
     Firefox gecko id is missing — a stale sync value would beat every save on
     the next page load: the setting would appear to apply live (onChanged
     fires) and then silently revert on reload. Writing both keeps the two
     areas from ever disagreeing. */

  async function read() {
    const merged = { ...DEFAULTS };
    for (const a of ['local', 'sync']) {
      try {
        const got = await api.storage[a].get(null);
        if (!got) continue;
        for (const k of Object.keys(DEFAULTS)) if (k in got) merged[k] = got[k];
      } catch {}
    }
    return merged;
  }

  function render(s) {
    els.enabled.checked = !!s.enabled;
    els.quality.value = s.quality;
    els.badge.checked = !!s.badge;
    els.diag.checked = !!s.diag;
    for (const r of radios('fps')) r.checked = Number(r.value) === Number(s.fpsCap);
    for (const r of radios('mode')) r.checked = r.value === s.fpsMode;
    reflect();
  }

  function collect() {
    const fps = radios('fps').find((r) => r.checked);
    const mode = radios('mode').find((r) => r.checked);
    return {
      enabled: els.enabled.checked,
      quality: els.quality.value,
      fpsCap: fps ? Number(fps.value) : 0,
      fpsMode: mode ? mode.value : 'cinematic',
      badge: els.badge.checked,
      diag: els.diag.checked,
    };
  }

  /** Surface the resolution cliff only when it can actually bite. */
  function reflect() {
    const s = collect();
    els.warn.hidden = !(s.fpsMode === 'stream' && s.fpsCap > 0);
    document.body.classList.toggle('is-off', !s.enabled);
  }

  let flash = 0;
  async function save() {
    reflect();
    const s = collect();
    const results = await Promise.allSettled([
      api.storage.local.set(s),
      api.storage.sync.set(s),
    ]);
    if (results.every((r) => r.status === 'rejected')) {
      els.saved.textContent = 'Could not save';
      return;
    }
    els.saved.textContent = 'Saved';
    clearTimeout(flash);
    flash = setTimeout(() => {
      els.saved.textContent = 'Saves automatically';
    }, 1200);
  }

  document.addEventListener('change', (e) => {
    if (e.target.closest('.wrap')) save();
  });

  read().then(render);
})();
