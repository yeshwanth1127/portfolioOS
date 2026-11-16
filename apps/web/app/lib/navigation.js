/** Sidebar nav — grouped like Paperwhale (section labels + links). */

function tabActive(pathname, tabParam, tabId) {
  const tab = pathname === '/' ? tabParam || 'overview' : null;
  return pathname === '/' && tab === tabId;
}

export function getNavGroups(pathname, tabParam, role) {
  const isOwner = role === 'owner';
  const overviewActive = pathname === '/' && (!tabParam || tabParam === 'overview');

  const groups = [
    {
      label: 'Portfolio',
      links: [
        { href: '/', label: 'Overview', isActive: overviewActive, icon: 'grid' },
        { href: '/calendar', label: 'Calendar', isActive: pathname.startsWith('/calendar'), icon: 'calendar' },
        { href: '/reports', label: 'Reports', isActive: pathname.startsWith('/reports'), icon: 'chart' },
      ],
    },
    {
      label: 'Delivery',
      links: [
        { href: '/my-work', label: 'My Work', isActive: pathname.startsWith('/my-work'), icon: 'check' },
        { href: '/timesheet', label: 'Timesheet', isActive: pathname.startsWith('/timesheet'), icon: 'clock' },
        { href: '/projects', label: 'Projects', isActive: pathname.startsWith('/projects'), icon: 'folder' },
      ],
    },
    {
      label: 'Performance',
      links: [
        {
          href: '/?tab=today',
          label: isOwner ? 'Set goals' : 'Today',
          isActive: tabActive(pathname, tabParam, 'today'),
          icon: 'target',
        },
        {
          href: '/?tab=kpis',
          label: 'KPIs',
          isActive: tabActive(pathname, tabParam, 'kpis'),
          icon: 'metric',
        },
      ],
    },
    {
      label: 'Workspace',
      links: [
        { href: '/people', label: 'People', isActive: pathname.startsWith('/people'), icon: 'users' },
        { href: '/meetings', label: 'Meetings', isActive: pathname.startsWith('/meetings'), icon: 'video' },
        {
          href: '/?tab=team',
          label: 'Team',
          isActive: tabActive(pathname, tabParam, 'team'),
          icon: 'team',
        },
        ...(isOwner
          ? [
              {
                href: '/?tab=agent',
                label: 'Agent',
                isActive: tabActive(pathname, tabParam, 'agent'),
                icon: 'spark',
              },
              {
                href: '/?tab=settings',
                label: 'Settings',
                isActive: tabActive(pathname, tabParam, 'settings'),
                icon: 'settings',
              },
            ]
          : []),
        {
          href: '/?tab=account',
          label: 'Account',
          isActive: tabActive(pathname, tabParam, 'account'),
          icon: 'user',
        },
      ],
    },
  ];

  return groups;
}

/** Flat list (mobile bar, tests). */
export function buildAppNav(pathname, tabParam, role) {
  return getNavGroups(pathname, tabParam, role).flatMap((g) => g.links);
}
