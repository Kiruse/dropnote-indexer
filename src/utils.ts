import type { CosmosEvent } from '@apophis-sdk/core/types.sdk.js';

export function debounce(fn: () => void, timeout: number) {
  let timer: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, timeout);
  };
}

export function getEventAttribute(events: CosmosEvent[], event: string, attribute: string) {
  return events
    .flatMap(e => e.type === event ? e.attributes.filter(a => a.key === attribute) : [])
    .map(a => a.value);
}

export const findSender = (events: CosmosEvent[]): string | undefined => getEventAttribute(events, 'message', 'sender')[0];

export function warn(key: string, msg: string) {
  if (!warned.has(key)) {
    console.warn(msg);
    warned.add(key);
  }
}

var warned = new Set<string>();
