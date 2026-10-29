import { afterEach, describe, it, expect } from 'vitest';

import { clearOneBotRuntime, getOneBotRuntime, setOneBotRuntime, tryGetOneBotRuntime } from '../src/runtime.js';

describe('runtime', () => {
  afterEach(() => {
    clearOneBotRuntime();
  });

  it('getOneBotRuntime throws before initialization', () => {
    clearOneBotRuntime();
    expect(() => getOneBotRuntime()).toThrow(/not initialized/);
  });

  it('setOneBotRuntime then getOneBotRuntime returns same object', () => {
    const r = { channel: { activity: { record: () => {} }, routing: {}, reply: {} } } as any;
    setOneBotRuntime(r);
    expect(getOneBotRuntime()).toBe(r);
  });

  it('tryGetOneBotRuntime returns null before initialization', () => {
    clearOneBotRuntime();
    expect(tryGetOneBotRuntime()).toBeNull();
  });
});
