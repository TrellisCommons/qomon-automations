import { describe } from 'vitest';
import { QomonClient } from './client.js';
import { runQomonContractSuite } from './contract-suite.js';

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

suite('sandbox', { timeout: 30_000 }, () => {
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
    };
  });
});
