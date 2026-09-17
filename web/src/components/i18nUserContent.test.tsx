import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Toast } from '../hooks/useBoard';
import { DEFAULT_LOCALE, setLocale, t } from '../lib/i18n';
import { Toasts } from './Toasts';
import { LaneServerPanel } from './settings/LaneServerPanel';

const USER_TEXT = '委托「中文标题」已完成：这是用户自己的内容';
const toast: Toast = { id: 1, at: new Date('2026-01-01T00:00:00.000Z').toISOString(), text: USER_TEXT };
const noop = () => {};

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe('language switch and user content', () => {
  it("renders today's Chinese by default", () => {
    const toasts = renderToStaticMarkup(<Toasts toasts={[toast]} />);
    expect(toasts).toContain('公会回执');
    expect(toasts).toContain(USER_TEXT);
    const panel = renderToStaticMarkup(<LaneServerPanel server={undefined} starting={false} message={undefined} onStart={noop} />);
    expect(panel).toContain('保存并重启看板后，这里会显示服务是否在运行');
  });

  it('renders English interface labels while user content stays untouched', () => {
    setLocale('en');
    const toasts = renderToStaticMarkup(<Toasts toasts={[toast]} />);
    expect(toasts).toContain(USER_TEXT);
    expect(toasts).not.toContain('公会回执');
    expect(toasts).toContain(t('toast.guildReceipt'));
    const panel = renderToStaticMarkup(<LaneServerPanel server={undefined} starting={false} message={undefined} onStart={noop} />);
    expect(panel).toContain(t('laneServer.pending'));
    expect(panel).not.toContain('保存并重启看板后，这里会显示服务是否在运行');
  });
});
