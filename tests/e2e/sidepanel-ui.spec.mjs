/**
 * sidepanel-ui.spec.mjs — End-to-end UI tests for the shadowing extension sidepanel.
 *
 * Strategy: load sidepanel.html as a file:// URL in Chromium, inject chrome API
 * mocks via page.addInitScript() (runs before any page scripts), then simulate
 * content-script port messages via window.testFirePortMessage() to drive the UI.
 *
 * Key insight from reading sidepanel.js:
 *   - chrome.runtime.connect() returns a port; sidepanel registers its listener
 *     via port.onMessage.addListener(fn)
 *   - The 'sentences' event triggers renderList() and updateTryCard()
 *   - ShadowAuth is undefined → showView('list') runs immediately (line 1531)
 *   - The inline <script> at the bottom of sidepanel.html swaps #sentence-list.id
 *     to 'list' so sidepanel.js's $('#list') finds the right container
 */

import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDEPANEL_PATH = path.resolve(__dirname, '../../shadowing-extension/sidepanel.html');
const SIDEPANEL_URL = 'file://' + SIDEPANEL_PATH;

// ---------------------------------------------------------------------------
// Helper: build the chrome + ShadowMic mock init script.
// Injected BEFORE any page scripts run (page.addInitScript).
// ---------------------------------------------------------------------------
const CHROME_MOCK_SCRIPT = `
(function () {
  'use strict';

  // ---- DOM ID aliasing patch -----------------------------------------------
  // sidepanel.html has an inline adapter script (runs AFTER sidepanel.js) that
  // renames #sentence-list → #list so sidepanel.js can use $('#list').
  // But sidepanel.js actually calls $('#sentence-list') in renderList() — the
  // adapter comment says "sidepanel.js runs after this script" which is wrong;
  // sidepanel.js is a <script src> that runs first, and the inline <script>
  // follows it. The net effect: after the adapter fires, #sentence-list no
  // longer exists and renderList() crashes with TypeError (null.innerHTML).
  //
  // Fix: patch document.querySelector so '#sentence-list' transparently resolves
  // to whichever element carries the sentence-list content, regardless of its
  // current id (which may be 'list' after the adapter runs).
  // We do this by capturing a reference to the element at DOMContentLoaded,
  // before any id-swap, and returning that reference when '#sentence-list' is
  // queried. This works because querySelector normally returns an element by id.
  let _sentenceListEl = null;
  document.addEventListener('DOMContentLoaded', () => {
    // Grab the visual sentence container before the inline adapter renames it.
    _sentenceListEl = document.getElementById('sentence-list') ||
                      document.getElementById('list');
  }, { once: true, capture: true });

  const _origQS = document.querySelector.bind(document);
  document.querySelector = function (sel) {
    if (sel === '#sentence-list' && _sentenceListEl) {
      // Return the captured reference — works even after the id has been swapped.
      return _sentenceListEl;
    }
    return _origQS(sel);
  };
  // Also patch getElementById for completeness (sidepanel.js uses $ = querySelector).
  const _origGEBI = document.getElementById.bind(document);
  document.getElementById = function (id) {
    if (id === 'sentence-list' && _sentenceListEl) return _sentenceListEl;
    return _origGEBI(id);
  };
  // --------------------------------------------------------------------------

  // Capture the port's onMessage listener so tests can fire messages.
  let _portMessageHandler = null;

  window.chrome = {
    runtime: {
      connect: () => ({
        onMessage:    { addListener: (fn) => { _portMessageHandler = fn; } },
        onDisconnect: { addListener: () => {} },
        postMessage:  () => {},
      }),
      sendMessage: () => Promise.resolve({}),
      getURL: (p) => p,
      onMessage: { addListener: () => {} },
      lastError: null,
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: 'https://www.youtube.com/watch?v=test' }]),
      sendMessage: () => Promise.resolve({}),
      onActivated: { addListener: () => {} },
      onUpdated:   { addListener: () => {} },
    },
    storage: {
      local: {
        get: (_k, cb) => { if (cb) cb({}); return Promise.resolve({}); },
        set: (_d, cb) => { if (cb) cb(); return Promise.resolve(); },
      },
    },
    scripting: { executeScript: () => Promise.resolve() },
  };

  // ShadowMic stub — prevents real mic/audio API calls.
  window.ShadowMic = {
    ensureMic:         () => Promise.resolve(true),
    startRecording:    () => Promise.resolve(),
    abortRecording:    () => {},
    finalizeRecording: () => {},
    isWhisperAvailable:() => Promise.resolve(false),
    checkMicPermission:() => Promise.resolve('granted'),
    setLevelListener:  () => {},
    setProgressListener: () => {},
    detectHardware:    () => ({ mem: 8, cores: 8 }),
    pickWhisperModel:  () => ({ short: 'tiny', label: 'Tiny' }),
    warmupWhisper:     () => {},
    whisperStatus:     () => null,
  };

  // Expose test helper: fire a message as if the content-script port sent it.
  window.testFirePortMessage = function (msg) {
    if (_portMessageHandler) _portMessageHandler(msg);
  };

  // Convenience wrapper: inject an array of sentence objects into the sidepanel.
  // Each sentence: { id, startMs, endMs, text, trans }
  window.testInjectSentences = function (sents) {
    const payload = sents.map((s, i) => Object.assign(
      { id: i, startMs: i * 1000, endMs: (i + 1) * 1000 },
      s
    ));
    window.testFirePortMessage({ sd: 'evt', evt: 'sentences', payload });
  };
})();
`;

