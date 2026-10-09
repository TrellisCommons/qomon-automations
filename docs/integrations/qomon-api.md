---
last-reviewed: 2026-10-09
review-interval-days: 30
---

# Qomon API notes

Behaviour this repo relies on, observed against a sandbox space. Each fact is dated with when it was last seen true; the contract suite in `packages/qomon-client` (`QOMON_SANDBOX=1`) re-checks most of them. Qomon's OpenAPI specs were shared in confidence and are not in this repo; nothing here comes from them that was not also observed.

## Presence

As of 2026-10-07 (sandbox spike, [issue #1](https://github.com/TrellisCommons/qomon-automations/issues/1#issuecomment-6032002796)):

- Presence is one form of type `radio`, listed by `GET /v1/forms/type/presence_status`, whose `data` is `{ forms: [...] }`. The sandbox's stored values are `present`, `absent`, `refus` (label `refusal`), and `repasse`; another space's may differ.
- A contact has at most one Presence answer. A new write replaces it; nothing keeps the old one.
- Write it with `POST /contacts/upsert`, `{ kind: 'contact', data: { id, name_presences: [{ id: <form id>, value }] } }`. `presence_status` as the field name is accepted (202) and dropped. Upsert accepts a refvalue's label as well as its value.
- An upsert with only `id` and Presence leaves every other field alone. `UpdatedAt` changes; `lastchange` does not.
- The answer's `date` is when Qomon applied the write. A requested `date` or `donedate` is ignored.
- An API-written answer has no author or channel, and no interaction is created.
- A value not on the form cannot be added through the API; it is added in the space's Presence settings.

## Upsert

- Asynchronous: 202, then visible in about 2 seconds.
- A record naming an unknown form, value, or field is dropped whole, valid fields included, with no error.
- An upsert by an `id` that does not exist was dropped, not turned into a new contact.
- Without an `id`, Qomon matches on email and name, or name and address, and may update a different contact. The client refuses an upsert without an id.

## Search

- `POST /search` queries are exactly two levels deep (root operator, then nodes of conditions); a condition directly under the root gets a 422. `{ $all: [] }` matches every contact.
- No `total`: page until a page is shorter than `per_page` (at most 1000).
- Each contact carries its form answers (`formdatas`, with value and date) inline when it has any.
- `eql` is a case-insensitive token or prefix match, not equality (`address.city eql "Test"` matches "Testville").
- `form ext` ignores `form_ref_ids`.
- About 1 second per 1,000-contact page.

## Rate limits

Undocumented, but every response carries them (as of 2026-10-07): `x-ratelimit-limit: burst:100;rate:10.0`, `x-ratelimit-cost: 1` per request (a 1,000-contact search page included), and `x-ratelimit-remaining`. Draining the burst returns 429. The client paces itself at 5 requests per second.

## Open

- Whether Presence recorded in phone or event campaigns lands in the same form as door knocks. Not visible from the API.
- Whether the list builder's "Presence does exist" matches `form ext` on the Presence form.
