const PATHS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  bell: 'M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-3.5-3.5',
  plus: 'M12 5v14M5 12h14',
  in: 'M17 7L7 17M7 8v9h9',
  out: 'M7 17L17 7M8 7h9v9',
  flag: 'M4 22V4M4 4h13l-2 4 2 4H4',
  lock: 'M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zM8 11V7a4 4 0 018 0v4',
  shield: 'M12 3L4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6l-8-3zM9 12l2 2 4-4',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  sliders: 'M4 6h16M4 12h16M4 18h16M16 4v4M8 10v4M18 16v4',
  check: 'M20 6L9 17l-5-5',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a4 4 0 006 0L5 7zm14 0l-3 7a4 4 0 006 0l-3-7z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
} as const;

export type IconName = keyof typeof PATHS;

/** A decorative line icon: the words beside it carry the meaning. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
