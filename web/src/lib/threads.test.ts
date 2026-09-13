import { describe, expect, it } from 'vitest';
import { linkSegments } from './threads';

describe('threads linkSegments', () => {
  it('handles plain text with no links', () => {
    expect(linkSegments('')).toEqual([]);
    expect(linkSegments('这是一段普通文本，没有任何链接。')).toEqual([
      { kind: 'text', value: '这是一段普通文本，没有任何链接。' },
    ]);
  });

  it('handles one link', () => {
    expect(linkSegments('访问 https://example.com 获取更多信息')).toEqual([
      { kind: 'text', value: '访问 ' },
      { kind: 'link', value: 'https://example.com' },
      { kind: 'text', value: ' 获取更多信息' },
    ]);
  });

  it('handles several links with text between', () => {
    const input = '主页 http://example.com 文档 https://docs.example.com/api 完毕';
    expect(linkSegments(input)).toEqual([
      { kind: 'text', value: '主页 ' },
      { kind: 'link', value: 'http://example.com' },
      { kind: 'text', value: ' 文档 ' },
      { kind: 'link', value: 'https://docs.example.com/api' },
      { kind: 'text', value: ' 完毕' },
    ]);
  });

  it('keeps javascript: and ftp: as text', () => {
    const input = '不安全链接 javascript:alert(1) 与 ftp://files.example.com/archive';
    expect(linkSegments(input)).toEqual([
      {
        kind: 'text',
        value: '不安全链接 javascript:alert(1) 与 ftp://files.example.com/archive',
      },
    ]);
  });

  it('does not swallow punctuation when URL is at the end of a sentence ending in . or ）', () => {
    const dotEnd = '请查阅 http://example.com/spec.';
    expect(linkSegments(dotEnd)).toEqual([
      { kind: 'text', value: '请查阅 ' },
      { kind: 'link', value: 'http://example.com/spec' },
      { kind: 'text', value: '.' },
    ]);

    const parenEnd = '详情见文档（参考 https://example.com/guide）';
    expect(linkSegments(parenEnd)).toEqual([
      { kind: 'text', value: '详情见文档（参考 ' },
      { kind: 'link', value: 'https://example.com/guide' },
      { kind: 'text', value: '）' },
    ]);

    const chinesePeriod = '查看 https://example.com/demo。';
    expect(linkSegments(chinesePeriod)).toEqual([
      { kind: 'text', value: '查看 ' },
      { kind: 'link', value: 'https://example.com/demo' },
      { kind: 'text', value: '。' },
    ]);
  });
});
