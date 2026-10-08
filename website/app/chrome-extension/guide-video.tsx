'use client';

import { useEffect, useRef } from 'react';
import { useSiteMotion } from '../../lib/site-motion';

// A short, silent screen recording. It loops only when the visitor allows
// motion; otherwise it shows its poster and waits for the play control.
export function GuideVideo({
  src,
  poster,
  label,
  width,
  height,
}: {
  src: string;
  poster: string;
  label: string;
  width: number;
  height: number;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const { enabled } = useSiteMotion();

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (enabled) element.play().catch(() => {});
    else element.pause();
  }, [enabled]);

  return (
    <video
      ref={video}
      className="guide-media"
      src={src}
      poster={poster}
      width={width}
      height={height}
      aria-label={label}
      muted
      loop
      playsInline
      controls
      preload="metadata"
    />
  );
}
