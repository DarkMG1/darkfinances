## DarkFinances Maestro Conventions

- Start flows from demo mode unless the test is specifically checking onboarding.
- Prefer `testID` selectors for tabs, rows, buttons, chips, sheets, and screen roots.
- Prefer `openLink: darkfinances:///route` for stack screens and tab roots instead of coordinate taps.
- Keep flows feature-scoped; the full suite should be many small flows rather than one giant scenario.
- Use sanitized demo records only. Tests must never depend on the owner's real finance data.
