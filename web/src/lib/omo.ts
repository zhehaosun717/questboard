import type { OmoChange, OmoEntry, OmoSection } from '../api/types';

export interface OmoTableData {
  agents?: OmoEntry[];
  categories?: OmoEntry[];
}

export const OMO_ROLE_HINTS: Record<string, string> = {
  sisyphus: '主控编排',
  oracle: '架构/调试顾问',
  librarian: '查外部文档',
  explore: '快速检索代码',
  quick: '快速小任务',
  writing: '文档写作',
};

export const OMO_REASONING_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'max', label: 'max' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'high', label: 'high' },
  { value: 'medium', label: 'medium' },
  { value: 'low', label: 'low' },
  { value: 'minimal', label: 'minimal' },
  { value: 'off', label: 'off' },
  { value: 'auto', label: 'auto' },
];

export function getRoleHint(name: string): string | null {
  return OMO_ROLE_HINTS[name] ?? null;
}

export function changedOmoRows(
  original: OmoTableData,
  edited: OmoTableData,
): OmoChange[] {
  const changes: OmoChange[] = [];

  const compareSection = (section: OmoSection) => {
    const origList = original[section] ?? [];
    const editList = edited[section] ?? [];

    const origMap = new Map<string, OmoEntry>();
    for (const item of origList) {
      origMap.set(item.name, item);
    }

    for (const item of editList) {
      const orig = origMap.get(item.name);
      const model = item.model ?? '';
      const reasoning = item.reasoning ?? '';
      const origModel = orig?.model ?? '';
      const origReasoning = orig?.reasoning ?? '';

      if (!orig || model !== origModel || reasoning !== origReasoning) {
        changes.push({
          section,
          name: item.name,
          model,
          reasoning,
        });
      }
    }
  };

  compareSection('agents');
  compareSection('categories');

  return changes;
}
