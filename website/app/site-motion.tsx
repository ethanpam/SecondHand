'use client';

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

const MotionContext = createContext({ paused: false, toggle: () => {} });

function subscribeToMotion(onChange: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  return (
    <MotionContext.Provider
      value={{ paused, toggle: () => setPaused((value) => !value) }}
    >
      {children}
    </MotionContext.Provider>
  );
}

export function useSiteMotion() {
  const context = useContext(MotionContext);
  const reducedMotion = useSyncExternalStore(
    subscribeToMotion,
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => true,
  );
  return {
    ...context,
    reducedMotion,
    enabled: !context.paused && !reducedMotion,
  };
}

export function MotionToggle() {
  const { paused, toggle, reducedMotion } = useSiteMotion();
  if (reducedMotion) return null;
  return (
    <button
      type="button"
      className="motion-toggle"
      onClick={toggle}
      aria-label={paused ? 'Play animations' : 'Pause animations'}
      aria-pressed={paused}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={paused ? 'm3 1 8 5-8 5Z' : 'M2 1h3v10H2zm5 0h3v10H7z'} />
      </svg>
      {paused ? 'Motion off' : 'Motion on'}
    </button>
  );
}
