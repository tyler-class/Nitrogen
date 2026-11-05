import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

const Ctx = createContext<(text: string) => void>(() => {});

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    const next = { id: Date.now(), text };
    setToast(next);
    timer.current = setTimeout(() => setToast((cur) => (cur?.id === next.id ? null : cur)), 5000);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toast && (
          <div className="toast" onClick={() => setToast(null)}>
            {toast.text}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
