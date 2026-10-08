'use client';

import { useEffect, useRef, type PointerEvent } from 'react';
import { useSiteMotion } from '../../lib/site-motion';

const label = 'SecondHand';
const restingSettings = '"wght" 450';

export function VariableWordmark() {
  const container = useRef<HTMLSpanElement>(null);
  const frame = useRef<number | null>(null);
  const { enabled } = useSiteMotion();

  function reset() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    container.current
      ?.querySelectorAll<HTMLElement>('[data-letter]')
      .forEach((letter) => {
        letter.style.fontVariationSettings = restingSettings;
      });
  }

  useEffect(() => {
    if (!enabled) reset();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [enabled]);

  function move(event: PointerEvent<HTMLSpanElement>) {
    if (!enabled || event.pointerType === 'touch') return;
    const { clientX, clientY } = event;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const letters = Array.from(
        container.current?.querySelectorAll<HTMLElement>('[data-letter]') ?? [],
      );
      const distances = letters.map((letter) => {
        const bounds = letter.getBoundingClientRect();
        return Math.hypot(
          clientX - bounds.left - bounds.width / 2,
          clientY - bounds.top - bounds.height / 2,
        );
      });
      letters.forEach((letter, index) => {
        const falloff = Math.max(1 - distances[index] / 240, 0);
        letter.style.fontVariationSettings = `"wght" ${450 + 350 * falloff}`;
      });
      frame.current = null;
    });
  }

  return (
    <span
      ref={container}
      className="variable-wordmark"
      aria-hidden="true"
      onPointerMove={move}
      onPointerLeave={reset}
    >
      {Array.from(label).map((letter, index) => (
        <span
          key={index}
          data-letter
          style={{ fontVariationSettings: restingSettings }}
        >
          {letter}
        </span>
      ))}
    </span>
  );
}
