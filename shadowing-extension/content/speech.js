/* Speech proxy: microphone capture runs in the extension side panel. */
(function (root) {
  'use strict';
  root.SD = root.SD || {};
  let onProgress = null;

  async function request(action, opts) {
    try {
      const response = await chrome.runtime.sendMessage({ sd: 'mic-service', action, opts: opts || {} });
      if (!response || !response.ok) throw new Error((response && response.error) || 'side-panel-unavailable');
      return response;
    } catch (error) {
      throw new Error('mic:' + (error.message || error));
    }
  }

  async function ensureMic() { await request('ensure'); return true; }
  function setProgress(cb) { onProgress = cb; }
  async function recognize(opts) {
    try { return (await request('recognize', opts)).result; }
    catch (error) {
      const message = error.message || String(error);
      if ((opts.engine || 'webspeech') === 'server') return { error: 'server-unavailable:' + message };
      if (opts.engine === 'whisper') return { error: 'whisper-unavailable:' + message };
      return { error: message };
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.sd === 'mic-progress' && onProgress) onProgress(msg.status, msg.pct);
  });
  root.SD.speech = { ensureMic, recognize, setProgress };
})(window);
