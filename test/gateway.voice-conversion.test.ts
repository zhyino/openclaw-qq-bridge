import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type SpawnHandler = (cmd: string, args: string[]) => Promise<{ code: number }>;
(globalThis as any).__onebotSpawnImpl = async (_cmd: string, _args: string[]): Promise<{ code: number }> => ({ code: 0 });

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    const mockChild: any = {
      on: (event: string, cb: (...rest: any[]) => void) => {
        if (event === 'close') {
          void (globalThis as any).__onebotSpawnImpl(cmd, args).then((r: { code: number }) => cb(r.code));
        } else if (event === 'error') {
          // no-op
        }
        return mockChild;
      },
      kill: () => {},
    };
    return mockChild;
  },
}));

import { convertAmrToMp3, convertSilkToMp3, processVoiceSegments } from '../src/gateway.js';

describe('gateway voice conversion (H2: spawn arg arrays)', () => {
  let sandboxDir: string;

  beforeEach(async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'onebot-gateway-convert-'));
    (globalThis as any).__onebotSpawnImpl = async (_cmd: string, _args: string[]): Promise<{ code: number }> => ({ code: 0 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(sandboxDir, { recursive: true, force: true });
  });

  it('passes file paths as separate argv entries (no shell interpolation)', async () => {
    const seen: Array<[string, string[]]> = [];
    (globalThis as any).__onebotSpawnImpl = async (cmd: string, args: string[]) => {
      seen.push([cmd, args]);
      // Simulate the conversion: write the expected output so the function
      // finds an mp3 and returns its path. New impl writes to tmpdir with a
      // random name; we can't know it, so return code 0 and create the LAST
      // arg (the output path) — assert via a second pass instead.
      if (cmd === 'ffmpeg') {
        const outPath = args[args.length - 1];
        await writeFile(outPath, Buffer.from('mp3-data'));
      }
      if (cmd === 'uv') {
        const pcmPath = args[args.length - 1];
        await writeFile(pcmPath, Buffer.from('pcm-data'));
      }
      return { code: 0 };
    };

    const silkPath = join(sandboxDir, 'sample.silk');
    await writeFile(silkPath, Buffer.from('\u0002#!SILK_V3 payload'));

    const result = await convertSilkToMp3(silkPath, { info: vi.fn(), error: vi.fn(), debug: vi.fn() });

    // The critical H2 assertion: every path is a separate argv element,
    // never concatenated into a shell command string.
    const silkArgs = seen.find(([c]) => c === 'uv')?.[1] ?? [];
    const silkIdx = silkArgs.indexOf(silkPath);
    expect(silkIdx).toBeGreaterThan(-1);
    // The input path appears as its own argument, not embedded in a string
    expect(silkArgs.every((a) => !a.includes(silkPath + '"') && !a.includes("'" + silkPath))).toBe(true);

    expect(result).not.toBeNull();
  });

  it('returns null when conversion tools fail', async () => {
    (globalThis as any).__onebotSpawnImpl = async (_cmd: string, _args: string[]): Promise<{ code: number }> => ({ code: 1 });
    const silkPath = join(sandboxDir, 'broken.silk');
    await writeFile(silkPath, Buffer.from('\u0002#!SILK_V3 broken'));

    const silk = await convertSilkToMp3(silkPath, { info: vi.fn(), error: vi.fn(), debug: vi.fn() });
    expect(silk).toBeNull();
  });

  it('converts AMR via ffmpeg with arg array', async () => {
    let ffmpegArgs: string[] | null = null;
    (globalThis as any).__onebotSpawnImpl = async (cmd: string, args: string[]) => {
      if (cmd === 'ffmpeg') {
        ffmpegArgs = args;
        await writeFile(args[args.length - 1], Buffer.from('mp3-data'));
      }
      return { code: 0 };
    };
    const amrPath = join(sandboxDir, 'sample.amr');
    await writeFile(amrPath, Buffer.from('#!AMR\npayload'));

    const amr = await convertAmrToMp3(amrPath, { info: vi.fn(), error: vi.fn(), debug: vi.fn() });

    expect(amr).not.toBeNull();
    expect(ffmpegArgs).not.toBeNull();
    // AMR path is its own argv element
    expect(ffmpegArgs).toContain(amrPath);
  });

  it('processes local SILK and AMR attachments into audio media entries', async () => {
    (globalThis as any).__onebotSpawnImpl = async (cmd: string, args: string[]) => {
      if (cmd === 'uv') await writeFile(args[args.length - 1], Buffer.from('pcm'));
      if (cmd === 'ffmpeg') await writeFile(args[args.length - 1], Buffer.from('mp3'));
      return { code: 0 };
    };
    const silkPath = join(sandboxDir, 'voice1.silk');
    const amrPath = join(sandboxDir, 'voice2.amr');
    await writeFile(silkPath, Buffer.from('\u0002#!SILK_V3 inbound'));
    await writeFile(amrPath, Buffer.from('#!AMR\ninbound'));

    const results = await processVoiceSegments([
      { type: 'record', data: { file: silkPath } },
      { type: 'record', data: { file: amrPath } },
    ] as any, { info: vi.fn(), error: vi.fn(), debug: vi.fn() });

    expect(Array.isArray(results)).toBe(true);
  });
});
