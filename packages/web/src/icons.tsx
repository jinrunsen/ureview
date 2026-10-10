import type { ReactNode } from "react";

const paths = {
  home: <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />,
  reviews: <><path d="M9 5h11M9 12h11M9 19h11" /><path d="m3 5 1 1 2-2m-3 8 1 1 2-2m-3 8 1 1 2-2" /></>,
  overview: <><path d="M3 3v18h18" /><path d="M7 16v-5m5 5V6m5 10V9" /></>,
  repository: <><path d="M4 4h14a2 2 0 0 1 2 2v15H6a2 2 0 0 1-2-2Zm0 13h16M8 4v9" /><path d="m12 8 2 2-2 2" /></>,
  rules: <><path d="M5 3h14v18H5Z" /><path d="M9 7h6M9 11h6m-6 4 2 2 4-4" /></>,
  users: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2" /></>,
  settings: <><path d="m10 3-1 3-3 1-3 3v4l3 3 3 1 1 3h4l1-3 3-1 3-3v-4l-3-3-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
  "arrow-up-right": <path d="M6 18 18 6M6 6h12v12" />,
  "chevron-right": <path d="m9 5 7 7-7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v4m0 4h.01" /></>,
  filter: <path d="M4 6h16M7 12h10m-7 6h4" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M19 12a7 7 0 0 0-12-6L4 9m1 3a7 7 0 0 0 12 6l3-3" /></>,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10m0-3h5a7 7 0 0 0 7-6" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  file: <path d="M5 3h9l5 5v13H5Zm9 0v6h5M9 13h6m-6 4h6" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 8-3 8-3 10h18c0-2-3-2-3-10M10 21h4" /></>,
  session: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  collapse: <path d="M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5" />,
  logout: <path d="M9 4H4v16h5m6-13 5 5-5 5m-7-5h12" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
