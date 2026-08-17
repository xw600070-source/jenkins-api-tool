import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listProjectFiles, pickProjectFile } from './interactive';

/**
 * 构造可注入的输入/输出流。
 * 输出流收到"提问提示"后，按顺序从 answers 取下一条答案写入输入流——
 * 直接预写全部答案会被 readline 在无 pending question 时丢弃。
 * 输入流保持打开，避免 readline 因输入结束提前 close。
 */
function promptIO(answers: string[]) {
  const inputStream = new PassThrough();
  let answerIndex = 0;
  const outputChunks: string[] = [];
  const outputStream = new Writable({
    write(chunk, _enc, callback) {
      const text = String(chunk);
      outputChunks.push(text);
      if (text.includes('请输入序号') && answerIndex < answers.length) {
        const answer = answers[answerIndex++];
        setImmediate(() => inputStream.write(`${answer}\n`));
      }
      callback();
    },
  });
  return { inputStream, outputStream, output: () => outputChunks.join('') };
}

/** 捕获 console.log（选择列表 / 无效序号提示打到真 console） */
function spyConsole() {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.map(String).join(' '));
  });
  return { text: () => logs.join('\n'), restore: () => spy.mockRestore() };
}

describe('listProjectFiles', () => {
  it('只列普通文件、跳过隐藏文件、按名排序', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
      fs.mkdirSync(path.join(dir, 'subdir'));

      expect(listProjectFiles(dir)).toEqual(['a.txt', 'b.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录不存在返回空数组', () => {
    expect(listProjectFiles('/nonexistent-xyz')).toEqual([]);
  });
});

describe('pickProjectFile', () => {
  function setup(files: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-test-'));
    for (const file of files) fs.writeFileSync(path.join(dir, file), 'x');
    return dir;
  }

  it('回车默认选第 1 项', async () => {
    const dir = setup(['a.txt', 'b.txt']);
    const consoleSpy = spyConsole();
    try {
      const io = promptIO(['']);
      const picked = await pickProjectFile(dir, { input: io.inputStream, output: io.outputStream });
      expect(picked).toBe('a.txt');
      expect(consoleSpy.text()).toContain('1. a.txt');
      expect(io.output()).toContain('请输入序号');
      io.inputStream.end();
    } finally {
      consoleSpy.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('输入序号选择对应项；无效序号重新提问', async () => {
    const dir = setup(['a.txt', 'b.txt']);
    const consoleSpy = spyConsole();
    try {
      const io = promptIO(['99', '2']);
      const picked = await pickProjectFile(dir, { input: io.inputStream, output: io.outputStream });
      expect(picked).toBe('b.txt');
      expect(consoleSpy.text()).toContain('无效序号: 99');
      io.inputStream.end();
    } finally {
      consoleSpy.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('连续 3 次无效输入抛错', async () => {
    const dir = setup(['a.txt']);
    const consoleSpy = spyConsole();
    try {
      const io = promptIO(['x', 'y', 'z']);
      await expect(
        pickProjectFile(dir, { input: io.inputStream, output: io.outputStream })
      ).rejects.toMatchObject({ name: 'JenkinsError' });
      io.inputStream.end();
    } finally {
      consoleSpy.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空目录抛错', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-test-'));
    try {
      await expect(pickProjectFile(dir)).rejects.toMatchObject({ name: 'JenkinsError' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
