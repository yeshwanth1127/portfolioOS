'use client';

import Image from 'next/image';
import Link from 'next/link';

/** Product mark — sidebar header above the org switcher. */
export default function PortfolioLogo({ compact = false }) {
  return (
    <Link href="/" className={`portfolio-logo${compact ? ' portfolio-logo-compact' : ''}`} aria-label="Orbit home">
      <span className="portfolio-logo-mark">
        <Image
          src="/exora-orbit-logo.png"
          alt=""
          width={40}
          height={40}
          priority
          className="portfolio-logo-img"
        />
      </span>
      {!compact ? (
        <span className="portfolio-logo-word">
          <span className="portfolio-logo-product">Orbit</span>
          <span className="portfolio-logo-byline">by Exora</span>
        </span>
      ) : null}
    </Link>
  );
}
