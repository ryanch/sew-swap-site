// Mirrored in apps/web/src/swaps/address.ts. Keep the two lists in step.
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'AS', 'GU', 'MP', 'PR', 'VI', 'AA', 'AE', 'AP',
];
export const CA_PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

export type Address = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

const LIMITS: Record<keyof Address, number> = {
  name: 200,
  line1: 200,
  line2: 200,
  city: 100,
  region: 100,
  postalCode: 20,
  country: 2,
};

/** Checks and tidies an address from the request body. Returns a message for the person on failure. */
export function validateAddress(raw: unknown): { address: Address } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Please fill in your mailing address.' };
  const input = raw as Record<string, unknown>;
  const a = {} as Address;
  for (const key of Object.keys(LIMITS) as (keyof Address)[]) {
    const value = input[key] ?? '';
    if (typeof value !== 'string') return { error: 'Please fill in your mailing address.' };
    a[key] = value.trim().replace(/\s+/g, ' ');
    if (a[key].length > LIMITS[key]) return { error: 'Part of your address is too long.' };
  }
  a.country = a.country.toUpperCase();
  if (!a.name) return { error: 'Please enter the name to mail your package to.' };
  if (!a.line1) return { error: 'Please enter your street address.' };
  if (!a.city) return { error: 'Please enter your city.' };
  if (!/^[A-Z]{2}$/.test(a.country)) return { error: 'Please choose your country.' };

  if (a.country === 'US') {
    a.region = a.region.toUpperCase();
    if (!US_STATES.includes(a.region)) return { error: 'Please choose your state.' };
    if (!/^\d{5}(-\d{4})?$/.test(a.postalCode)) {
      return { error: 'Please enter a 5-digit ZIP code, like 12345.' };
    }
  } else if (a.country === 'CA') {
    a.region = a.region.toUpperCase();
    if (!CA_PROVINCES.includes(a.region)) return { error: 'Please choose your province or territory.' };
    const postal = a.postalCode.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(postal)) {
      return { error: 'Please enter your postal code, like K1A 0B1.' };
    }
    a.postalCode = `${postal.slice(0, 3)} ${postal.slice(3)}`;
  } else if (!a.postalCode && !a.region) {
    return { error: 'Please enter your postal code, or your region if you have no postal code.' };
  }
  return { address: a };
}
