import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// lib/whisper-select.js là UMD (module.exports) -> nạp bằng require
const require = createRequire(import.meta.url);
const WS = require('../shadowing-extension/lib/whisper-select.js');

describe('pickWhisperModel — chọn model theo % RAM máy khách (trần 2GB)', () => {
  it('máy rất mạnh (≥8GB báo, ≥8 nhân) → medium (~1.5GB, model lớn nhất ≤2GB)', () => {
    // deviceMemory bị chặn ở 8; ≥8 nhân -> suy ra RAM thực ~16GB -> medium chiếm ~12.5%.
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }).short).toBe('medium');
    expect(WS.pickWhisperModel({ mem: 16, cores: 12 }).short).toBe('medium');
  });

  it('máy mạnh vừa (8GB, 4 nhân) → small (medium chiếm 25% nên bị loại)', () => {
    expect(WS.pickWhisperModel({ mem: 8, cores: 4 }).short).toBe('small');
  });

  it('máy phổ thông (6GB, 4 nhân) → base (small chiếm ~17% >15% nên bị loại)', () => {
    expect(WS.pickWhisperModel({ mem: 6, cores: 4 }).short).toBe('base');
  });

  it('máy 4GB → base (small chiếm 25%, base chỉ ~12.5%)', () => {
    expect(WS.pickWhisperModel({ mem: 4, cores: 4 }).short).toBe('base');
    expect(WS.pickWhisperModel({ mem: 4, cores: 8 }).short).toBe('base');
    expect(WS.pickWhisperModel({ mem: 4, cores: 2 }).short).toBe('base');
  });

  it('máy yếu (≤2GB) → tiny (base chiếm ≥25% nên chỉ chạy 75MB)', () => {
    expect(WS.pickWhisperModel({ mem: 2, cores: 2 }).short).toBe('tiny');
    expect(WS.pickWhisperModel({ mem: 1, cores: 1 }).short).toBe('tiny');
  });

  it('không bao giờ vượt trần 2GB', () => {
    for (const hw of [{ mem: 16, cores: 16 }, { mem: 8, cores: 32 }]) {
      expect(WS.pickWhisperModel(hw).ramGB).toBeLessThanOrEqual(2.0);
    }
  });

  it('override ép tay luôn được tôn trọng', () => {
    expect(WS.pickWhisperModel({ mem: 2, cores: 1 }, 'small').short).toBe('small');
    expect(WS.pickWhisperModel({ mem: 16, cores: 16 }, 'tiny').short).toBe('tiny');
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }, 'medium').short).toBe('medium');
  });

  it('override "auto" hoặc giá trị lạ → quay về tự động', () => {
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }, 'auto').short).toBe('medium');
    expect(WS.pickWhisperModel({ mem: 8, cores: 8 }, 'nonsense').short).toBe('medium');
  });

  it('mỗi model có id HuggingFace hợp lệ', () => {
    for (const k of ['tiny', 'base', 'small', 'medium']) {
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
