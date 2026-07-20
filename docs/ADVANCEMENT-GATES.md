# Advancement gates

Ambitious features remain disabled until their trust prerequisites are measured. This is deliberate:
an uncalibrated finance feature is worse than a clearly unavailable one.

## Receipt-first inbox

Gate: at least 30 reviewed receipts with duplicate detection, extraction state, and explicit
match/mismatch outcomes. Current status: duplicate hashing and review state exist; transaction
matching accuracy is not yet measured. Do not auto-link or auto-edit Actual.

## Deterministic daily briefing and Shortcuts

Gate: the Today contract must remain complete and internally revision-consistent for 30 consecutive
days, with review fingerprints stable across syncs. Current status: Today and persistent review are
implemented; the observation window has not elapsed. Any future briefing must summarize deterministic
fields only and deep-link to source tasks.

## Integrated scenario planner

Gate: rolling-origin recurrence and daily-balance backtests must publish date error, amount error,
false recurrence rate, and missed minimum-balance events. Current status: events expose
known/planned/inferred provenance, but calibrated backtests do not exist. The current screen remains
an illustrative plan, not a prediction.

## Full-build widget

Gate: a paid Apple Developer entitlement path and demonstrated use of Today/Review on device. Current
status: unavailable for the supported free-sideload build. The reduced binary removes widget and App
Group capabilities and uses a separate OTA runtime/channel.
