import { describe, it, expect } from 'vitest';
import { OR_MODELS, allowedModel, parseSentryDsn } from '../worker/index.js';

describe('allowedModel — whitelist model OpenRouter', () => {
  it('giữ nguyên model hợp lệ', () => {
    for (const m of OR_MODELS) expect(allowedModel(m)).toBe(m);
  });
  it('model lạ → ép về model mặc định (đầu danh sách)', () => {
    expect(allowedModel('openai/gpt-5-ultra')).toBe(OR_MODELS[0]);
    expect(allowedModel('')).toBe(OR_MODELS[0]);
    expect(allowedModel(undefined)).toBe(OR_MODELS[0]);
  });
  it('danh sách có đủ 4 model free đã cấu hình', () => {
    expect(OR_MODELS).toContain('openai/gpt-oss-120b:free');
    expect(OR_MODELS).toContain('nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(OR_MODELS).toContain('google/gemma-4-31b-it:free');
    expect(OR_MODELS).toContain('google/gemma-4-26b-a4b-it:free');
    expect(OR_MODELS.length).toBe(4);
  });
});

describe('parseSentryDsn — phân tích DSN Sentry', () => {
  it('DSN hợp lệ → tách key/host/projectId', () => {
    const p = parseSentryDsn('https://abc123@o456.ingest.sentry.io/789');
    expect(p).toEqual({ key: 'abc123', host: 'o456.ingest.sentry.io', projectId: '789' });
  });
  it('DSN vùng EU (.de.sentry.io) → tách đúng host EU + projectId dài', () => {
    const p = parseSentryDsn('https://7ce8e9c570992e240a66ca58c89cf45a@o4511599189491712.ingest.de.sentry.io/4511599213150288');
    expect(p).toEqual({
      key: '7ce8e9c570992e240a66ca58c89cf45a',
      host: 'o4511599189491712.ingest.de.sentry.io',
      projectId: '4511599213150288',
    });
  });
  it('DSN sai/thiếu → null (không gửi)', () => {
    expect(parseSentryDsn('')).toBeNull();
    expect(parseSentryDsn(undefined)).toBeNull();
    expect(parseSentryDsn('not-a-dsn')).toBeNull();
    expect(parseSentryDsn('http://abc@host/1')).toBeNull(); // phải https
  });
});
