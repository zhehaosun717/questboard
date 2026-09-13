import { describe, expect, it } from 'vitest';
import { changedOmoRows, getRoleHint } from './omo';

describe('omo helpers', () => {
  it('excludes unchanged rows', () => {
    const original = {
      agents: [
        { name: 'sisyphus', model: 'anthropic/claude-3-7-sonnet', reasoning: 'high' },
        { name: 'oracle', model: 'openai/o3-mini', reasoning: 'medium' },
      ],
      categories: [
        { name: 'quick', model: 'deepseek/v3', reasoning: 'off' },
      ],
    };

    const edited = {
      agents: [
        { name: 'sisyphus', model: 'anthropic/claude-3-7-sonnet', reasoning: 'high' },
        { name: 'oracle', model: 'openai/o3-mini', reasoning: 'medium' },
      ],
      categories: [
        { name: 'quick', model: 'deepseek/v3', reasoning: 'off' },
      ],
    };

    const changes = changedOmoRows(original, edited);
    expect(changes).toEqual([]);
  });

  it('detects model change, reasoning change, and both', () => {
    const original = {
      agents: [
        { name: 'sisyphus', model: 'anthropic/claude-3-7-sonnet', reasoning: 'high' },
        { name: 'oracle', model: 'openai/o3-mini', reasoning: 'medium' },
        { name: 'librarian', model: 'google/gemini-2.5-flash', reasoning: 'low' },
      ],
      categories: [
        { name: 'writing', model: 'deepseek/v3', reasoning: 'off' },
      ],
    };

    const edited = {
      agents: [
        // model change only
        { name: 'sisyphus', model: 'anthropic/claude-3-5-sonnet', reasoning: 'high' },
        // reasoning change only
        { name: 'oracle', model: 'openai/o3-mini', reasoning: 'high' },
        // both changed
        { name: 'librarian', model: 'google/gemini-2.5-pro', reasoning: 'max' },
      ],
      categories: [
        // unchanged
        { name: 'writing', model: 'deepseek/v3', reasoning: 'off' },
      ],
    };

    const changes = changedOmoRows(original, edited);
    expect(changes).toEqual([
      {
        section: 'agents',
        name: 'sisyphus',
        model: 'anthropic/claude-3-5-sonnet',
        reasoning: 'high',
      },
      {
        section: 'agents',
        name: 'oracle',
        model: 'openai/o3-mini',
        reasoning: 'high',
      },
      {
        section: 'agents',
        name: 'librarian',
        model: 'google/gemini-2.5-pro',
        reasoning: 'max',
      },
    ]);
  });

  it('includes cleared values as empty strings', () => {
    const original = {
      agents: [
        { name: 'quick', model: 'deepseek/v3', reasoning: 'minimal' },
      ],
      categories: [
        { name: 'explore', model: 'openai/gpt-4o', reasoning: 'auto' },
      ],
    };

    const edited = {
      agents: [
        { name: 'quick', model: '', reasoning: '' },
      ],
      categories: [
        { name: 'explore', model: '', reasoning: 'auto' },
      ],
    };

    const changes = changedOmoRows(original, edited);
    expect(changes).toEqual([
      {
        section: 'agents',
        name: 'quick',
        model: '',
        reasoning: '',
      },
      {
        section: 'categories',
        name: 'explore',
        model: '',
        reasoning: 'auto',
      },
    ]);
  });

  it('returns role hint for known names and null for unknown', () => {
    expect(getRoleHint('sisyphus')).toBe('主控编排（primary）');
    expect(getRoleHint('oracle')).toBe('架构/调试顾问');
    expect(getRoleHint('unknown-robot')).toBeNull();
  });

  it('names every agent role, hyphenated ones included', () => {
    expect(getRoleHint('hephaestus')).toBe('深工执行（primary）');
    expect(getRoleHint('prometheus')).toBe('计划构建（primary）');
    expect(getRoleHint('atlas')).toBe('计划执行（primary）');
    expect(getRoleHint('momus')).toBe('计划审查');
    expect(getRoleHint('metis')).toBe('需求分析顾问');
    expect(getRoleHint('librarian')).toBe('外部文档/代码搜索');
    expect(getRoleHint('explore')).toBe('代码库快速检索');
    expect(getRoleHint('multimodal-looker')).toBe('图片/PDF 多模态分析');
    expect(getRoleHint('sisyphus-junior')).toBe('委派执行单元');
  });

  it('matches a name whatever case the config file spells it in', () => {
    expect(getRoleHint('Sisyphus')).toBe('主控编排（primary）');
    expect(getRoleHint('Multimodal-Looker')).toBe('图片/PDF 多模态分析');
  });
});
