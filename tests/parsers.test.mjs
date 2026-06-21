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

  it('tách nhiều câu ngắn gộp chung thành từng câu riêng', () => {
    // Lỗi cũ: "Hallo. Hallo. Wir freuen uns..." hiện thành 1 dòng dài.
    const cues = [
      { startMs: 0, endMs: 4000, text: 'Hallo. Hallo. Wir freuen uns so sehr, dass ihr heute hier seid.' },
    ];
    const out = P.mergeIntoSentences(cues);
    expect(out.length).toBe(3);
    expect(out[0].text).toBe('Hallo.');
    expect(out[1].text).toBe('Hallo.');
    expect(out[2].text).toBe('Wir freuen uns so sehr, dass ihr heute hier seid.');
    // thời gian tăng dần, không chồng nhau
    expect(out[0].startMs).toBeLessThan(out[1].startMs);
    expect(out[1].startMs).toBeLessThan(out[2].startMs);
  });

  it('tách câu khác nhau đến từ các cue liền nhau (gap nhỏ)', () => {
    const cues = [
      { startMs: 0,    endMs: 1000, text: 'Guten Tag.' },
      { startMs: 1100, endMs: 4000, text: 'Wir freuen uns, dass ihr hier seid.' },
    ];
    const out = P.mergeIntoSentences(cues);
    expect(out.length).toBe(2);
    expect(out[0].text).toBe('Guten Tag.');
    expect(out[1].text).toBe('Wir freuen uns, dass ihr hier seid.');
  });

  it('KHÔNG tách nhầm chữ viết tắt (z. B., Dr., ordinal)', () => {
    const cues = [
      { startMs: 0, endMs: 3000, text: 'Das ist z. B. ein Haus von Dr. Müller am 3. Mai.' },
    ];
    const out = P.mergeIntoSentences(cues);
    expect(out.length).toBe(1);
    expect(out[0].text).toContain('z. B.');
    expect(out[0].text).toContain('Dr. Müller');
  });

  it('tách câu quá dài theo mệnh đề (dấu phẩy) — mỗi đoạn ≤10 từ', () => {
    const longText =
      'Wenn das Wetter heute schön ist, gehen wir gemeinsam in den großen Park, ' +
      'und danach essen wir ein leckeres Eis in der Stadt.';
    const cues = [{ startMs: 0, endMs: 6000, text: longText }];
    const out = P.mergeIntoSentences(cues);
    expect(out.length).toBeGreaterThan(1);
    // mỗi đoạn không quá 10 từ (lý tưởng cho shadowing)
    for (const s of out) {
      const wordCount = s.text.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeLessThanOrEqual(10);
    }
  });

  it('câu không có dấu phẩy bị tách cứng tại 10 từ', () => {
    const longText = 'Das ist ein sehr langer Satz ohne Satzzeichen und er geht noch weiter und weiter.';
    const cues = [{ startMs: 0, endMs: 8000, text: longText }];
    const out = P.mergeIntoSentences(cues);
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) {
      const wordCount = s.text.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeLessThanOrEqual(10);
    }
    // thời gian tăng dần
    for (let i = 1; i < out.length; i++) expect(out[i].startMs).toBeGreaterThan(out[i-1].startMs);
  });
});
