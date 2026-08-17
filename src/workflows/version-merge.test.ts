import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveMergeInput, MERGE_DIR } from './version-merge';

function setupDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
  const mergeDir = path.join(root, 'merge');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(mergeDir);
  fs.mkdirSync(projectDir);
  const put = (dir: string, name: string) => fs.writeFileSync(path.join(dir, name), 'x');
  return { root, mergeDir, projectDir, put };
}

describe('resolveMergeInput', () => {
  it('缺省：读取 merge/ 目录下的默认文件（vOrange / orangePatchVersion.txt）', () => {
    const { mergeDir, projectDir, put } = setupDirs();
    put(mergeDir, 'vOrange');
    put(mergeDir, 'orangePatchVersion.txt');

    expect(resolveMergeInput(undefined, 'vorange', { mergeDir, projectDir })).toBe(
      path.join(mergeDir, 'vOrange')
    );
    expect(resolveMergeInput(undefined, 'patch', { mergeDir, projectDir })).toBe(
      path.join(mergeDir, 'orangePatchVersion.txt')
    );
  });

  it('缺省但默认文件不存在：报错并提示放到 merge/ 目录', () => {
    const { mergeDir, projectDir } = setupDirs();

    expect(() => resolveMergeInput(undefined, 'vorange', { mergeDir, projectDir })).toThrow(
      /merge\/ 目录/
    );
    expect(() => resolveMergeInput(undefined, 'patch', { mergeDir, projectDir })).toThrow(
      /orangePatchVersion\.txt/
    );
  });

  it('纯文件名：merge/ 优先于 project/', () => {
    const { mergeDir, projectDir, put } = setupDirs();
    put(mergeDir, 'a.txt');
    put(projectDir, 'a.txt');

    expect(resolveMergeInput('a.txt', 'vorange', { mergeDir, projectDir })).toBe(
      path.join(mergeDir, 'a.txt')
    );
  });

  it('纯文件名：merge/ 没有时回落 project/', () => {
    const { mergeDir, projectDir, put } = setupDirs();
    put(projectDir, 'vOrange-gwzc-530');

    expect(resolveMergeInput('vOrange-gwzc-530', 'vorange', { mergeDir, projectDir })).toBe(
      path.join(projectDir, 'vOrange-gwzc-530')
    );
  });

  it('纯文件名两处都没有：报错并列出两个目录内容', () => {
    const { mergeDir, projectDir, put } = setupDirs();
    put(projectDir, 'only.txt');

    expect(() => resolveMergeInput('nope.txt', 'patch', { mergeDir, projectDir })).toThrow(
      /only\.txt/
    );
  });

  it('绝对路径按原样使用', () => {
    const { root, mergeDir, projectDir } = setupDirs();
    const abs = path.join(root, 'abs-file');
    fs.writeFileSync(abs, 'x');

    expect(resolveMergeInput(abs, 'vorange', { mergeDir, projectDir })).toBe(abs);
  });

  it('含分隔符的相对路径按当前目录解析', () => {
    const { root, mergeDir, projectDir } = setupDirs();
    fs.writeFileSync(path.join(root, 'rel-file'), 'x');

    const cwd = process.cwd();
    try {
      process.chdir(root);
      const resolved = resolveMergeInput('./rel-file', 'patch', { mergeDir, projectDir });
      // macOS 上 /var 与 /private/var 互为别名，用存在性断言而非字面量比对
      expect(fs.existsSync(resolved)).toBe(true);
      expect(path.basename(resolved)).toBe('rel-file');
    } finally {
      process.chdir(cwd);
    }
  });

  it('MERGE_DIR 指向仓库根目录的 merge/', () => {
    expect(MERGE_DIR).toBe(path.join(process.cwd(), 'merge'));
  });
});
