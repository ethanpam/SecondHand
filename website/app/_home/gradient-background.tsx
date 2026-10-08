'use client';

import type { GrainGradient } from '@paper-design/shaders-react';
import { useEffect, useRef, useState } from 'react';
import { useSiteMotion } from '../../lib/site-motion';

const colors = ['#8bb89a', '#d7e6cf', '#337d5b'];
export function GradientBackground() {
  const { enabled } = useSiteMotion();
  const [Shader, setShader] = useState<typeof GrainGradient | null>(null);
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
            colorBack="#f8faf7"
            softness={0.76}
            intensity={0.45}
            noise={0}
            shape="corners"
            offsetX={0}
            offsetY={0}
            scale={1}
            rotation={0}
            speed={enabled ? 1 : 0}
            colors={colors}
            minPixelRatio={1}
            maxPixelCount={1_500_000}
          />
        )}
      </div>
    </>
  );
}