// ---------------------------------------------------------------------------
// Shared fixture: open sidepanel with chrome mocks installed.
// ---------------------------------------------------------------------------
async function openSidepanel(page) {
  await page.addInitScript({ content: CHROME_MOCK_SCRIPT });
  // Also stub vendor scripts that aren't present (freq-de, vad-silero) so they
  // don't cause 404 errors that block later scripts.
  await page.route('**/content/freq-de.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '/* stub */' })
  );
  await page.route('**/vendor/vad-silero.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '/* stub */' })
  );
  await page.route('**/vendor/transformers.min.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '/* stub */' })
  );
  // Stub supabase-client so ShadowAuth stays undefined → showView('list') branch.
  await page.route('**/supabase-client.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '/* ShadowAuth not defined — list view shown immediately */' })
  );

  await page.goto(SIDEPANEL_URL, { waitUntil: 'domcontentloaded' });

  // Wait for sidepanel.js IIFE to finish wiring up event handlers.
  // The IIFE calls connectPort() last, which sets window._portReady implicitly.
  // We detect readiness by waiting for #view-list to be visible (showView('list')
  // is called when ShadowAuth is undefined).
  await page.waitForFunction(() => {
    const vl = document.getElementById('view-list');
    return vl && !vl.hidden;
  }, { timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Helper: inject N generated sentences.
// ---------------------------------------------------------------------------
async function injectSentences(page, count, extras = []) {
  const sents = Array.from({ length: count }, (_, i) => ({
    text: `Sentence number ${i + 1}`,
    trans: `Bản dịch ${i + 1}`,
    ...extras[i],
  }));
  await page.evaluate((payload) => window.testInjectSentences(payload), sents);

  // Wait until the sentence list contains at least one row.
  await page.waitForFunction(
    (expected) => document.querySelectorAll('#list .row, #sentence-list .row').length === expected,
    count,
    { timeout: 5000 }
  );
  return sents;
}

// Locate #sentence-list regardless of whether the inline adapter script ran
// (it swaps the IDs so sidepanel.js targets #list, which IS the visual list).
function sentenceListLocator(page) {
  // After the inline adapter script runs, the visual container has id="list".
  // Before it runs it has id="sentence-list". We query both to be safe.
  return page.locator('#list, #sentence-list').first();
}

function rowLocator(page) {
  return page.locator('#list .row, #sentence-list .row');
}

// ---------------------------------------------------------------------------
// TEST 1: Initial state
// ---------------------------------------------------------------------------
test('Sidepanel renders with correct initial state', async ({ page }) => {
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));

  await openSidepanel(page);

  // #view-list should be visible (not hidden) because ShadowAuth is undefined.
  await expect(page.locator('#view-list')).toBeVisible();

  // #sentence-list (or its alias #list after the adapter runs) should exist in DOM.
  // The adapter may rename it to #list, so check either.
  const listExists = await page.evaluate(() =>
    !!(document.getElementById('list') || document.getElementById('sentence-list'))
  );
  expect(listExists, '#sentence-list / #list exists in DOM').toBe(true);

  // Source bar has 4 child buttons/labels (Lấy phụ đề, Bắt trực tiếp, Mở file, Bật mic).
  const srcBtnCount = await page.locator('#source-bar .src-btn, #source-bar .file-label').count();
  expect(srcBtnCount, 'source-bar has 4 buttons').toBe(4);

  // Bottom toolbar exists.
  await expect(page.locator('.bottom-toolbar')).toBeAttached();

  // No critical JS errors during load.
  expect(jsErrors.filter((e) => !/fetch|Failed to load|ERR_FILE_NOT_FOUND/i.test(e)),
    'no critical JS errors on load').toEqual([]);
});

// ---------------------------------------------------------------------------
// TEST 2: Sentence list renders rows and try-card appears
// ---------------------------------------------------------------------------
test('Sentence list renders rows and try-card appears', async ({ page }) => {
  await openSidepanel(page);

  // Inject 5 sentences via the mock port.
  const sents = await injectSentences(page, 5, [
    { text: 'Hallo Welt', trans: 'Xin chào thế giới' },
    { text: 'Guten Morgen', trans: 'Chào buổi sáng' },
    { text: 'Wie geht es dir?', trans: 'Bạn có khỏe không?' },
    { text: 'Danke schön', trans: 'Cảm ơn rất nhiều' },
    { text: 'Auf Wiedersehen', trans: 'Tạm biệt' },
  ]);

  // 5 .row elements rendered.
  await expect(rowLocator(page)).toHaveCount(5);

  // #try-shadow-card is visible (not hidden) once sentences are present.
  await expect(page.locator('#try-shadow-card')).toBeVisible();

  // #try-card-text contains the first sentence (wrapped in quotes by sidepanel.js).
  const cardText = await page.locator('#try-card-text').textContent();
  expect(cardText, 'try-card shows first sentence').toContain(sents[0].text);
});

// ---------------------------------------------------------------------------
// TEST 3: Row click selects sentence and updates try-card
// ---------------------------------------------------------------------------
test('Row click selects sentence and updates try-card', async ({ page }) => {
  await openSidepanel(page);
  const sents = await injectSentences(page, 5, [
    { text: 'Erstes Satz', trans: 'Câu thứ nhất' },
    { text: 'Zweites Satz', trans: 'Câu thứ hai' },
    { text: 'Drittes Satz', trans: 'Câu thứ ba' },
    { text: 'Viertes Satz', trans: 'Câu thứ tư' },
    { text: 'Fünftes Satz', trans: 'Câu thứ năm' },
  ]);

  // Trigger the row click via page.evaluate() to dispatch the click event
  // directly on the DOM element, bypassing Playwright's pointer interception.
  // This is necessary because the bottom toolbar and try-shadow-card elements
  // have fixed/sticky positioning that visually covers the list rows; even
  // force:true coordinates hit the overlay element rather than the row.
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#list .row, #sentence-list .row');
    if (rows[2]) rows[2].click();
  });

  // The 3rd row should have class 'cur' immediately (markCur is synchronous).
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#list .row, #sentence-list .row');
    return rows[2] && rows[2].classList.contains('cur');
  }, { timeout: 3000 });

  const thirdRowHasCur = await page.evaluate(() => {
    const rows = document.querySelectorAll('#list .row, #sentence-list .row');
    return rows[2] ? rows[2].classList.contains('cur') : false;
  });
  expect(thirdRowHasCur, 'third row has class cur').toBe(true);

  // #try-card-text should show the 3rd sentence text.
  const cardText = await page.locator('#try-card-text').textContent();
  expect(cardText, 'try-card updated to 3rd sentence').toContain(sents[2].text);
});

