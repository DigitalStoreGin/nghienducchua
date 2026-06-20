import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Nạp mã nguồn extension (browser UMD) vào trang Chromium thật rồi mô phỏng YouTube.
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shadowing-extension');
const read = (p) => readFileSync(path.join(EXT, p), 'utf8');

async function loadLibs(page, files) {
  for (const f of files) await page.addScriptTag({ content: read(f) });
}

test('YouTube transcript → câu + bản dịch render đúng, KHÔNG lặp, không lỗi console', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.setContent('<!doctype html><html><body><div id="list"></div></body></html>');
  await loadLibs(page, ['content/parsers.js']);

  const result = await page.evaluate(() => {
    const P = window.SD.parsers;
    // Mô phỏng phụ đề tiếng Đức YouTube (fmt=json3)
    const data = { events: [
      { tStartMs: 0,    dDurationMs: 1500, segs: [{ utf8: 'Hallo, wie geht es dir?' }] },
      { tStartMs: 1500, dDurationMs: 1500, segs: [{ utf8: 'Mir geht es gut, danke.' }] },
      { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: 'Was machst du heute?' }] },
    ] };
    // Bản dịch YouTube (tlang=vi) — CÙNG mốc thời gian
    const trans = { events: [
      { tStartMs: 0,    dDurationMs: 1500, segs: [{ utf8: 'Xin chào, bạn khỏe không?' }] },
      { tStartMs: 1500, dDurationMs: 1500, segs: [{ utf8: 'Tôi khỏe, cảm ơn.' }] },
      { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: 'Hôm nay bạn làm gì?' }] },
    ] };

    const sentences = P.mergeIntoSentences(P.parseJson3(data));
    P.attachTranslations(sentences, P.parseJson3(trans));

    // Render giống renderList của side panel
    const list = document.getElementById('list');
    for (const s of sentences) {
      const row = document.createElement('div'); row.className = 'row';
      const de = document.createElement('div'); de.className = 'de'; de.textContent = s.text; row.appendChild(de);
      if (s.trans) { const tr = document.createElement('div'); tr.className = 'tr'; tr.textContent = s.trans; row.appendChild(tr); }
      list.appendChild(row);
    }
    return { sentences: sentences.map((s) => ({ text: s.text, trans: s.trans })) };
  });

  expect(errors, 'không được có lỗi JS/console').toEqual([]);
  expect(result.sentences.length).toBe(3);

  // DOM render đúng số dòng + mỗi dòng có bản dịch
  await expect(page.locator('#list .row')).toHaveCount(3);
  await expect(page.locator('#list .tr')).toHaveCount(3);
  expect(await page.locator('#list .de').first().textContent()).toContain('Hallo');
  expect(await page.locator('#list .tr').first().textContent()).toContain('Xin chào');

  // KHÔNG lặp bản dịch: mỗi trans là duy nhất, không dính bản dịch của câu khác
  const transes = result.sentences.map((s) => s.trans);
  expect(new Set(transes).size).toBe(3);
  expect(transes[0]).not.toContain('cảm ơn');
});

test('Thư viện chạy đúng trong trình duyệt thật (regex \\p{L}, deviceMemory, chọn model)', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await loadLibs(page, ['lib/validate.js', 'lib/whisper-select.js']);

  const r = await page.evaluate(() => ({
    hallucination: window.ShadowValidate.classifyTranscript('la la la la la la la'),
    good: window.ShadowValidate.classifyTranscript('Ich gehe heute nach Hause'),
    empty: window.ShadowValidate.classifyTranscript('   '),
    echoed: window.ShadowValidate.isValidTranslation('Das ist ein langer Satz', 'Das ist ein langer Satz', 'de', 'vi'),
    strong: window.WhisperSelect.pickWhisperModel({ mem: 8, cores: 8 }).short,
    weak: window.WhisperSelect.pickWhisperModel({ mem: 2, cores: 2 }).short,
  }));

  expect(r.hallucination).toBe('bad');
  expect(r.good).toBe('ok');
  expect(r.empty).toBe('empty');
  expect(r.echoed).toBe(false);  // dịch trả y hệt nguồn -> loại
  expect(r.strong).toBe('small');
  expect(r.weak).toBe('tiny');
});
