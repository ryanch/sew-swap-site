// Mirrored in apps/api/src/profile/address.ts (codes only). Keep the two lists in step.
export const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['AS', 'American Samoa'], ['GU', 'Guam'], ['MP', 'Northern Mariana Islands'], ['PR', 'Puerto Rico'],
  ['VI', 'U.S. Virgin Islands'], ['AA', 'Armed Forces Americas'], ['AE', 'Armed Forces Europe'],
  ['AP', 'Armed Forces Pacific'],
];

export const CA_PROVINCES: [string, string][] = [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
];

// Groupings and test codes the browser can name but nobody lives in.
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);

/** Every country the browser can name, United States and Canada first (most participants live there). */
export const COUNTRIES: [string, string][] = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const all: [string, string][] = [];
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b;
      const name = NOT_COUNTRIES.has(code) || code === 'US' || code === 'CA' ? undefined : names.of(code);
      if (name) all.push([code, name]);
    }
  }
  all.sort((x, y) => x[1].localeCompare(y[1]));
  return [['US', 'United States'], ['CA', 'Canada'], ...all];
})();

export type Address = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

export const EMPTY_ADDRESS: Address = { name: '', line1: '', line2: '', city: '', region: '', postalCode: '', country: 'US' };
