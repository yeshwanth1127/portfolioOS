'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { buildAppNav, getNavGroups } from '../lib/navigation.js';
import { readStoredSession } from '../lib/session.js';
import OrgSwitcher from './org-switcher';
import PortfolioLogo from './portfolio-logo';
import WorkspaceSwitcher from './workspace-switcher';
import NavIcon from './nav-icon';
import NotificationBell from './notification-bell';

export default function AppShell({ children }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [session, setSession] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSession(readStoredSession());
  }, [pathname, tabParam]);

  const role = session?.membership?.role ?? null;
  const navGroups = useMemo(() => getNavGroups(pathname, tabParam, role), [pathname, tabParam, role]);
  const mobileNav = useMemo(() => buildAppNav(pathname, tabParam, role), [pathname, tabParam, role]);

  const [todayLabel, setTodayLabel] = useState('');
  useEffect(() => {
    setTodayLabel(
      new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date()),
    );
  }, []);

  const userName = session?.membership?.full_name?.split(' ')[0] ?? 'Signed in';
  const userInitials = (session?.membership?.full_name ?? 'P')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="app-shell pw-shell">
      <aside
        className={`app-shell-sidebar pw-sidebar${sidebarOpen ? ' is-open' : ''}`}
        aria-label="Main navigation"
      >
        <PortfolioLogo />
        <WorkspaceSwitcher />
        <OrgSwitcher />

        <div className="pw-nav-scroll">
          {navGroups.map((group) => (
            <div key={group.label} className="pw-nav-group">
              <p className="pw-nav-group-label">{group.label}</p>
              <nav className="app-shell-nav pw-nav">
                {group.links.map(({ href, label, isActive, icon }) => (
                  <Link
                    key={href + label}
                    href={href}
                    className={`pw-nav-link${isActive ? ' is-active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <NavIcon name={icon} />
                    <span>{label}</span>
                  </Link>
                ))}
              </nav>
            </div>
          ))}
        </div>

        {session?.token ? (
          <Link href="/?tab=account" className="pw-sidebar-user" onClick={() => setSidebarOpen(false)}>
            <span className="pw-user-avatar" aria-hidden>
              {userInitials}
            </span>
            <span className="pw-user-name">{userName}</span>
          </Link>
        ) : null}
      </aside>

      <button
        type="button"
        className="app-shell-toggle pw-menu-toggle"
        aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((v) => !v)}
      >
        <span /><span /><span />
      </button>

      <div className="app-shell-main pw-main">
        <header className="pw-topbar">
          <div className="sw-schedule" aria-label="Today">
            <Link href="/calendar" className="sw-schedule-day">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="4" y="5" width="16" height="15" rx="3" />
                <path d="M4 10h16M9 3v4M15 3v4" />
              </svg>
              <span className="sw-schedule-label">Today</span>
              <span className="sw-schedule-date">{todayLabel}</span>
            </Link>
            {session?.membership?.workspace_name ? (
              <span className="sw-schedule-ws">{session.membership.workspace_name}</span>
            ) : null}
            <Link href="/?tab=today" className="sw-schedule-cta">
              {role === 'owner' ? "Review today's numbers" : "Enter today's numbers"}
            </Link>
          </div>
          <div className="pw-topbar-end">
            <NotificationBell token={session?.token} />
          </div>
        </header>
        <div className="pw-main-scroll">{children}</div>
      </div>

      <nav className="app-shell-mobile-bar pw-mobile-bar" aria-label="Mobile navigation">
        {mobileNav.slice(0, 5).map(({ href, label, isActive }) => (
          <Link
            key={href}
            href={href}
            className={`pw-mobile-link${isActive ? ' is-active' : ''}`}
          >
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
