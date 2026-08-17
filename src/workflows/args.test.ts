import { describe, it, expect } from 'vitest';
import { parsePatchArgs } from './patch';
import { parseGwwyOnlineArgs } from './gwwy-online';
import { parseGwwyLocalArgs, DEFAULT_TARGET_BRANCH } from './gwwy-local';

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
});
