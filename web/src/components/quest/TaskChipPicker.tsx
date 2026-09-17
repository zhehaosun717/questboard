import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ChipSuggestion {
  id: string;
  title?: string;
}

export interface TaskChipPickerProps {
  ariaLabel: string;
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: ChipSuggestion[];
  placeholder: string;
  disabled?: boolean;
  // How a chip (selected or suggested) is shown. Defaults to "id" or "id · title".
  formatChip?: (id: string) => string;
  idPrefix: string;
}

const MAX_SUGGESTIONS = 8;

// Exported so a test can prove the removal-focus decision without mounting React (no DOM library is
// installed here — see MetadataSection.test.tsx's own note). `removedIndex` is the position the just-removed
// chip used to occupy; `remainingCount` is how many chips are left after it. Mirrors the common
// accessible-listbox rule: focus the item that slid into the removed slot, or the previous one if the last
// chip was removed, or `null` (the caller's cue to focus the input instead) once there is nothing left.
export function focusIndexAfterRemoval(removedIndex: number, remainingCount: number): number | null {
  if (remainingCount === 0) return null;
  return Math.min(removedIndex, remainingCount - 1);
}

// Performs that decision against real (or, in a test, fake) focusable handles — never leaving the browser to
// drop focus to `<body>` because the button the owner just clicked no longer exists.
export function focusAfterRemoval(
  removedIndex: number,
  remainingChipButtons: Array<{ focus: () => void } | null | undefined>,
  input: { focus: () => void } | null | undefined,
) {
  const target = focusIndexAfterRemoval(removedIndex, remainingChipButtons.length);
  if (target === null) input?.focus();
  else remainingChipButtons[target]?.focus();
}

export type RemovalSource = 'button' | 'keyboard';

// F-1: only a ✕-button removal should move focus (to the chip that slid into the removed slot, or the
// input once nothing is left). A removal started from the keyboard (Backspace in the empty combobox) must
// leave focus exactly where it was — the input never left the DOM, so touching it at all just interrupts
// the next keystroke. Exported so a test can prove the decision without mounting React.
export function focusMoveIndexForRemoval(source: RemovalSource, index: number): number | null {
  return source === 'button' ? index : null;
}

function defaultFormat(suggestions: ChipSuggestion[]) {
  const byId = new Map(suggestions.map((s) => [s.id, s.title]));
  return (id: string) => {
    const title = byId.get(id);
    return title ? `${id} · ${title}` : id;
  };
}

/**
 * A searchable, keyboard-operable add/remove list of ids — never a bare comma-separated text field. Typing
 * filters `suggestions` by id/title; Enter adds the highlighted suggestion, or (with no match highlighted)
 * the raw typed text as-is, so an id the drawer has not loaded (or a deliberately invalid one, for the
 * owner to see the server's own refusal) can still be entered. Backspace on an empty input removes the last
 * chip. Every chip has a real, focusable remove button.
 */
export function TaskChipPicker({
  ariaLabel,
  values,
  onChange,
  suggestions,
  placeholder,
  disabled = false,
  formatChip,
  idPrefix,
}: TaskChipPickerProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const reactId = useId();
  const listId = `${idPrefix}-${reactId}-list`;
  const format = formatChip ?? defaultFormat(suggestions);
  const chipButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set right before the onChange that removes a chip; consumed once, after the resulting re-render commits
  // the new (shorter) `values`, so the ref array below already reflects the post-removal chip positions.
  const pendingRemovalRef = useRef<number | null>(null);

  useEffect(() => {
    const removedIndex = pendingRemovalRef.current;
    if (removedIndex === null) return;
    pendingRemovalRef.current = null;
    focusAfterRemoval(removedIndex, chipButtonRefs.current.slice(0, values.length), inputRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const selected = new Set(values);
    return suggestions
      .filter((s) => !selected.has(s.id) && (s.id.toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q)))
      .slice(0, MAX_SUGGESTIONS);
  }, [query, suggestions, values]);

  const add = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setQuery('');
    setHighlight(0);
  };

  const removeAt = (index: number, source: RemovalSource) => {
    pendingRemovalRef.current = focusMoveIndexForRemoval(source, index);
    onChange(values.filter((_, i) => i !== index));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches.length && matches[highlight]) add(matches[highlight].id);
      else if (query.trim()) add(query);
    } else if (e.key === 'Escape' && matches.length) {
      // Suggestions are open: close them only, the same way CardNode.tsx stops Escape from bubbling past its
      // own panel. With no suggestions open this falls through and Escape keeps the existing drawer
      // behaviour (bubbles up and closes the drawer).
      e.stopPropagation();
      setQuery('');
      setHighlight(0);
    } else if (e.key === 'Backspace' && !query && values.length) {
      removeAt(values.length - 1, 'keyboard');
    }
  };

  return (
    <div className="meta-picker" aria-disabled={disabled}>
      {values.length > 0 ? (
        <ul className="meta-chips" aria-label={ariaLabel}>
          {values.map((id, index) => (
            <li key={`${id}-${index}`} className="meta-chip">
              <span>{format(id)}</span>
              {!disabled ? (
                <button
                  type="button"
                  className="meta-chip-remove"
                  aria-label={`移除 ${format(id)}`}
                  ref={(el) => { chipButtonRefs.current[index] = el; }}
                  onClick={() => removeAt(index, 'button')}
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!disabled ? (
        <div className="meta-picker-input">
          <input
            type="text"
            id={`${idPrefix}-${reactId}-input`}
            ref={inputRef}
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={ariaLabel}
            placeholder={placeholder}
            value={query}
            disabled={disabled}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="btn meta-picker-add" disabled={!query.trim()} onClick={() => add(query)}>
            加入
          </button>
        </div>
      ) : null}
      {matches.length > 0 ? (
        <ul className="meta-suggest" id={listId} role="listbox">
          {matches.map((s, index) => (
            <li key={s.id} role="option" aria-selected={index === highlight}>
              <button type="button" className={index === highlight ? 'active' : ''} onClick={() => add(s.id)}>
                {format(s.id)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
