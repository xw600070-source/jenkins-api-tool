import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

import { notify, buildAppleScript } from './notify-service';

const execFileSyncMock = vi.mocked(execFileSync);

describe('buildAppleScript', () => {
  it('拼装 display notification 脚本', () => {
    expect(buildAppleScript('标题', '正文', 'Glass')).toBe(
      'display notification "正文" with title "标题" sound name "Glass"'
    );
  });

  it('转义反斜杠与双引号', () => {
    expect(buildAppleScript('t', 'a"b\\c', 'Basso')).toBe(
      'display notification "a\\"b\\\\c" with title "t" sound name "Basso"'
    );
  });
});

describe('notify', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    delete process.env.NOTIFY;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('成功：弹通知，正文含构建号/耗时/产物', () => {
    notify({
      command: 'patch',
      success: true,
      buildNumber: 42,
      duration: 750_000,
      artifactPath: '/tmp/a.zip',
    });

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const script = String(execFileSyncMock.mock.calls[0]?.[1]?.[1] ?? '');
    expect(execFileSyncMock.mock.calls[0]?.[0]).toBe('osascript');
    expect(script).toContain('with title "✅ patch 打包完成"');
    expect(script).toContain('构建 #42');
    expect(script).toContain('耗时 12m 30s');
    expect(script).toContain('产物 /tmp/a.zip');
    expect(script).toContain('sound name "Glass"');
  });

  it('失败：Basso 提示音，正文含原因；字段缺失自动省略', () => {
    notify({ command: 'gwwy-online', success: false, error: 'boom' });

    const script = String(execFileSyncMock.mock.calls[0]?.[1]?.[1] ?? '');
    expect(script).toContain('with title "❌ gwwy-online 打包失败"');
    expect(script).toContain('原因 boom');
    expect(script).toContain('sound name "Basso"');
    expect(script).not.toContain('构建 #');
  });

  it('NOTIFY=0 时不发送', () => {
    process.env.NOTIFY = '0';
    notify({ command: 'patch', success: true });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('非 darwin 平台静默跳过', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    notify({ command: 'patch', success: true });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('osascript 调用失败不影响主流程（仅 warn）', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('osascript not found');
    });
    expect(() => notify({ command: 'patch', success: true })).not.toThrow();
  });
});
