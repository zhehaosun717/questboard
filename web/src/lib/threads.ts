export interface TextSegment {
  kind: 'text' | 'link';
  value: string;
}

const URL_REGEX = /https?:\/\/[^\s<]+/g;

const TRAILING_PUNCT_CHARS = new Set([
  '.',
  ',',
  '!',
  '?',
  ':',
  ';',
  ')',
  ']',
  '}',
  '。',
  '，',
  '！',
  '？',
  '：',
  '；',
  '）',
  '】',
  '』',
  '」',
  '、',
  '”',
  '’',
]);

function countChar(str: string, char: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) count++;
  }
  return count;
}

export function linkSegments(text: string): TextSegment[] {
  if (!text) return [];

  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const matchIndex = match.index;
    let candidate = match[0];

    if (matchIndex > lastIndex) {
      segments.push({
        kind: 'text',
        value: text.slice(lastIndex, matchIndex),
      });
    }

    let trimmedPunct = '';
    while (candidate.length > 0) {
      const lastChar = candidate[candidate.length - 1];
      if (!lastChar) break;

      if (lastChar === ')') {
        const opens = countChar(candidate, '(');
        const closes = countChar(candidate, ')');
        if (closes > opens) {
          trimmedPunct = lastChar + trimmedPunct;
          candidate = candidate.slice(0, -1);
          continue;
        }
        break;
      }

      if (lastChar === ']') {
        const opens = countChar(candidate, '[');
        const closes = countChar(candidate, ']');
        if (closes > opens) {
          trimmedPunct = lastChar + trimmedPunct;
          candidate = candidate.slice(0, -1);
          continue;
        }
        break;
      }

      if (TRAILING_PUNCT_CHARS.has(lastChar)) {
        trimmedPunct = lastChar + trimmedPunct;
        candidate = candidate.slice(0, -1);
      } else {
        break;
      }
    }

    if (candidate) {
      segments.push({
        kind: 'link',
        value: candidate,
      });
    }

    if (trimmedPunct) {
      segments.push({
        kind: 'text',
        value: trimmedPunct,
      });
    }

    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({
      kind: 'text',
      value: text.slice(lastIndex),
    });
  }

  const merged: TextSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.kind === 'text' && seg.kind === 'text') {
      last.value += seg.value;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}
