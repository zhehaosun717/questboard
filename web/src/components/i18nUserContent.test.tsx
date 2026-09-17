import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Toast } from '../hooks/useBoard';
import type { ThreadDetail } from '../api/types';
import type { ProjectDraft } from '../lib/settingsForm';
import { DEFAULT_LOCALE, setLocale, t } from '../lib/i18n';
import { makeCard, makeSnapshot } from '../lib/testFixtures';
import { Board } from './Board';
import { Toasts } from './Toasts';
import { LaneServerPanel } from './settings/LaneServerPanel';
import { SettingsProjectSection } from './settings/SettingsProjectSection';
import { RosterCardRow } from './roster/RosterCardRow';
import { ThreadDetailPane } from './threads/ThreadDetailPane';

const USER_TEXT = '委托「中文标题」已完成：这是用户自己的内容';
const toast: Toast = { id: 1, at: new Date('2026-01-01T00:00:00.000Z').toISOString(), text: USER_TEXT };
const noop = () => {};

const USER_CARD = makeCard('card-user-1', { name: '用户起的卡片名', model: '用户模型', lane: '用户接入方式' });

const USER_THREAD: ThreadDetail = {
  id: 'th-1',
  title: '用户写的标题',
  tags: [],
  author: '用户甲',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  pinned: false,
  closed: false,
  messageCount: 1,
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  messages: [
    { id: 'm-1', threadId: 'th-1', body: '用户写的正文：不要翻译我', author: '用户甲', createdAt: '2026-01-01T00:00:00.000Z' },
  ],
};

const USER_DRAFT: ProjectDraft = {
  name: '用户项目名',
  port: '6097',
  dataDir: '.questboard-data',
  events: '.questboard-data/events.jsonl',
  registry: '.questboard-data/registry.jsonl',
  lockFile: '.questboard-data/dispatch.lock',
  bash: 'E:/git/bin/bash.exe',
};

const USER_PATHS = {
  data: 'E:/questboard/data',
  events: 'E:/questboard/data/events.jsonl',
  registry: 'E:/questboard/data/registry.jsonl',
  lock: 'E:/questboard/data/dispatch.lock',
};

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

  it('renders roster, thread and settings panels in English without translating user content', () => {
    setLocale('en');

    const row = renderToStaticMarkup(
      <RosterCardRow card={USER_CARD} onOpenStatus={noop} onEdit={noop} onDuplicate={noop} onDelete={noop} />,
    );
    expect(row).toContain('用户起的卡片名');
    expect(row).toContain('card-user-1');
    expect(row).toContain('用户模型');
    expect(row).toContain('用户接入方式');
    expect(row).toContain(t('rosterRow.setStatus'));
    expect(row).toContain(t('rosterRow.edit'));

    const pane = renderToStaticMarkup(
      <ThreadDetailPane
        activeThread={USER_THREAD}
        activeError={null}
        author="用户甲"
        onAuthorChange={noop}
        replyBody=""
        onReplyBodyChange={noop}
        refusalMessage={null}
        replySubmitting={false}
        onTogglePin={noop}
        onToggleClose={noop}
        onSendReply={noop}
      />,
    );
    expect(pane).toContain('用户写的标题');
    expect(pane).toContain('用户甲');
    expect(pane).toContain('用户写的正文：不要翻译我');
    expect(pane).toContain(t('threads.sendReply'));
    expect(pane).toContain(t('threads.yourName'));

    const section = renderToStaticMarkup(
      <SettingsProjectSection draft={USER_DRAFT} paths={USER_PATHS} errors={{}} onChange={noop} />,
    );
    expect(section).toContain('用户项目名');
    expect(section).toContain('E:/questboard/data');
    expect(section).toContain(t('settingsProject.title'));
    expect(section).toContain(t('settingsProject.resolved'));
  });

  it('hides English column subtitles that only repeat the title and keeps the Chinese ones', () => {
    setLocale('en');
    const snap = makeSnapshot();
    const en = renderToStaticMarkup(<Board snap={snap} pickingCardId={null} onSelectQuest={noop} onDropCard={noop} />);
    expect(en).toContain('On quest');
    expect(en).not.toContain('ON QUEST');
    expect(en).not.toContain('YOUR CALL');
    expect(en).toContain('OPEN');

    setLocale(DEFAULT_LOCALE);
    const zh = renderToStaticMarkup(<Board snap={snap} pickingCardId={null} onSelectQuest={noop} onDropCard={noop} />);
    expect(zh).toContain('ON QUEST');
    expect(zh).toContain('出任务中');
    expect(zh).toContain('等会长');
  });
});
