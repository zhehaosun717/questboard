export function usageColorClass(
  percent: number | null | undefined,
): 'green' | 'amber' | 'red' | 'unknown' {
  if (percent === null || percent === undefined || Number.isNaN(percent)) {
    return 'unknown';
  }
  if (percent < 70) {
    return 'green';
  }
  if (percent <= 90) {
    return 'amber';
  }
  return 'red';
}

export function formatBalance(amount: number, currency: string): string {
  const formatted = amount.toFixed(2);
  const cur = currency.toUpperCase();
  if (cur === 'CNY') {
    return `¥${formatted}`;
  }
  if (cur === 'USD') {
    return `$${formatted}`;
  }
  return `${formatted} ${currency}`;
}

export const formatCurrency = formatBalance;

export function formatUsageDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${m}-${d} ${h}:${min}`;
}

export const formatResetTime = formatUsageDate;

export const USAGE_SOURCE_LABEL: Record<string, string> = {
  'local-log': '本机记录',
  api: '接口',
  cli: '命令行',
  'local-app': '本机应用',
};

export function formatSourceLabel(source: string): string {
  return USAGE_SOURCE_LABEL[source] ?? source;
}
