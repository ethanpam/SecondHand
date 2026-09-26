'use client';

import type { GrainGradient } from '@paper-design/shaders-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const colors = [
  'hsl(193, 85%, 66%)',
  'hsl(196, 100%, 83%)',
  'hsl(195, 100%, 50%)',
];
const motionQuery = '(prefers-reduced-motion: reduce)';

function subscribeToMotion(onChange: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function GradientBackground() {
  const reducedMotion = useSyncExternalStore(
    subscribeToMotion,
    () => window.matchMedia(motionQuery).matches,
    () => true,
  );
  const [Shader, setShader] = useState<typeof GrainGradient | null>(null);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const background = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const element = background.current;
    const handleContextLoss = () => setFailed(true);
    element?.addEventListener('webglcontextlost', handleContextLoss, true);

    async function loadShader() {
      try {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2');
        if (!context) return;
        context.getExtension('WEBGL_lose_context')?.loseContext();
        const { GrainGradient: Component } =
          await import('@paper-design/shaders-react');
        if (!cancelled) setShader(() => Component);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }

    void loadShader();
    return () => {
      cancelled = true;
      element?.removeEventListener('webglcontextlost', handleContextLoss, true);
    };
  }, []);

  return (
    <>
      <div className="gradient-background" ref={background} aria-hidden="true">
        {Shader && !failed && (
          <Shader
            className="gradient-canvas"
            style={{ height: '100%', width: '100%' }}
            colorBack="hsl(0, 0%, 0%)"
            softness={0.76}
            intensity={0.45}
            noise={0}
            shape="corners"
            offsetX={0}
            offsetY={0}
            scale={1}
            rotation={0}
            speed={paused || reducedMotion ? 0 : 1}
            colors={colors}
            minPixelRatio={1}
            maxPixelCount={1_500_000}
          />
        )}
      </div>
      {Shader && !failed && !reducedMotion && (
        <button
          className="motion-toggle"
          type="button"
          onClick={() => setPaused((value) => !value)}
          aria-label={
            paused ? 'Play background animation' : 'Pause background animation'
          }
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden="true"
          >
            {paused ? (
              <path d="m3 1 8 5-8 5Z" />
            ) : (
              <path d="M2 1h3v10H2zm5 0h3v10H7z" />
            )}
          </svg>
          <span>{paused ? 'Play animation' : 'Pause animation'}</span>
        </button>
      )}
    </>
  );
}
