function handleFinanceDateAppStateChange(prevState, nextState, store, now = () => new Date()) {
  if (prevState === nextState) return;
  if (nextState === 'active') {
    store.tick(now());
  }
}

function subscribeFinanceDateAppState(store, appState, now = () => new Date()) {
  let current = appState.currentState;
  const onChange = (next) => {
    const prev = current;
    current = next;
    handleFinanceDateAppStateChange(prev, next, store, now);
  };
  const subscription = appState.addEventListener('change', onChange);
  return () => subscription.remove();
}

module.exports = {
  handleFinanceDateAppStateChange,
  subscribeFinanceDateAppState,
};
