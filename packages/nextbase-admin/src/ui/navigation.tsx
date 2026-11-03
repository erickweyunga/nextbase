import {
  type AnchorHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function pathname(): string {
  const path = window.location.hash.slice(1).split('?')[0] ?? '';
  return path.startsWith('/') ? path : '/';
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, pathname);
}

type Guard = () => Promise<boolean>;

const guards = new Set<{ current: Guard }>();

let shown = window.location.hash;

let passing = false;

export function canLeave(): Promise<boolean> {
  const guard = [...guards].at(-1);
  return guard ? guard.current() : Promise.resolve(true);
}

function go(path: string, replace: boolean): void {
  const url = `#${path}`;
  passing = url !== window.location.hash;
  if (replace) window.location.replace(url);
  else window.location.hash = path;
}

window.addEventListener('hashchange', () => {
  const target = window.location.hash;
  if (passing || guards.size === 0) {
    passing = false;
    shown = target;
    return;
  }
  window.history.replaceState(window.history.state, '', shown || '#/');
  void canLeave().then((leave) => {
    if (leave) go(target.slice(1), false);
  });
});

export function navigate(path: string, { replace = false } = {}): void {
  void canLeave().then((leave) => {
    if (leave) go(path, replace);
  });
}

export function useNavigationGuard(guard: Guard): void {
  const latest = useRef(guard);
  useLayoutEffect(() => {
    latest.current = guard;
  });
  useEffect(() => {
    const entry = latest;
    guards.add(entry);
    return () => {
      guards.delete(entry);
    };
  }, []);
}

function toHref(href: string): string {
  return href.startsWith('/') ? `#${href}` : href;
}

export type LinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
> & {
  href: string;
};

export function Link({ href, ...props }: LinkProps) {
  return <a {...props} href={toHref(href)} />;
}
