const activeControllers = new Set<AbortController>();

export function registerFinanceRequest(controller: AbortController): () => void {
  activeControllers.add(controller);
  return () => activeControllers.delete(controller);
}

export function abortFinanceRequests(): void {
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
}
