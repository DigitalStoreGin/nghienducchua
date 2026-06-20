import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// content/parsers.js là UMD (module.exports) -> nạp bằng require
const require = createRequire(import.meta.url);
const P = require('../shadowing-extension/content/parsers.js');

describe('parseJson3 — phụ đề YouTube (timedtext fmt=json3)', () => {
  it('bóc đúng text + thời gian từ events/segs', () => {
    const obj = { events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hallo ' }, { utf8: 'Welt' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Wie geht es dir' }] },
      { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: '\n' }] }, // bỏ dòng rỗng
    ] };
    const cues = P.parseJson3(obj);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({ startMs: 0, endMs: 1000, text: 'Hallo Welt' });
    expect(cues[1].text).toBe('Wie geht es dir');
  });
});

describe('attachTranslations — gán bản dịch YouTube không bị lặp', () => {
  it('mỗi câu nhận đúng bản dịch theo điểm giữa', () => {
    const sentences = [
      { id: 0, startMs: 0, endMs: 1000, text: 'Hallo Welt' },
      { id: 1, startMs: 1000, endMs: 2000, text: 'Wie geht es dir' },
    ];
    const tcues = [
      { startMs: 0, endMs: 1000, text: 'Xin chào thế giới' },
      { startMs: 1000, endMs: 2000, text: 'Bạn khỏe không' },
    ];
    P.attachTranslations(sentences, tcues);
    expect(sentences[0].trans).toBe('Xin chào thế giới');
    expect(sentences[1].trans).toBe('Bạn khỏe không');
  });

  it('câu dài bị TÁCH không làm bản dịch bị lặp lên mọi mảnh', () => {
    // 1 cue dịch lớn (0..2000) ; 2 câu con chia đôi khoảng thời gian đó
    const sentences = [
      { id: 0, startMs: 0, endMs: 1000, text: 'Erster Teil.' },
      { id: 1, startMs: 1000, endMs: 2000, text: 'Zweiter Teil.' },
    ];
    const tcues = [
      { startMs: 0, endMs: 900, text: 'Phần một.' },     // midpoint 450 -> câu 0
      { startMs: 1100, endMs: 2000, text: 'Phần hai.' },  // midpoint 1550 -> câu 1
    ];
    P.attachTranslations(sentences, tcues);
    expect(sentences[0].trans).toBe('Phần một.');
    expect(sentences[1].trans).toBe('Phần hai.');
    // KHÔNG được dính cả hai vào một câu (bug cũ dùng overlap)
    expect(sentences[0].trans).not.toContain('Phần hai');
    expect(sentences[1].trans).not.toContain('Phần một');
  });

  it('tcues rỗng -> giữ nguyên, không lỗi', () => {
    const sentences = [{ id: 0, startMs: 0, endMs: 1000, text: 'X' }];
    expect(() => P.attachTranslations(sentences, [])).not.toThrow();
    expect(sentences[0].trans).toBeUndefined();
  });
});

describe('mergeIntoSentences — gộp + tách câu', () => {
  it('gộp dòng caption cuộn (prefix lớn dần) thành 1 câu', () => {
    const cues = [
      { startMs: 0, endMs: 500, text: 'Ich' },
      { startMs: 0, endMs: 800, text: 'Ich gehe' },
      { startMs: 0, endMs: 1200, text: 'Ich gehe nach Hause.' },
    ];
    const out = P.mergeIntoSentences(cues);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('Ich gehe nach Hause.');
  });
});
