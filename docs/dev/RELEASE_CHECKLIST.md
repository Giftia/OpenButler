# Release Checklist

Before marking a release or demo checkpoint complete:

- [ ] Backend unit tests pass.
- [ ] Backend compile check passes.
- [ ] Frontend build passes.
- [ ] API smoke checks pass.
- [ ] `GET /api/butler/mvp-report` returns expected MVP status for the demo checkpoint.
- [ ] `npm run smoke:butler-mvp-report` passes against the local backend.
- [ ] `npm run smoke:butler-browser` passes against the local backend and built frontend.
- [ ] `npm run verify:productization` passes against the local backend.
- [ ] `data/productization/productization-demo-pack.json` passes offline artifact validation.
- [ ] `CHANGELOG.md` and `docs/productization/DEMO_RECORD.md` describe the Productization Harness commands, artifact path, privacy boundaries, and known limits.
- [ ] `npm run test:productization-records` passes.
- [ ] Demo routes load: `/butler`, `/butler/inbox`, `/metrics`, `/timeline`, `/goals`, `/pc-activity-context`.
- [ ] Strict mode behavior reviewed.
- [ ] No external model call is required for core flows.
- [ ] No external webhook is required for core flows.
- [ ] Data migration or schema changes are documented.
- [ ] Privacy docs updated for any new data source or retention behavior.
- [ ] OpenClaw Skill tools updated when API/tool behavior changes.
- [ ] Changelog or README release notes updated.
- [ ] Known limitations documented.
- [ ] MineContext source data remains untouched.
