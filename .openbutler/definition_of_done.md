# Definition of Done

A task is complete only when:

1. The requested behavior is implemented.
2. Relevant tests are added or updated.
3. Documentation is updated when behavior, APIs, privacy, or workflows change.
4. Privacy boundaries remain intact.
5. Strict mode behavior is reviewed and passes.
6. User data is not deleted unless the user explicitly asked for that exact deletion.
7. Completed MineContext/godview and PC Activity modules are not rewritten without a concrete bug.
8. API changes include at least one example request or verification command.
9. UI changes include an empty or data-insufficient state.
10. Errors are explainable to the user.
11. The change summary is clear.
12. Known limitations are written down.
13. OpenClaw tools are updated when tool-callable behavior changes.
14. Evidence boundaries are preserved for insights and recent-activity answers.
15. External writes remain drafts unless the user explicitly confirms execution.
16. Productization Harness changes pass `npm run verify:productization` when they affect readiness, demo pack, artifacts, or local acceptance.
