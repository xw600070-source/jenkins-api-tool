import { describe, it, expect } from 'vitest';
import { formatDuration, formatTimestamp, formatFileSize, stripTrailingSlash, escapeRegExp } from './helpers';

describe('formatDuration', () => {
  it('秒级', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('分钟级', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(90_000)).toBe('1m 30s');
  });

  it('小时级', () => {
    expect(formatDuration(3_723_000)).toBe('1h 2m 3s');
  });
});

describe('formatFileSize', () => {
  it('各数量级', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1024)).toBe('1.00 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
  });
});

describe('formatTimestamp', () => {
  it('输出本地时间字符串', () => {
    expect(typeof formatTimestamp(Date.now())).toBe('string');
  });
});

describe('stripTrailingSlash', () => {
  it('去掉末尾斜杠（含多个）', () => {
    expect(stripTrailingSlash('http://x/')).toBe('http://x');
    expect(stripTrailingSlash('http://x///')).toBe('http://x');
  });

  it('无斜杠原样返回', () => {
    expect(stripTrailingSlash('http://x')).toBe('http://x');
  });
});

describe('escapeRegExp', () => {
  it('转义正则特殊字符', () => {
    expect(escapeRegExp('http://223.223.178.68:2004')).toBe(
      'http://223\\.223\\.178\\.68:2004'
    );
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c');
  });

  it('可安全用于 new RegExp 拼接', () => {
    const base = 'http://x.y:2004/files';
    const re = new RegExp(`${escapeRegExp(base)}/[^\\s]+\\.zip`);
    expect('http://x.y:2004/files/a.zip'.match(re)?.[0]).toBe('http://x.y:2004/files/a.zip');
  });
});
