# @trellis/qomon-client

Typed HTTP client for the Qomon REST API: self-throttle, backoff, a `QomonError` hierarchy, Zod-validated envelopes, the `GuardedContactWriter`, and the `InMemoryQomon` fake. A contract suite runs the same tests against the fake (in CI) and against a sandbox space (on demand).

## Origin

Copied from [`gpo/gpo-monolith`](https://github.com/gpo/gpo-monolith) `packages/qomon-client` at commit `44e5c36` (`main` on 2026-10-07). The Green Party of Ontario approved relicensing it under AGPL-3.0 for this repo on 2026-10-07.

This copy is a fork: changes are not synced back to the monolith. Differences from the original:

- The package is `@trellis/qomon-client` and has no dependency on `@gpo/tax-receipts-core`. `transaction-extra-fields.ts` inlines the one type it used.
- `sandbox.test.ts` reads the key from `QOMON_API_KEY` only.
- Added `searchContacts`, `listFormsByType`, `upsertContact`, and contact search pagination, with fake and contract-suite coverage.

Comments that cite tax-receipts documents (`data-model`, `qomon-api-reference`, `PRD`, `open-questions.md`) refer to the monolith's private knowledge base. They are kept as written to make the fork easy to compare.

## Tests

```bash
pnpm --filter @trellis/qomon-client test           # against the in-memory fake
QOMON_SANDBOX=1 pnpm --filter @trellis/qomon-client test:sandbox
```

The sandbox run needs `QOMON_API_KEY` for a **sandbox** space. It creates disposable contacts and transaction bundles with invented data, and never modifies a contact it did not create. Never point it at a campaign's production space.
