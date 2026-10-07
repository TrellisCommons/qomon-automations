import { describe } from 'vitest';
import { QomonClient } from './client.js';
import { disposableName, runQomonContractSuite } from './contract-suite.js';

const POLL_MS = 2_000;
const EVENTUALLY_MS = 60_000;
/** Longer than any upsert delay seen in the sandbox. */
const SETTLE_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the same contract suite against a real Qomon sandbox space. Skipped
 * unless QOMON_SANDBOX=1 and QOMON_API_KEY is set.
 *
 *   QOMON_SANDBOX=1 pnpm --filter @trellis/qomon-client test:sandbox
 */
const enabled = process.env.QOMON_SANDBOX === '1';

function resolveKey(): string | null {
  return process.env.QOMON_API_KEY || null;
}

const key = enabled ? resolveKey() : null;

const suite = enabled && key ? describe : describe.skip;

suite('sandbox', { timeout: 120_000 }, () => {
  runQomonContractSuite('qomon sandbox', async () => {
    const api = new QomonClient({
      apiKey: key!,
      baseUrl: process.env.QOMON_API_BASE ?? 'https://incoming.qomon.app',
      rps: 3,
    });
    return {
      api,
      // Qomon shipped real, staff-editable custom fields under `extra_json`,
      // not the named columns discussed nor this tool's originally-planned
      // {v,gpo} envelope (A1 / R1 superseded; 2026-08/09 investigation with
      // Qomon). See transaction-extra-fields.ts.
      metadataSupported: true,
      async makeBundle() {
        const settings = await api.getTransactionSettings();
        const paymentMethod = settings.payment_method_kinds[0] ?? 'VIR';
        const currency = settings.currency ?? 'cad';
        const contact = await api.createContact({
          firstname: 'Contract',
          surname: `Sandbox-${Date.now()}`,
          mail: `contract-${Date.now()}@example.org`,
        });
        const bundle = await api.createTransactionBundle({
          transactions: [
            {
              amount: 12_345,
              currency,
              payment_method_kind: paymentMethod,
              contact_id: contact.id,
              date: new Date().toISOString(),
            },
          ],
        });
        return {
          bundleId: bundle.id,
          transactionId: bundle.transactions[0]!.id,
          contactId: contact.id,
        };
      },
      // Invented, unique data: an upsert can never match a real contact by
      // name or email, and the search tests find only these.
      async makeContact(fields = {}) {
        const { id } = await api.createContact({
          firstname: 'Contract',
          surname: disposableName('Sandbox'),
          mail: `${disposableName('contract')}@example.org`,
          address: {
            housenumber: '123',
            street: 'Example St',
            city: 'Testville',
          },
          ...fields,
        });
        return id;
      },
      async eventually(check) {
        const deadline = Date.now() + EVENTUALLY_MS;
        for (;;) {
          const value = await check();
          if (value !== undefined) return value;
          if (Date.now() > deadline)
            throw new Error('eventually: condition never held');
          await sleep(POLL_MS);
        }
      },
      settle: () => sleep(SETTLE_MS),
    };
  });
});
