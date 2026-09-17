import { describe, expect, it } from 'vitest';
import type { Quest } from '../api/types';
import {
  describeExistingPackageRefusal,
  describeRedoFieldErrors,
  describeRedoProblem,
  findQuestByPackage,
  GENERIC_FIELD_ERROR_ZH,
  REDO_FIELD_LABELS,
} from './redoSubmission';
import { makeQuest } from './testFixtures';

describe('describeRedoFieldErrors', () => {
  it('把委托编号的已知拒绝翻译成固定中文', () => {
    // 默认项目的真实拒绝原文（store.js:68：package must match + 编译后的编号规则）。
    expect(
      describeRedoFieldErrors({ package: 'package must match /^(?:[A-Z]+(?:-[A-Z]+)*-\\d+[A-Z]?)$/' })
        .package,
    ).toBe('委托编号不符合这个项目的编号规则，请照简报文件名开头的编号来写（例如 ART-REDO-1）。');
    expect(
      describeRedoFieldErrors({ package: 'ART-OLD-7 is running; cancel it before re-posting' }).package,
    ).toBe('这个委托还有 worker 在跑，先取消它再重新提交。');
  });

  it('有 worker 占着 的拒绝在任何一个字段上都翻成同一句中文', () => {
    const message = 'ART-OLD-7 有 worker 占着（dispatched），先释放再改';
    const expected = '这个委托还有 worker 占着，先确认它已停止并释放，再重新提交。';
    expect(describeRedoFieldErrors({ package: message }).package).toBe(expected);
    expect(describeRedoFieldErrors({ brief: message }).brief).toBe(expected);
    expect(describeRedoFieldErrors({ parents: message }).parents).toBe(expected);
    expect(describeRedoFieldErrors({ conflicts: message }).conflicts).toBe(expected);
    expect(describeRedoFieldErrors({ allowedLanes: message }).allowedLanes).toBe(expected);
  });

  it('把简报路径的已知拒绝翻译成固定中文', () => {
    expect(describeRedoFieldErrors({ brief: 'brief is required' }).brief).toBe('请填写简报路径。');
    expect(
      describeRedoFieldErrors({ brief: 'brief must be <dir>/<file>.md with <dir> one of docs/briefs' })
        .brief,
    ).toBe('简报要放在这些目录里，文件名以 .md 结尾：docs/briefs');
    expect(
      describeRedoFieldErrors({ brief: 'brief must be <dir>/<file>.md with <dir> one of docs/briefs, briefs' })
        .brief,
    ).toBe('简报要放在这些目录里，文件名以 .md 结尾：docs/briefs, briefs');
    expect(
      describeRedoFieldErrors({ brief: 'brief must be <dir>/<file>.md' })
        .brief,
    ).toBe('简报路径不在这个项目允许的简报目录里。');
  });

  it('把其他已知字段拒绝翻译成固定中文', () => {
    expect(describeRedoFieldErrors({ kind: 'kind must be one of code|art' }).kind).toBe('类型只能是美术。');
    expect(describeRedoFieldErrors({ priority: 'priority must be 1, 2 or 3' }).priority).toBe(
      '优先级只能是 1、2 或 3。',
    );
    expect(describeRedoFieldErrors({ parents: 'parents must be package ids, got nope' }).parents).toBe(
      '前置委托里出现了不是委托编号的内容。',
    );
    expect(describeRedoFieldErrors({ conflicts: 'conflicts must be package ids, got nope' }).conflicts).toBe(
      '「不能同时做」里出现了不是委托编号的内容。',
    );
    expect(
      describeRedoFieldErrors({ allowedLanes: 'unknown lane ghost; this project defines codex' })
        .allowedLanes,
    ).toBe('这个通道不在项目设置里。');
  });

  it('不认识的字段名不进结果，字段值不是字符串时给通用提示', () => {
    expect(describeRedoFieldErrors({ evil: 'do bad things', hack: 1 })).toEqual({});
    expect(describeRedoFieldErrors({ package: 42 }).package).toBe(GENERIC_FIELD_ERROR_ZH);
  });

  it('空白和没有内容的值直接跳过，非对象一律当作没有字段错误', () => {
    expect(describeRedoFieldErrors({ brief: '   ' })).toEqual({});
    expect(describeRedoFieldErrors(null)).toEqual({});
    expect(describeRedoFieldErrors([])).toEqual({});
    expect(describeRedoFieldErrors('package must match nope')).toEqual({});
    expect(describeRedoFieldErrors(7)).toEqual({});
  });

  it('固定文案里绝不带上服务器原文', () => {
    const mapped = describeRedoFieldErrors({
      package: 'package must match SECRET-REGEX-42',
      brief: 'brief must be SECRETTY',
      kind: 'kind must be one of SECRET-KINDS',
      priority: 'priority must be 1, 2 or 3 SECRETTAIL',
    });
    const text = JSON.stringify(mapped);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('must match');
  });
});

