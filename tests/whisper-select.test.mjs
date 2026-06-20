import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// lib/whisper-select.js là UMD (module.exports) -> nạp bằng require
const require = createRequire(import.meta.url);
const WS = require('../shadowing-extension/lib/whisper-select.js');

describe('pickWhisperModel — chọn model theo cấu hình máy', () => {
  it('máy mạnh (8GB, 8 nhân) → small (mạnh nhất)', () => {
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }).short).toBe('small');
    expect(WS.pickWhisperModel({ mem: 16, cores: 12 }).short).toBe('small');
  });

  it('máy phổ thông (8GB, 4 nhân) → base', () => {
    expect(WS.pickWhisperModel({ mem: 8, cores: 4 }).short).toBe('base');
    expect(WS.pickWhisperModel({ mem: 6, cores: 4 }).short).toBe('base');
  });

  it('máy 4GB nhiều nhân → base', () => {
    expect(WS.pickWhisperModel({ mem: 4, cores: 4 }).short).toBe('base');
    expect(WS.pickWhisperModel({ mem: 4, cores: 8 }).short).toBe('base');
  });

  it('máy 4GB ít nhân → tiny (nhẹ cho mượt)', () => {
    expect(WS.pickWhisperModel({ mem: 4, cores: 2 }).short).toBe('tiny');
  });

  it('máy yếu (<4GB) → tiny', () => {
    expect(WS.pickWhisperModel({ mem: 2, cores: 2 }).short).toBe('tiny');
    expect(WS.pickWhisperModel({ mem: 1, cores: 1 }).short).toBe('tiny');
  });

  it('override ép tay luôn được tôn trọng', () => {
    expect(WS.pickWhisperModel({ mem: 2, cores: 1 }, 'small').short).toBe('small');
    expect(WS.pickWhisperModel({ mem: 16, cores: 16 }, 'tiny').short).toBe('tiny');
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }, 'base').short).toBe('base');
  });

  it('override "auto" hoặc giá trị lạ → quay về tự động', () => {
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }, 'auto').short).toBe('small');
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }, 'nonsense').short).toBe('small');
  });

  it('mỗi model có id HuggingFace hợp lệ', () => {
    for (const k of ['tiny', 'base', 'small']) {
      expect(WS.WHISPER_MODELS[k].id).toBe('Xenova/whisper-' + k);
    }
  });
});

describe('pickDevice — chọn thiết bị suy luận (sẵn cho nâng cấp WebGPU)', () => {
  it('máy có WebGPU → webgpu', () => {
    expect(WS.pickDevice({ mem: 8, cores: 8, gpu: true })).toBe('webgpu');
  });
  it('máy không có WebGPU → wasm', () => {
    expect(WS.pickDevice({ mem: 8, cores: 8, gpu: false })).toBe('wasm');
  });
});

describe('pickThreads — số luồng WASM', () => {
  it('không crossOriginIsolated → luôn 1 luồng', () => {
    expect(WS.pickThreads({ mem: 8, cores: 8, coi: false })).toBe(1);
  });
  it('có crossOriginIsolated → tối đa 4, để chừa 1 nhân', () => {
    expect(WS.pickThreads({ mem: 8, cores: 8, coi: true })).toBe(4);
    expect(WS.pickThreads({ mem: 8, cores: 4, coi: true })).toBe(3);
    expect(WS.pickThreads({ mem: 4, cores: 2, coi: true })).toBe(1);
  });
});
