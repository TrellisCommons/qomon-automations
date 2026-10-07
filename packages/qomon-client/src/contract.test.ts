import { runQomonContractSuite } from './contract-suite.js';
import { InMemoryQomon } from './fake.js';

runQomonContractSuite('in-memory fake', async () => {
  const api = new InMemoryQomon();
  return {
    api,
    metadataSupported: true,
    async makeBundle() {
      const contact = api.seedContact({
        firstname: 'Dana',
        surname: 'Donor',
        mail: 'dana@example.org',
      });
      const bundle = api.seedBundle({
        transactions: [{ amount: 25_000, currency: 'cad', contact_id: contact.id }],
      });
      return {
        bundleId: bundle.id,
        transactionId: bundle.transactions[0]!.id,
        contactId: contact.id!,
      };
    },
  };
});