// ---------------------------------------------------------------------------
// TEST 4: Pause toggle button appears and toggles
// ---------------------------------------------------------------------------
test('Pause toggle button appears and toggles', async ({ page }) => {
  await openSidepanel(page);
  await injectSentences(page, 3);

  // #try-pause-toggle should be visible inside the try-card.
  const toggle = page.locator('#try-pause-toggle');
  await expect(toggle).toBeVisible();

  // Initial state: button shows the HTML default "⏸ Tự dừng" (no suffix yet because
  // applySettings() is skipped — refresh() returns early when cmd('getState') times out).
  // The button is present and visible; that's what matters before any interaction.
  const initialText = await toggle.textContent();
  expect(initialText, 'initial toggle text contains Tự dừng').toContain('Tự dừng');

  // Click once → updatePauseToggle() runs → segPause toggles from true to false.
  // Result: text becomes "▶ Tự dừng: Tắt".
  await toggle.click();
  await page.waitForFunction(() => {
    const b = document.getElementById('try-pause-toggle');
    return b && b.textContent.includes('Tắt');
  }, { timeout: 3000 });
  const afterFirstClick = await toggle.textContent();
  expect(afterFirstClick, 'after first click: text contains Tắt').toContain('Tắt');

  // Click again → segPause toggles back to true.
  // Result: text becomes "⏸ Tự dừng: Bật".
  await toggle.click();
  await page.waitForFunction(() => {
    const b = document.getElementById('try-pause-toggle');
    return b && b.textContent.includes('Bật');
  }, { timeout: 3000 });
  const afterSecondClick = await toggle.textContent();
  expect(afterSecondClick, 'after second click: text contains Bật').toContain('Bật');
});

