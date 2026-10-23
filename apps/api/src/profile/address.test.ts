import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAddress } from './address';

const base = { line1: '1 Main St', line2: '', city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' };

test('needs a first and a last name, and builds the full name', () => {
  assert.deepEqual(validateAddress({ ...base, firstName: ' Pat ', lastName: '' }), { error: 'Please enter your last name.' });
  assert.deepEqual(validateAddress({ ...base, firstName: '', lastName: 'Maker' }), { error: 'Please enter your first name.' });
  const ok = validateAddress({ ...base, firstName: ' Pat ', lastName: 'Maker' });
  assert.ok('address' in ok);
  assert.equal(ok.address.name, 'Pat Maker');
});
