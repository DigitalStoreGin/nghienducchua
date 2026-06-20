/**
 * Kiểm thử thật: nạp extension vào Chromium thật (Playwright) + mic giả, xác minh
 * luồng cấp quyền micro hoạt động. KHÔNG chạy trong CI mặc định (cần headed/xvfb).
 *
 * Chạy:
 *   npm run test:ext                 # macOS/Windows
 *   xvfb-run -a npm run test:ext     # Linux không màn hình (headless server)
 *
 * Kỳ vọng:
 *   MIC_PAGE status class: status ok
 *   SIDEPANEL getUserMedia: ok tracks=1
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'shadowing-extension');

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
const extId = sw ? sw.url().split('/')[2] : null;
console.log('EXT_ID:', extId);
if (!extId) { console.log('FAIL: no extension id'); await ctx.close(); process.exit(1); }

let failed = false;

// 1) Trang cấp quyền tự xin quyền khi mở
{
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`chrome-extension://${extId}/mic-permission.html`);
  await page.waitForTimeout(2500);
  const cls = await page.locator('#status').getAttribute('class');
  console.log('MIC_PAGE status class:', cls);
  console.log('MIC_PAGE errors:', errs.length ? errs : 'none');
  if (!/ok/.test(cls || '') || errs.length) failed = true;
  await page.close();
}

// 2) getUserMedia trong context extension (giống Side Panel)
{
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const out = { hasShadowMic: !!window.ShadowMic, gum: null };
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); out.gum = 'ok tracks=' + s.getAudioTracks().length; s.getTracks().forEach((t) => t.stop()); }
    catch (e) { out.gum = 'ERR ' + e.name; }
    return out;
  });
  console.log('SIDEPANEL hasShadowMic:', r.hasShadowMic);
  console.log('SIDEPANEL getUserMedia:', r.gum);
  if (!r.hasShadowMic || !/^ok/.test(r.gum)) failed = true;
  await page.close();
}

await ctx.close();
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
