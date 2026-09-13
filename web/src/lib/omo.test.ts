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
    expect(getRoleHint('sisyphus')).toBe('主控编排');
    expect(getRoleHint('oracle')).toBe('架构/调试顾问');
    expect(getRoleHint('unknown-robot')).toBeNull();
  });
});
