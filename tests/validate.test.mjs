import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// lib/validate.js là UMD (module.exports) -> nạp bằng require
const require = createRequire(import.meta.url);
const V = require('../shadowing-extension/lib/validate.js');

describe('isValidTranslation — kiểm tra bản dịch trước khi trả khách', () => {
  it('bản dịch hợp lệ -> true', () => {
    expect(V.isValidTranslation('Xin chào thế giới', 'Hallo Welt', 'de', 'vi')).toBe(true);
  });
  it('rỗng / chỉ khoảng trắng -> false', () => {
    expect(V.isValidTranslation('', 'Hallo', 'de', 'vi')).toBe(false);
    expect(V.isValidTranslation('   ', 'Hallo', 'de', 'vi')).toBe(false);
    expect(V.isValidTranslation(null, 'Hallo', 'de', 'vi')).toBe(false);
  });
  it('trả y hệt nguồn khi dịch khác ngôn ngữ (câu dài) -> false', () => {
    const s = 'Das ist ein langer deutscher Satz';
    expect(V.isValidTranslation(s, s, 'de', 'vi')).toBe(false);
  });
  it('câu RẤT NGẮN trả y hệt vẫn chấp nhận (tên riêng/số)', () => {
    expect(V.isValidTranslation('Berlin', 'Berlin', 'de', 'vi')).toBe(true);
  });
  it('thông báo lỗi điển hình -> false', () => {
    expect(V.isValidTranslation('error', 'Hallo', 'de', 'vi')).toBe(false);
    expect(V.isValidTranslation('null', 'Hallo', 'de', 'vi')).toBe(false);
    expect(V.isValidTranslation('N/A', 'Hallo', 'de', 'vi')).toBe(false);
  });
  it('cùng ngôn ngữ trả y hệt vẫn hợp lệ', () => {
    const s = 'Das ist ein Satz';
    expect(V.isValidTranslation(s, s, 'de', 'de')).toBe(true);
  });
});

describe('isGoodTranscript — phát hiện Whisper "ảo giác"/lặp', () => {
  it('câu nói thật -> true', () => {
    expect(V.isGoodTranscript('Ich gehe heute ins Kino mit meinen Freunden')).toBe(true);
  });
  it('rỗng -> false', () => {
    expect(V.isGoodTranscript('')).toBe(false);
    expect(V.isGoodTranscript('   ')).toBe(false);
    expect(V.isGoodTranscript(null)).toBe(false);
  });
  it('lặp 1 từ rất nhiều lần (ảo giác) -> false', () => {
    expect(V.isGoodTranscript('Untertitel Untertitel Untertitel Untertitel Untertitel Untertitel')).toBe(false);
    expect(V.isGoodTranscript('la la la la la la la la')).toBe(false);
  });
  it('1 từ chiếm phần lớn câu -> false', () => {
    expect(V.isGoodTranscript('danke danke danke danke danke schön')).toBe(false);
  });
  it('câu ngắn bình thường (dưới ngưỡng kiểm lặp) -> true', () => {
    expect(V.isGoodTranscript('Guten Morgen')).toBe(true);
    expect(V.isGoodTranscript('Ja')).toBe(true);
  });
});

describe('classifyTranscript — phân loại kết quả ghi âm', () => {
  it('rỗng -> empty (khách chưa nói, KHÔNG re-record)', () => {
    expect(V.classifyTranscript('')).toBe('empty');
    expect(V.classifyTranscript('   ')).toBe('empty');
  });
  it('ảo giác -> bad (hạ xuống Web Speech)', () => {
    expect(V.classifyTranscript('hm hm hm hm hm hm hm')).toBe('bad');
  });
  it('câu thật -> ok', () => {
    expect(V.classifyTranscript('Wie geht es dir heute Morgen')).toBe('ok');
  });
});
