/* Luu tru qua chrome.storage.local: history, savedWords, favorites, settings. */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  const KEY = 'sd_data_v1';
  const DEFAULTS = {
    settings: { repeat: 3, autoNext: true, autoRecord: true, segPause: true, rate: 1, offsetMs: 0, engine: 'webspeech', whisperModel: 'auto', useSileroVad: false, nativeLang: 'vi', targetLang: 'de', videoSubs: true, extEnabled: true, autoOpenPanel: true, uiLang: 'vi', deeplKey: '', openrouterKey: '',
      // Kiểu phụ đề trên video (Language Reactor style) — chỉnh trong bánh răng ⚙ trên player.
      subStyle: { font: 'sans', deColor: '#ffffff', trColor: '#ffd966', sizePct: 100, bgColor: '#000000', bgOpacity: 0, winColor: '#000000', winOpacity: 80 } },
    history: [], savedWords: [], favorites: [], savedSentences: [],
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
  async function updateWord(word, fields) { const d = await get(); const w = (d.savedWords || []).find((x) => x.word === word); if (w) { Object.assign(w, fields || {}); await set(d); } return d.savedWords; }
  async function saveSettings(s) { const d = await get(); d.settings = Object.assign({}, d.settings, s); await set(d); return d.settings; }
  async function toggleFavorite(text, extra) {
    const d = await get();
    const i = d.favorites.findIndex((f) => f.text === text);
    let on;
    if (i >= 0) { d.favorites.splice(i, 1); on = false; } else { d.favorites.unshift({ text, at: Date.now() }); on = true; }
    // ⭐ cũng LƯU CÂU vào kho "câu đã lưu" (dùng cho ôn tập/game). Đồng bộ theo trạng thái favorite.
    d.savedSentences = d.savedSentences || [];
    const j = d.savedSentences.findIndex((s) => s.text === text);
    if (on && j < 0) d.savedSentences.unshift(Object.assign({ text, at: Date.now() }, extra || {}));
    else if (!on && j >= 0) d.savedSentences.splice(j, 1);
    await set(d); return d.favorites;
  }
  async function getFavorites() { return (await get()).favorites; }
  function isFavoriteList(favs, text) { return favs.some((f) => f.text === text); }
  // Kho "câu đã lưu" (độc lập favorite, dùng cho game ôn câu).
  async function saveSentence(s) { const d = await get(); d.savedSentences = d.savedSentences || []; if (!d.savedSentences.find((x) => x.text === s.text)) { d.savedSentences.unshift(Object.assign({ at: Date.now() }, s)); await set(d); } return d.savedSentences; }
  async function removeSentence(text) { const d = await get(); d.savedSentences = (d.savedSentences || []).filter((x) => x.text !== text); await set(d); return d.savedSentences; }
  async function getSentences() { return (await get()).savedSentences || []; }
  root.SD.storage = { get, set, addAttempt, saveWord, removeWord, updateWord, saveSettings, toggleFavorite, getFavorites, isFavoriteList, saveSentence, removeSentence, getSentences };
})(window);
