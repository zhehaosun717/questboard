import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_OPTIONS,
  TRANSLATIONS,
  getLocale,
  isLocale,
  loadLocale,
  saveLocale,
  setLocale,
  subscribeLocale,
  t,
  type I18nKey,
} from './i18n';

type TranslationEntry = { zh: string; en?: string };
const entriesOf = (): Array<[I18nKey, TranslationEntry]> =>
  Object.entries(TRANSLATIONS) as Array<[I18nKey, TranslationEntry]>;

class FakeStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe('dictionary', () => {
  it('gives every key a non-empty Chinese string', () => {
    const entries = entriesOf();
    expect(entries.length).toBeGreaterThan(100);
    for (const [key, entry] of entries) {
      expect(entry.zh.length, key).toBeGreaterThan(0);
    }
  });

  it('translates every key in English without ever returning the key name or an empty string', () => {
    setLocale('en');
    for (const [key, entry] of entriesOf()) {
      const value = t(key);
      expect(value.length, key).toBeGreaterThan(0);
      expect(value, key).not.toBe(key);
      expect(value, key).toBe(entry.en !== undefined ? entry.en : entry.zh);
    }
  });

  it('has real English wording for most keys, with only deliberate fallbacks left', () => {
    const entries = entriesOf();
    const withEnglish = entries.filter(([, entry]) => entry.en !== undefined);
    const translated = withEnglish.filter(([, entry]) => entry.en !== entry.zh);
    expect(translated.length).toBeGreaterThan(200);
    expect(translated.length).toBeLessThanOrEqual(withEnglish.length);
  });

  it('fills placeholders and leaves unknown ones verbatim', () => {
    expect(t('header.tab.threadsWithCount')).toBe('留言板 · {count}');
    expect(t('header.tab.threadsWithCount', { count: 3 })).toBe('留言板 · 3');
    expect(t('header.tab.threadsWithCount', { other: 'x' })).toBe('留言板 · {count}');
    expect(t('header.tab.threads')).toBe('留言板');
  });
});

describe('locale preference', () => {
  it('starts on Chinese before anything is changed', () => {
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    expect(LOCALE_OPTIONS.map((option) => option.value)).toEqual(['zh-CN', 'en']);
    expect(getLocale()).toBe(DEFAULT_LOCALE);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });

  it('round-trips a saved choice through storage', () => {
    const storage = new FakeStorage();
    saveLocale('en', storage);
    expect(storage.getItem('questboard.locale.v1')).toBe('en');
    expect(loadLocale(storage)).toBe('en');
  });

  it('degrades a hand-edited or unreadable value to Chinese instead of throwing', () => {
    const storage = new FakeStorage();
    storage.setItem('questboard.locale.v1', 'klingon');
    expect(loadLocale(storage)).toBe(DEFAULT_LOCALE);
    expect(loadLocale(null)).toBe(DEFAULT_LOCALE);
    const readOnly = { getItem: () => 'en' };
    expect(() => saveLocale('en', readOnly)).not.toThrow();
  });

  it('notifies subscribers once per real change and stops after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeLocale(() => {
      calls += 1;
    });
    const storage = new FakeStorage();
    setLocale('en', storage);
    expect(calls).toBe(1);
    expect(storage.getItem('questboard.locale.v1')).toBe('en');
    setLocale('en', storage);
    expect(calls).toBe(1);
    setLocale(DEFAULT_LOCALE, storage);
    expect(calls).toBe(2);
    unsubscribe();
    setLocale('en', storage);
    expect(calls).toBe(2);
  });
});
