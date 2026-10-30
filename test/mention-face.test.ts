import { describe, expect, it } from 'vitest';

import { extractText, FACE_NAMES } from '../src/gateway.js';
import { buildMessage } from '../src/outbound.js';

describe('extractText with selfId — @ mentions and QQ face emoji', () => {
  const BOT = 10004;

  it('keeps legacy behaviour when selfId is omitted (only text segments)', () => {
    const segments = [
      { type: 'text', data: { text: 'hello' } },
      { type: 'at', data: { qq: String(BOT) } },
      { type: 'face', data: { id: '1' } },
      { type: 'text', data: { text: ' world' } },
    ] as any;

    expect(extractText(segments)).toBe('hello world');
  });

  it('marks a direct @ of the bot with [被@]', () => {
    const segments = [
      { type: 'at', data: { qq: String(BOT) } },
      { type: 'text', data: { text: ' 在吗' } },
    ] as any;

    expect(extractText(segments, { selfId: BOT })).toBe('[被@] 在吗');
  });

  it('marks @everyone with [被@全体]', () => {
    const segments = [
      { type: 'text', data: { text: '大家看这个 ' } },
      { type: 'at', data: { qq: 'all' } },
    ] as any;

    expect(extractText(segments, { selfId: BOT })).toBe('大家看这个 [被@全体]');
  });

  it('turns an @ of someone else into [@<qq>]', () => {
    const segments = [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 你看这个' } },
    ] as any;

    expect(extractText(segments, { selfId: BOT })).toBe('[@10001] 你看这个');
  });

  it('does not mark an @ of the bot when the at qq does not match selfId', () => {
    const segments = [{ type: 'at', data: { qq: '12345' } }] as any;
    expect(extractText(segments, { selfId: BOT })).toBe('[@12345]');
  });

  it('decodes face segments into [表情:<name>] using the mapping table', () => {
    const segments = [
      { type: 'text', data: { text: '哈哈' } },
      { type: 'face', data: { id: '1' } },
      { type: 'face', data: { id: '74' } },
    ] as any;

    expect(extractText(segments, { selfId: BOT })).toBe('哈哈[表情:微笑][表情:便便]');
  });

  it('falls back to the raw id for unknown face ids', () => {
    const segments = [{ type: 'face', data: { id: '9999' } }] as any;
    expect(extractText(segments, { selfId: BOT })).toBe('[表情:9999]');
  });

  it('handles a face segment with a numeric id value', () => {
    const segments = [{ type: 'face', data: { id: 6 } }] as any;
    expect(extractText(segments, { selfId: BOT })).toBe('[表情:流泪]');
  });

  it('interleaves text, mentions and faces in order', () => {
    const segments = [
      { type: 'at', data: { qq: String(BOT) } },
      { type: 'text', data: { text: ' 快看 ' } },
      { type: 'face', data: { id: '21' } },
      { type: 'at', data: { qq: '10002' } },
    ] as any;

    expect(extractText(segments, { selfId: BOT })).toBe('[被@] 快看 [表情:偷笑][@10002]');
  });

  it('exposes the face name mapping table for common ids', () => {
    expect(FACE_NAMES['1']).toBe('微笑');
    expect(FACE_NAMES['74']).toBe('便便');
    expect(FACE_NAMES['178']).toBeUndefined();
  });
});

describe('buildMessage — outbound QQ face emoji', () => {
  it('returns no segments for empty/whitespace text', () => {
    expect(buildMessage('')).toEqual([]);
    expect(buildMessage('   ')).toEqual([]);
  });

  it('decodes [CQ:face,id=...] into a real face segment', () => {
    expect(buildMessage('[CQ:face,id=1]')).toEqual([
      { type: 'face', data: { id: '1' } },
    ]);
  });

  it('splits surrounding text and face into separate segments in order', () => {
    expect(buildMessage('哈哈[CQ:face,id=1]你懂的')).toEqual([
      { type: 'text', data: { text: '哈哈' } },
      { type: 'face', data: { id: '1' } },
      { type: 'text', data: { text: '你懂的' } },
    ]);
  });

  it('decodes multiple faces', () => {
    expect(buildMessage('[CQ:face,id=1][CQ:face,id=74]')).toEqual([
      { type: 'face', data: { id: '1' } },
      { type: 'face', data: { id: '74' } },
    ]);
  });

  it('still neutralises every other CQ code', () => {
    expect(buildMessage('看 [CQ:image,file=http://attacker/x.png]')).toEqual([
      { type: 'text', data: { text: '看 [CQ：image,file=http://attacker/x.png]' } },
    ]);
  });

  it('neutralises mixed malicious CQ codes while keeping the face', () => {
    const result = buildMessage('[CQ:image,file=x][CQ:face,id=1]');
    expect(result[0].type).toBe('text');
    expect((result[0].data.text as string).includes('CQ：image')).toBe(true);
    expect(result[1]).toEqual({ type: 'face', data: { id: '1' } });
  });

  it('keeps normal text with CQ-looking brackets untouched otherwise', () => {
    expect(buildMessage('正常文本 [CQ：face,id=1] 也正常')).toEqual([
      { type: 'text', data: { text: '正常文本 [CQ：face,id=1] 也正常' } },
    ]);
  });

  it('prepends a reply segment when replyToId is provided', () => {
    expect(buildMessage('收到', '12345')).toEqual([
      { type: 'reply', data: { id: '12345' } },
      { type: 'text', data: { text: '收到' } },
    ]);
  });

  it('prepends reply segment before faces', () => {
    expect(buildMessage('哈哈[CQ:face,id=1]', '99')).toEqual([
      { type: 'reply', data: { id: '99' } },
      { type: 'text', data: { text: '哈哈' } },
      { type: 'face', data: { id: '1' } },
    ]);
  });

  it('emits only the reply segment when text is empty', () => {
    expect(buildMessage('', '42')).toEqual([{ type: 'reply', data: { id: '42' } }]);
  });

  it('ignores empty/null replyToId', () => {
    expect(buildMessage('hi', '')).toEqual([{ type: 'text', data: { text: 'hi' } }]);
    expect(buildMessage('hi', null)).toEqual([{ type: 'text', data: { text: 'hi' } }]);
    expect(buildMessage('hi', undefined)).toEqual([{ type: 'text', data: { text: 'hi' } }]);
  });
});
