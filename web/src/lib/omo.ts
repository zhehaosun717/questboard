import type { OmoChange, OmoEntry, OmoSection } from '../api/types';

export interface OmoTableData {
  agents?: OmoEntry[];
  categories?: OmoEntry[];
}

// What each OMO role is for, so the table says more than a name. The first four are primary agents (they
// drive a task); the rest are consultants or helpers. Categories (quick, writing) are not agents but share
// this table. Names are matched lowercased, because the config file spells them either way.
export const OMO_ROLE_HINTS: Record<string, string> = {
  sisyphus: '主控编排（primary）',
  hephaestus: '深工执行（primary）',
  prometheus: '计划构建（primary）',
  atlas: '计划执行（primary）',
  oracle: '架构/调试顾问',
  momus: '计划审查',
  metis: '需求分析顾问',
  librarian: '外部文档/代码搜索',
  explore: '代码库快速检索',
  'multimodal-looker': '图片/PDF 多模态分析',
  'sisyphus-junior': '委派执行单元',
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
  return OMO_ROLE_HINTS[name.toLowerCase()] ?? null;
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
