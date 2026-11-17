import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

/** A button on the toast, such as Undo. */
export interface ToastAction {
  label: string;
  run(): void;
}

type Show = (text: string, action?: ToastAction) => void;
const Ctx = createContext<Show>(() => {});

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; text: string; action?: ToastAction } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback<Show>((text, action) => {
    clearTimeout(timer.current);
    const next = { id: Date.now(), text, action };
    setToast(next);
    // A toast with a button stays a little longer, so there's time to press it.
    timer.current = setTimeout(
      () => setToast((cur) => (cur?.id === next.id ? null : cur)),
      action ? 8000 : 5000,
    );
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toast && (
          <div className="toast" onClick={() => setToast(null)}>
            <span>{toast.text}</span>
            {toast.action && (
              <button
                type="button"
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation();
                  setToast(null);
                  toast.action!.run();
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
