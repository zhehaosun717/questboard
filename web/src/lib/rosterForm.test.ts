import { describe, expect, it } from 'vitest';
import { validateCardForm } from './rosterForm';

describe('rosterForm validation', () => {
  const lanes = ['code', 'review', 'art'];

  it('valid card returns parsed AdventurerInput and no errors', () => {
    const res = validateCardForm(
      {
        id: 'adv-gemini-pro',
        name: '双子座',
        provider: 'google',
        lane: 'code',
        model: 'gemini-2.5-pro',
        family: 'gemini',
        variant: 'thinking',
        agent: 'sisyphus',
        billing: 'subscription',
        maxParallel: 2,
        strengths: 'code, review',
        notes: '适合复杂架构分析',
      },
      lanes,
    );

    expect(res.errors).toEqual({});
    expect(res.value).toEqual({
      id: 'adv-gemini-pro',
      name: '双子座',
      provider: 'google',
      lane: 'code',
      model: 'gemini-2.5-pro',
      family: 'gemini',
      variant: 'thinking',
      agent: 'sisyphus',
      billing: 'subscription',
      maxParallel: 2,
      strengths: ['code', 'review'],
      notes: '适合复杂架构分析',
    });
  });

  it('bad id rejects uppercase, symbols, and id over 48 characters', () => {
    const uppercase = validateCardForm(
      {
        id: 'Bad_Id',
        name: 'Test',
        provider: 'p',
        lane: 'code',
        model: 'm',
        family: 'f',
      },
      lanes,
    );
    expect(uppercase.errors.id).toBeDefined();
    expect(uppercase.value).toBeNull();

    const over48 = validateCardForm(
      {
        id: 'a'.repeat(49),
        name: 'Test',
        provider: 'p',
        lane: 'code',
        model: 'm',
        family: 'f',
      },
      lanes,
    );
    expect(over48.errors.id).toBeDefined();
    expect(over48.value).toBeNull();
  });

  it('missing required field produces errors', () => {
    const res = validateCardForm({}, lanes);
    expect(res.errors.id).toBeDefined();
    expect(res.errors.name).toBeDefined();
    expect(res.errors.provider).toBeDefined();
    expect(res.errors.lane).toBeDefined();
    expect(res.errors.model).toBeDefined();
    expect(res.errors.family).toBeDefined();
    expect(res.value).toBeNull();
  });

  it('unknown lane produces error on lane', () => {
    const res = validateCardForm(
      {
        id: 'adv-test',
        name: 'Test',
        provider: 'p',
        lane: 'secret-lane',
        model: 'm',
        family: 'f',
      },
      lanes,
    );
    expect(res.errors.lane).toBeDefined();
    expect(res.value).toBeNull();
  });

  it('notes over 300 characters produces error on notes', () => {
    const res = validateCardForm(
      {
        id: 'adv-test',
        name: 'Test',
        provider: 'p',
        lane: 'code',
        model: 'm',
        family: 'f',
        notes: 'x'.repeat(301),
      },
      lanes,
    );
    expect(res.errors.notes).toBeDefined();
    expect(res.value).toBeNull();
  });

  it('maxParallel 0 and 1.5 produce error on maxParallel', () => {
    const zero = validateCardForm(
      {
        id: 'adv-test',
        name: 'Test',
        provider: 'p',
        lane: 'code',
        model: 'm',
        family: 'f',
        maxParallel: 0,
      },
      lanes,
    );
    expect(zero.errors.maxParallel).toBeDefined();
    expect(zero.value).toBeNull();

    const float = validateCardForm(
      {
        id: 'adv-test',
        name: 'Test',
        provider: 'p',
        lane: 'code',
        model: 'm',
        family: 'f',
        maxParallel: 1.5,
      },
      lanes,
    );
    expect(float.errors.maxParallel).toBeDefined();
    expect(float.value).toBeNull();
  });

  it('strengths from "code, review ,," becomes ["code","review"]', () => {
    const res = validateCardForm(
      {
        id: 'adv-test',
        name: 'Test',
        provider: 'p',
        lane: 'code',
        model: 'm',
        family: 'f',
        strengths: 'code, review ,,',
      },
      lanes,
    );
    expect(res.errors).toEqual({});
    expect(res.value?.strengths).toEqual(['code', 'review']);
  });

  it('empty optional fields are left out of value', () => {
    const res = validateCardForm(
      {
        id: 'adv-minimal',
        name: 'Minimal',
        provider: 'deepseek',
        lane: 'code',
        model: 'deepseek-coder',
        family: 'deepseek',
        variant: '   ',
        agent: '',
        billing: '',
        maxParallel: '',
        strengths: ' , , ',
        notes: '',
      },
      lanes,
    );

    expect(res.errors).toEqual({});
    expect(res.value).toEqual({
      id: 'adv-minimal',
      name: 'Minimal',
      provider: 'deepseek',
      lane: 'code',
      model: 'deepseek-coder',
      family: 'deepseek',
    });
    expect('variant' in (res.value ?? {})).toBe(false);
    expect('agent' in (res.value ?? {})).toBe(false);
    expect('billing' in (res.value ?? {})).toBe(false);
    expect('maxParallel' in (res.value ?? {})).toBe(false);
    expect('strengths' in (res.value ?? {})).toBe(false);
    expect('notes' in (res.value ?? {})).toBe(false);
  });
});
