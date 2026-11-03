import { useEffect, useLayoutEffect, useRef } from 'react';
import { useConfirm } from './ui/modal/index.ts';
import { useNavigationGuard } from './ui/navigation.tsx';

export function useUnsavedChanges(isDirty: () => boolean): void {
  const confirm = useConfirm();
  const dirty = useRef(isDirty);
  useLayoutEffect(() => {
    dirty.current = isDirty;
  });

  useNavigationGuard(
    async () =>
      !dirty.current() ||
      confirm({
        title: 'Discard your changes?',
        subtitle: "They haven't been saved, and will be lost.",
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      }),
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current()) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
}