describe('describeRedoProblem', () => {
  it('真实 404 一律按旧看板服务解释', () => {
    const expected = '看板服务没有这个接口（可能是旧版本），无法发起重做。';
    expect(describeRedoProblem({ status: 404 })).toBe(expected);
    expect(describeRedoProblem({ message: 'not found' })).toBe(expected);
    expect(describeRedoProblem({ status: 404, message: 'not found' })).toBe(expected);
    expect(describeRedoProblem({ message: 'HTTP 404' })).toBe(expected);
  });

  it('客户端合成的 HTTP nnn 照实转成中文', () => {
    expect(describeRedoProblem({ message: 'HTTP 503' })).toBe('看板服务返回了错误：HTTP 503。');
  });

  it('把已知的顶层拒绝翻译成固定中文', () => {
    expect(describeRedoProblem({ message: 'validation failed' })).toBe('填写内容有误，请检查后再试。');
    expect(describeRedoProblem({ message: 'cross-site request refused' })).toBe(
      '跨站请求被拒绝：只有本机打开的看板页面能写入。',
    );
    expect(describeRedoProblem({ message: 'origin http://evil.example refused' })).toBe(
      '该来源被拒绝：只有本机打开的看板页面能写入。',
    );
  });

  it('不认识的错误给通用中文，不回显服务器原文', () => {
    const text = describeRedoProblem({ message: 'cannot open C:/secret/path at line 9' });
    expect(text).toBe('服务器拒绝了这次提交，请检查后再试。');
    expect(text).not.toContain('secret');
    expect(describeRedoProblem({})).toBe('服务器拒绝了这次提交，请检查后再试。');
  });
});

describe('findQuestByPackage', () => {
  const quests = [makeQuest({ id: 'ART-BASE-1' }), makeQuest({ id: 'ART-OLD-7', status: 'done' })];

  it('按编号找到已经在看板上的委托', () => {
    expect(findQuestByPackage(quests, 'ART-OLD-7')?.id).toBe('ART-OLD-7');
    expect(findQuestByPackage(quests, '  ART-OLD-7  ')?.id).toBe('ART-OLD-7');
  });

  it('没填编号、没有列表或找不到时返回 null', () => {
    expect(findQuestByPackage(quests, '')).toBeNull();
    expect(findQuestByPackage(quests, '   ')).toBeNull();
    expect(findQuestByPackage(quests, 'ART-NEW-1')).toBeNull();
    expect(findQuestByPackage(undefined, 'ART-OLD-7')).toBeNull();
  });
});

describe('describeExistingPackageRefusal', () => {
  it('带上看板上的状态中文，并让 owner 换一个新编号', () => {
    const text = describeExistingPackageRefusal(makeQuest({ id: 'ART-OLD-7', status: 'done' }));
    expect(text).toContain('这个编号已经在看板上（状态：已完成）');
    expect(text).toContain('换一个新编号');
    expect(text).not.toContain('done');
  });

  it('状态不在已知表里时写未知状态', () => {
    const quest: Quest = makeQuest({ id: 'X-1', status: 'weird' as Quest['status'] });
    expect(describeExistingPackageRefusal(quest)).toContain('状态：未知状态');
  });
});

describe('REDO_FIELD_LABELS', () => {
  it('预览里用的是固定的中文字段名', () => {
    expect(REDO_FIELD_LABELS.package).toBe('委托编号');
    expect(REDO_FIELD_LABELS.brief).toBe('简报路径');
    expect(REDO_FIELD_LABELS.kind).toBe('类型');
    expect(REDO_FIELD_LABELS.conflicts).toBe('不能同时做');
    expect(REDO_FIELD_LABELS.allowedLanes).toBe('限定通道');
  });
});
