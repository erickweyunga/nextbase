import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { ConfirmModal } from './modal';

export interface ConfirmOptions {
  title: ReactNode;
  subtitle?: ReactNode;
  /** The confirming button's label, naming the action, e.g. "Delete". */
  confirmLabel: string;
  /** The declining button's label; Cancel unless the choice reads better otherwise, e.g. "Keep editing". */
  cancelLabel?: string;
  /** For an action that destroys something, such as Delete: the confirm button is red. */
  danger?: boolean;
  /**
   * Runs before the dialog closes, its button spinning meanwhile; for an action whose outcome the dialog waits on.
   * The answer is false if it throws.
   */
  action?: () => unknown;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/** One confirmation dialog for everything under it, opened with useConfirm. UIProvider mounts it. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [running, setRunning] = useState(false);
  const answer = useRef<(confirmed: boolean) => void>(undefined);

  const confirm = useCallback<Confirm>((next) => {
    // A dialog already open is answered no: only the latest question stands.
    answer.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      answer.current = resolve;
    });
  }, []);

  const close = (confirmed: boolean) => {
    answer.current?.(confirmed);
    answer.current = undefined;
    setOptions(null);
  };

  const onConfirm = async () => {
    if (!options?.action) return close(true);
    // This question's own answer, so a dialog opened while the action runs isn't the one answered.
    const resolve = answer.current;
    answer.current = undefined;
    setRunning(true);
    let done = false;
    try {
      await options.action();
      done = true;
    } catch (error) {
      console.error('The confirmed action failed:', error);
    } finally {
      setRunning(false);
      resolve?.(done);
      if (!answer.current) setOptions(null);
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModal
        isOpen={options !== null}
        onClose={() => !running && close(false)}
        title={options?.title}
        subtitle={options?.subtitle}
        confirmLabel={options?.confirmLabel ?? ''}
        cancelLabel={options?.cancelLabel}
        onConfirm={() => void onConfirm()}
        isLoading={running}
        danger={options?.danger}
      />
    </ConfirmContext.Provider>
  );
}

/**
 * Asks before an action, answering whether it was confirmed:
 * `if (await confirm({ title: "Delete this note?", confirmLabel: "Delete" })) remove(note);`
 */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside UIProvider');
  return confirm;
}
