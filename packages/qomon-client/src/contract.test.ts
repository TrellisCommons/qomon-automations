import { disposableName, runQomonContractSuite } from './contract-suite.js';
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
        transactions: [
          { amount: 25_000, currency: 'cad', contact_id: contact.id },
        ],
      });
      return {
        bundleId: bundle.id,
        transactionId: bundle.transactions[0]!.id,
        contactId: contact.id!,
      };
    },
    async makeContact(fields = {}) {
      const { id } = await api.createContact({
        firstname: 'Contract',
        surname: disposableName('Fake'),
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
      for (let i = 0; i < 10; i += 1) {
        const value = await check();
        if (value !== undefined) return value;
      }
      throw new Error('eventually: condition never held');
    },
    async settle() {
      api.flushUpserts();
    },
  };
});
