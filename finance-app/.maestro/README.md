# Finance App Maestro Flows

This directory contains end-to-end user flows for the installed Finance App. The suites run against
Finance Dashboard's isolated demo data and cover:

- Onboarding, tab navigation, Home, Activity, and Settings.
- Planning, analytics, recurring items, bills, subscriptions, and goals.
- Review, reconciliation, reimbursements, categorization rules, events, and transaction creation.
- Spending, merchant/tag drilldowns, transaction details, splits, and transaction actions.
- Face ID/privacy-gate behavior.

Run every flow from `finance-app`:

```bash
npm run test:e2e:ios
```

Targeted suite commands are defined in `package.json`, including `test:e2e:ios:core`,
`test:e2e:ios:planning`, `test:e2e:ios:workflows`, `test:e2e:ios:spending`,
`test:e2e:ios:transaction`, and `test:e2e:ios:privacy`.

See [`../MAESTRO.md`](../MAESTRO.md) for installation, simulator setup, expected backend mode, suite
grouping, screenshots, and troubleshooting.

When adding a flow:

1. Prefer stable `testID` selectors for navigation and major controls.
2. Use visible-text assertions for user-facing outcomes.
3. Keep tests deterministic against demo fixtures.
4. Do not add real server URLs, API tokens, names, account labels, or transaction data.
5. Add the flow to the appropriate package script and document any new fixture dependency.
