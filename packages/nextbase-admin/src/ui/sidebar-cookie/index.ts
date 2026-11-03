/** Cookie that remembers whether the desktop sidebar is collapsed ("true" / "false"). */
export const SIDEBAR_COLLAPSED_COOKIE = 'sidebar_collapsed';

/** Cookie that remembers whether the desktop panel (an area's menu) is collapsed ("true" / "false"). */
export const SIDEBAR_PANEL_COLLAPSED_COOKIE = 'sidebar_panel_collapsed';

/** The flag the cookie holds, or `fallback` when it holds none. */
export function cookieFlag(name: string, fallback = false): boolean {
  const cookies = document.cookie.split('; ');
  if (cookies.includes(`${name}=true`)) return true;
  if (cookies.includes(`${name}=false`)) return false;
  return fallback;
}
