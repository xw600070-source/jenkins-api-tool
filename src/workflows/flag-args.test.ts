import { describe, it, expect } from 'vitest';
import { parseFlagArgs } from './flag-args';

const USAGE = '用法: npm run jenkins -- demo [--name x]';

describe('parseFlagArgs', () => {
  it('空参数返回空表', () => {
    expect(parseFlagArgs([], ['--name'], USAGE)).toEqual({});
  });

  it('解析已知 flag 的取值', () => {
    expect(parseFlagArgs(['--name', 'x'], ['--name'], USAGE)).toEqual({ '--name': 'x' });
  });

  it('同一 flag 重复时后者覆盖', () => {
    expect(parseFlagArgs(['--name', 'a', '--name', 'b'], ['--name'], USAGE)).toEqual({
      '--name': 'b',
    });
  });

  it('未知 flag 抛错并列出可用参数', () => {
    expect(() => parseFlagArgs(['--nam', 'x'], ['--name'], USAGE)).toThrow(/可用参数.*--name/);
  });

  it('flag 缺取值抛错', () => {
    expect(() => parseFlagArgs(['--name'], ['--name'], USAGE)).toThrow(/--name 缺少取值/);
  });

  it('位置参数抛错并提示 npm run 需加 -- 分隔符', () => {
    expect(() => parseFlagArgs(['vOrange-gwzc-530', 'pcx,public'], ['--name'], USAGE)).toThrow(
      /分隔符/
    );
  });

  it('knownFlags 为空时任何 token 都抛错（无参数命令）', () => {
    expect(() => parseFlagArgs(['--any'], [], USAGE)).toThrow(/本命令不支持任何参数/);
    expect(() => parseFlagArgs(['positional'], [], USAGE)).toThrow(/未识别的参数/);
  });
});
