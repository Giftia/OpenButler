import assert from "node:assert/strict";
import {runDaytimeDispatcher} from "./daytime-cloud-controller.mjs";

const issue = {
  number: 34,
  title: "Supervised no-product-change dispatcher smoke",
  body: "Verify selection only. Do not submit or mutate.",
  labels: [{name: "ready-for-agent"}],
  createdAt: "2026-08-12T00:00:00Z",
  lastEditedAt: null,
};
let mutations = 0;
const services = {
  loadState: () => null,
  preflight: () => true,
  queue: () => ({issues: [issue], closedIssues: new Set(), pullRequests: []}),
  timeline: () => [{event: "labeled", label: {name: "ready-for-agent"}, created_at: "2026-08-12T01:00:00Z"}],
  baseSha: () => "0000000000000000000000000000000000000000",
  recordStatus: () => {},
  claim: () => { mutations += 1; throw new Error("dry-run attempted to claim"); },
  submit: () => { mutations += 1; throw new Error("dry-run attempted to submit"); },
};

const result = await runDaytimeDispatcher({
  mode: "dry-run",
  now: new Date(2026, 7, 12, 10, 0, 0),
  environmentId: "configured-fixture",
  services,
  runId: "supervised-smoke",
});
assert.equal(result.status, "eligible");
assert.equal(result.issue, 34);
assert.equal(mutations, 0);
console.log(JSON.stringify({
  status: "passed",
  eligible_issue: result.issue,
  cloud_submitted: false,
  github_mutated: false,
  product_changed: false,
  personal_data_read: false,
}));
