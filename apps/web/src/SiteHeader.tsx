import { Link } from 'react-router-dom';
import logo from './assets/logo.svg';

export default function SiteHeader() {
  return (
    <header className="site-header">
      <Link to="/">
        <img src={logo} alt="Sew Swap" width={166} height={116} />
      </Link>
    </header>
  );
}
