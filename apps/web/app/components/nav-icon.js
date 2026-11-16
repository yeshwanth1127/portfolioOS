/** Minimal line icons for sidebar (Paperwhale-style). */

const PATHS = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  calendar: 'M7 3v2M17 3v2M4 8h16M6 5h12v15H6z',
  chart: 'M4 19V9M9 19V6M14 19v-7M19 19V4',
  check: 'M5 12l4 4L20 6',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  folder: 'M4 7h6l2 2h8v11H4z',
  target: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  metric: 'M4 19h16M6 16V8M12 16V5M18 16v-6',
  layers: 'M12 3 4 8l8 5 8-5-8-5zM4 13l8 5 8-5',
  users: 'M17 19v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  team: 'M12 4a2 2 0 1 0 0 4M4 20v-1a4 4 0 0 1 4-4h1M20 20v-1a4 4 0 0 0-4-4',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2',
  video: 'M4 7h11v10H4zM15 10.5l5-3v9l-5-3',
  user: 'M20 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M12 11a4 4 0 0 1 0-8 4 4 0 0 1 0 8z',
};

export default function NavIcon({ name, className = '' }) {
  const d = PATHS[name] ?? PATHS.grid;
  return (
    <svg
      className={`pw-nav-icon ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
