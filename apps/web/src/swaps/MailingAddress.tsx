import { COUNTRIES, type Address } from './address';

/** An address laid out the way it goes on a package. */
export function MailingAddress({ address }: { address: Address }) {
  const country = COUNTRIES.find(([code]) => code === address.country)?.[1];
  return (
    <address className="mailing">
      {address.name}
      <br />
      {address.line1}
      {address.line2 && (
        <>
          <br />
          {address.line2}
        </>
      )}
      <br />
      {[address.city, address.region, address.postalCode].filter(Boolean).join(' ')}
      <br />
      {country ?? address.country}
    </address>
  );
}
