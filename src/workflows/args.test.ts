import { describe, it, expect } from 'vitest';
import { parsePatchArgs } from './patch';
import { parseGwwyOnlineArgs } from './gwwy-online';
import { parseGwwyLocalArgs, DEFAULT_TARGET_BRANCH } from './gwwy-local';
import { parseMergeArgs } from './version-merge';

describe('parsePatchArgs', () => {
  it('无参数时 module 默认 pcx、project 可缺省（交互选择）', () => {
    expect(parsePatchArgs([])).toEqual({ project: undefined, module: 'pcx' });
  });

  it('解析 --project 与 --module', () => {
    expect(parsePatchArgs(['--project', 'vOrange-gwzc-530', '--module', 'pcx,home'])).toEqual({
      project: 'vOrange-gwzc-530',
      module: 'pcx,home',
    });
  });

  it('位置参数抛错并提示 npm run 需加 --（回归：npm 吞 flag 后只剩值透传）', () => {
    expect(() => parsePatchArgs(['vOrange-gwzc-530', 'pcx,public'])).toThrow(/分隔符/);
  });

  it('未知 flag 抛错并列出可用参数', () => {
    expect(() => parsePatchArgs(['--projct', 'x'])).toThrow(/--project/);
  });

  it('flag 缺取值抛错', () => {
    expect(() => parsePatchArgs(['--project'])).toThrow(/缺少取值/);
  });
});

describe('parseGwwyOnlineArgs', () => {
  it('缺 --branch 抛错并带用法提示', () => {
    expect(() => parseGwwyOnlineArgs([])).toThrow(/--branch/);
  });

  it('--head 默认 HEAD', () => {
    expect(parseGwwyOnlineArgs(['--branch', 'Feature_x'])).toEqual({
      branch: 'Feature_x',
      head: 'HEAD',
    });
  });

  it('解析 --head', () => {
    expect(parseGwwyOnlineArgs(['--branch', 'B', '--head', '4e9d71ff'])).toEqual({
      branch: 'B',
      head: '4e9d71ff',
    });
  });

  it('位置参数抛错并提示 npm run 需加 --', () => {
    expect(() => parseGwwyOnlineArgs(['Feature_x'])).toThrow(/分隔符/);
  });

  it('未知 flag 抛错', () => {
    expect(() => parseGwwyOnlineArgs(['--brnach', 'x'])).toThrow(/--branch/);
  });
});

describe('parseGwwyLocalArgs', () => {
  it('默认分支', () => {
    expect(parseGwwyLocalArgs([])).toEqual({ branch: DEFAULT_TARGET_BRANCH });
  });

  it('--branch 覆盖默认分支', () => {
    expect(parseGwwyLocalArgs(['--branch', 'Feature_20260701_x'])).toEqual({
      branch: 'Feature_20260701_x',
    });
  });

  it('位置参数抛错并提示 npm run 需加 --', () => {
    expect(() => parseGwwyLocalArgs(['Feature_x'])).toThrow(/分隔符/);
  });
});

describe('parseMergeArgs', () => {
  it('无参数时两个文件均为空（交互选择）', () => {
    expect(parseMergeArgs([])).toEqual({ vorange: undefined, patch: undefined });
  });

  it('解析 --vorange 与 --patch', () => {
    expect(parseMergeArgs(['--vorange', 'vOrange-gwzc-530', '--patch', 'orangePatchVersion.txt'])).toEqual({
      vorange: 'vOrange-gwzc-530',
      patch: 'orangePatchVersion.txt',
    });
  });

  it('只传其中一个时另一个为空', () => {
    expect(parseMergeArgs(['--patch', 'p.txt'])).toEqual({ vorange: undefined, patch: 'p.txt' });
  });

  it('位置参数抛错并提示 npm run 需加 --', () => {
    expect(() => parseMergeArgs(['vOrange'])).toThrow(/分隔符/);
  });

  it('未知 flag 抛错', () => {
    expect(() => parseMergeArgs(['--vorang', 'x'])).toThrow(/--vorange/);
  });
});
