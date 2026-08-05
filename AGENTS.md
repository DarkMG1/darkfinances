# Agent instructions

## Cursor Cloud specific instructions

- Use the root `README.md` and package scripts as the source of truth for Node/npm setup and standard checks. Ops is an interpreted CLI/tooling surface; it has no separate build or long-running development service.
- Exercise backup/restore behavior only with the synthetic fixtures under `ops/test/`. Never run restore commands against personal or production runtime data.
- `restore-dashboard-runtime.sh` is preview-only. Live restore must run through `restore-coordinated.sh`, which holds the coordinated operation gate while writers are stopped and the staged swap runs.
- `npm run check:ops` is the focused ops gate. A `systemd-analyze` failure caused solely by the container lacking a running systemd instance is environmental; do not ignore other shell, unit, or restore-test failures.
