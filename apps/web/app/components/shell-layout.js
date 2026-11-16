'use client';

import { usePathname } from 'next/navigation';
import AppShell from './app-shell';

const SHELL_ROUTES = [
  '/calendar',
  '/my-work',
  '/timesheet',
  '/projects',
  '/reports',
  '/people',
  '/meetings',
];

function usesAppShell(pathname) {
  if (pathname === '/' || pathname.startsWith('/invite') || pathname.startsWith('/onboarding')) {
    return false;
  }
  return SHELL_ROUTES.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/** Wraps route children with the app shell (not `/` — home wraps when logged in). */
export default function ShellLayout({ children }) {
  const pathname = usePathname();

  if (usesAppShell(pathname)) {
    return <AppShell>{children}</AppShell>;
  }

  return children;
}
