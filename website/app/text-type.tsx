'use client';

import { useEffect, useState } from 'react';
import { useVisibleMotion } from './site-motion';

type TextTypeProps = {
  text: string;
  typingSpeed?: number;
  deletingSpeed?: number;
  pauseDuration?: number;
  initialDelay?: number;
};

export function TextType({
  text,
  typingSpeed = 80,
  deletingSpeed = 40,
  pauseDuration = 2400,
  initialDelay = 450,
}: TextTypeProps) {
  const { ref, active, enabled } = useVisibleMotion<HTMLSpanElement>();
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!active) return;
    const delay = isDeleting
      ? deletingSpeed
      : currentCharIndex === text.length
        ? pauseDuration
        : currentCharIndex === 0
          ? initialDelay
          : typingSpeed;
    const timeout = setTimeout(() => {
      if (isDeleting) {
        setCurrentCharIndex((index) => Math.max(0, index - 1));
        if (currentCharIndex <= 1) setIsDeleting(false);
      } else if (currentCharIndex < text.length) {
        setCurrentCharIndex((index) => index + 1);
      } else {
        setIsDeleting(true);
      }
    }, delay);
    return () => clearTimeout(timeout);
  }, [
    active,
    currentCharIndex,
    isDeleting,
    text,
    typingSpeed,
    deletingSpeed,
    pauseDuration,
    initialDelay,
  ]);

  return (
    <span
      ref={ref}
      className="text-type"
      data-running={active}
      data-motion={enabled}
      data-deleting={isDeleting}
    >
      <span className="screen-reader-only">{text.replaceAll('\n', ' ')}</span>
      <span className="text-type__reserve" aria-hidden="true">
        {text}
      </span>
      <span className="text-type__visible" aria-hidden="true">
        <span className="text-type__content">
          {enabled ? text.slice(0, currentCharIndex) : text}
        </span>
        <span className="text-type__cursor">|</span>
      </span>
    </span>
  );
}
