'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
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

function subscribeToVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

export function useVisibleMotion<Element extends HTMLElement>() {
  const motion = useSiteMotion();
  const ref = useRef<Element>(null);
  const [visible, setVisible] = useState(false);
  const documentVisible = useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === 'visible',
    () => false,
  );

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.15 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return {
    ...motion,
    ref,
    active: motion.enabled && visible && documentVisible,
  };
}

export function MotionToggle({ label = 'animations' }: { label?: string }) {
  const { paused, toggle, reducedMotion } = useSiteMotion();
  if (reducedMotion) return null;
  return (
    <button
      type="button"
      className="motion-toggle"
      onClick={toggle}
      aria-label={`${paused ? 'Play' : 'Pause'} ${label}`}
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