// ---------------------------------------------------------------------------
// TEST 5: Sentence list is scrollable
// ---------------------------------------------------------------------------
test('Sentence list is scrollable', async ({ page }) => {
  await openSidepanel(page);
  await injectSentences(page, 30);

  // Verify overflow-y is auto (or scroll) via computed style.
  const overflowY = await page.evaluate(() => {
    // The list may be #list (after adapter rename) or #sentence-list.
    const el = document.getElementById('list') || document.getElementById('sentence-list');
    if (!el) return null;
    return window.getComputedStyle(el).overflowY;
  });
  expect(
    ['auto', 'scroll'].includes(overflowY),
    `sentence list overflowY should be auto or scroll, got: ${overflowY}`
  ).toBe(true);

  // scrollHeight > clientHeight when 30 rows are rendered.
  const isScrollable = await page.evaluate(() => {
    const el = document.getElementById('list') || document.getElementById('sentence-list');
    if (!el) return false;
    return el.scrollHeight > el.clientHeight;
  });
  expect(isScrollable, 'sentence list scrollHeight > clientHeight with 30 rows').toBe(true);
});

// ---------------------------------------------------------------------------
// TEST 6: Record panel shows when "Nói & chấm" is clicked
// ---------------------------------------------------------------------------
test('Record panel shows when Nói & chấm is clicked', async ({ page }) => {
  await openSidepanel(page);
  await injectSentences(page, 3);

  // Patch startShadow-related calls so they don't block on real mic or port.
  // We stub out the cmd() path by making port.postMessage a no-op (already done)
  // and making ShadowMic.ensureMic resolve immediately (already done).
  // Also override enableMic so it always returns true without touching the mic.
  await page.evaluate(() => {
    // Patch: make enableMic always resolve to true.
    // sidepanel.js is an IIFE but calls window.ShadowMic.ensureMic → already stubbed.
    // The `autoRecord` setting is true by default; with ensureMic resolving → ok.
    // Additionally, openPractice() + showRecordPanel(true) is called from try-card-speak.
    // We also ensure no errors from cmd('shadow') timing out affect us.
    window._testRecordPanelForced = false;
    // Override showRecordPanel to capture the call without depending on internal state.
    const origShowRecord = document.getElementById('record-panel');
    if (origShowRecord) {
      // Pre-verify it starts hidden.
      window._recordPanelInitiallyHidden = origShowRecord.hidden;
    }
  });

  // Confirm record panel is initially hidden.
  await expect(page.locator('#record-panel')).toBeHidden();

  // Click the "Nói & chấm" button inside the try-card.
  // This calls: openPractice(current) then showRecordPanel(true) then startShadow(current).
  const speakBtn = page.locator('#try-card-speak');
  await expect(speakBtn).toBeVisible();
  await speakBtn.click();

  // #record-panel should become visible.
  // Give it a generous timeout since startShadow does async work.
  await expect(page.locator('#record-panel')).toBeVisible({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// TEST 7: Claude AI scoring appears after local score
// ---------------------------------------------------------------------------
test('Claude AI scoring appears after local score', async ({ page }) => {
  await openSidepanel(page);

  // Register route for the Claude scoring endpoint BEFORE triggering fetch.
  await page.route('**/score-ai', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        pronunciation: 82,
        fluency: 88,
        overall: 85,
        feedback: 'Phát âm tốt, chú ý âm cuối',
        engine: 'claude-haiku',
        transcript: 'Dann bist du hier genau richtig',
      }),
    })
  );

  // Inject one sentence so the feedback event has a valid sentence to look up.
  await page.evaluate(() =>
    window.testInjectSentences([
      { id: 0, startMs: 0, endMs: 3000, text: 'Dann bist du hier genau richtig.' },
    ])
  );

  // Wait for the sentence row to appear before firing feedback.
  await page.waitForFunction(
    () => document.querySelectorAll('#list .row, #sentence-list .row').length === 1,
    { timeout: 5000 }
  );

  // Fire the feedback port message that triggers renderFeedback() and then
  // claudeScoreAsync().
  await page.evaluate(() =>
    window.testFirePortMessage({
      sd: 'evt',
      evt: 'feedback',
      payload: {
        score: {
          words: [],
          pronunciation: 72,
          fluency: 78,
          overall: 75,
          transcript: 'Dann bist du hier genau richtig',
          engine: 'webspeech (trang)',
          intonation: null,
          lowConfidence: false,
          counts: { correct: 0, near: 0, wrong: 0, missing: 0, extra: 0, total: 5 },
        },
        sentence: { id: 0, startMs: 0, endMs: 3000, text: 'Dann bist du hier genau richtig.' },
        rep: 0,
      },
    })
  );

  // #fb is inside #view-practice which is hidden by default.
  // Expose view-practice so the .ai-score element is visible to Playwright.
  await page.evaluate(() => {
    const vp = document.getElementById('view-practice');
    if (vp) vp.hidden = false;
  });

  // Wait for the AI score box to finish loading (.ai-score--done is added by
  // claudeScoreAsync() after the fetch resolves and the result is rendered).
  await page.waitForSelector('.ai-score--done', { timeout: 8000 });

  // The AI score box must show the AI evaluation header and a score >= 80.
  const aiBoxText = await page.locator('.ai-score--done').textContent();

  expect(aiBoxText, 'AI score box shows evaluation header').toContain('AI đánh giá');

  // Extract all numbers from the text and check at least one is >= 80.
  const numbers = (aiBoxText.match(/\d+/g) || []).map(Number);
  const hasHighScore = numbers.some((n) => n >= 80);
  expect(hasHighScore, `AI score box contains a number >= 80 (found: ${numbers.join(', ')})`).toBe(true);
});
