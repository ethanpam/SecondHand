'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

function subscribeToMotion(onChange: () => void) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

// Animations always play, except for people whose device asks for less motion.
export function useSiteMotion() {
  const reducedMotion = useSyncExternalStore(
    subscribeToMotion,
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => true,
  );
  return { reducedMotion, enabled: !reducedMotion };
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
