import type { Card } from '../api/types';

export interface ProviderGroup {
  provider: string;
  cards: Card[];
  lanes: string[];
  available: number;
}

export const NO_PROVIDER = '未填服务商';

/**
 * The roster split by provider, so 28 cards read as a handful of sections. Groups and the cards inside them
 * keep the roster's own order (the order the owner added them), which is also how the guild sidebar lists them.
 */
export function groupByProvider(cards: readonly Card[]): ProviderGroup[] {
  const order: string[] = [];
  const byProvider = new Map<string, Card[]>();
  for (const card of cards) {
    const provider = card.provider.trim() || NO_PROVIDER;
    const members = byProvider.get(provider);
    if (members) {
      members.push(card);
    } else {
      byProvider.set(provider, [card]);
      order.push(provider);
    }
  }
  return order.map((provider) => {
    const members = byProvider.get(provider) ?? [];
    return {
      provider,
      cards: members,
      lanes: [...new Set(members.map((card) => card.lane))],
      available: members.filter((card) => card.status === 'available').length,
    };
  });
}
