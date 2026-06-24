/* Luu tru qua chrome.storage.local: history, savedWords, favorites, settings. */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  const KEY = 'sd_data_v1';
  const DEFAULTS = {
    settings: { repeat: 3, autoNext: true, autoRecord: true, segPause: true, rate: 1, offsetMs: 0, engine: 'webspeech', whisperModel: 'auto', useSileroVad: false, nativeLang: 'vi', targetLang: 'de', videoSubs: true, extEnabled: true, uiLang: 'vi', deeplKey: '', openrouterKey: '' },
    history: [], savedWords: [], favorites: [],
  };
  function get() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(KEY, (r) => {
          const d = (r && r[KEY]) || {};
          resolve(Object.assign({}, DEFAULTS, d, { settings: Object.assign({}, DEFAULTS.settings, d.settings || {}) }));
        });
      } catch (e) { resolve(JSON.parse(JSON.stringify(DEFAULTS))); }
    });
  }
  function set(data) { return new Promise((resolve) => { try { chrome.storage.local.set({ [KEY]: data }, resolve); } catch (e) { resolve(); } }); }
  async function addAttempt(a) { const d = await get(); d.history.unshift(Object.assign({ at: Date.now() }, a)); d.history = d.history.slice(0, 500); await set(d); return d.history; }
  async function saveWord(w) { const d = await get(); if (!d.savedWords.find((x) => x.word === w.word)) { d.savedWords.unshift(Object.assign({ at: Date.now() }, w)); await set(d); } return d.savedWords; }
  async function removeWord(word) { const d = await get(); d.savedWords = (d.savedWords || []).filter((x) => x.word !== word); await set(d); return d.savedWords; }
  async function saveSettings(s) { const d = await get(); d.settings = Object.assign({}, d.settings, s); await set(d); return d.settings; }
  async function toggleFavorite(text) { const d = await get(); const i = d.favorites.findIndex((f) => f.text === text); if (i >= 0) d.favorites.splice(i, 1); else d.favorites.unshift({ text, at: Date.now() }); await set(d); return d.favorites; }
  async function getFavorites() { return (await get()).favorites; }
  function isFavoriteList(favs, text) { return favs.some((f) => f.text === text); }
  root.SD.storage = { get, set, addAttempt, saveWord, removeWord, saveSettings, toggleFavorite, getFavorites, isFavoriteList };
})(window);
