import { describe, expect, it } from 'vitest';

// questboard is a generic tool for any project, so its interface must not carry one project's theme (the
// salvage/pit wording it was first built with).
const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx', '!./genericWording.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const FORBIDDEN = ['SALVAGE', 'IN THE PIT', 'HAULED UP'];

describe('generic wording guard', () => {
  it('keeps salvage and pit wording out of web/src', () => {
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(20);
    const violations = files.flatMap(([file, text]) =>
      FORBIDDEN.filter((phrase) => text.includes(phrase)).map((phrase) => `${file} contains "${phrase}"`),
    );
    expect(violations).toEqual([]);
  });
});
