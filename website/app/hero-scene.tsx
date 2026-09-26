'use client';

import { useEffect, useRef } from 'react';

// Animated backdrop for the hero: a glowing blossom tree on a lit hillside with
// petals drifting past, in the spirit of the Compute template's background
// video but drawn here, so no outside media is loaded. The hill and tree are
// painted once into an offscreen canvas; each frame only moves the petals.

type Petal = { x: number; y: number; vx: number; vy: number; size: number; phase: number; spin: number; alpha: number };

// Small seeded generator so the tree looks the same on every visit.
function seeded(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLOSSOMS = ['#ffc2dc', '#ff9cc6', '#ffe3ef', '#f07aa8', '#ffb0d0'];

function paintScene(width: number, height: number, dpr: number) {
  const scene = document.createElement('canvas');
  scene.width = Math.round(width * dpr);
  scene.height = Math.round(height * dpr);
  const ctx = scene.getContext('2d');
  if (!ctx) return { scene, canopy: { x: width * 0.76, y: height * 0.35, r: height * 0.2 } };
  ctx.scale(dpr, dpr);
  const random = seeded(20260926);
  const between = (min: number, max: number) => min + random() * (max - min);

  // Ridge of the hill, sampled from two cubic curves so points can sit on it.
  const curves: [number, number][][] = [
    [[0, height * 0.9], [width * 0.3, height * 0.76], [width * 0.52, height * 0.68], [width * 0.74, height * 0.67]],
    [[width * 0.74, height * 0.67], [width * 0.88, height * 0.66], [width * 0.97, height * 0.7], [width, height * 0.73]],
  ];
  const ridge: [number, number][] = [];
  for (const [a, b, c, d] of curves) {
    for (let i = 0; i <= 60; i++) {
      const t = i / 60, u = 1 - t;
      ridge.push([
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
      ]);
    }
  }
  const ridgeY = (x: number) => {
    for (let i = 1; i < ridge.length; i++) {
      if (ridge[i][0] >= x) {
        const [x0, y0] = ridge[i - 1], [x1, y1] = ridge[i];
        return y0 + ((x - x0) / Math.max(x1 - x0, 1e-6)) * (y1 - y0);
      }
    }
    return ridge[ridge.length - 1][1];
  };

  // Soft pink haze behind the canopy.
  // Keep the tree in the right third so it never sits behind the headline.
  const treeX = width * (width > 900 ? 0.82 : 0.86), baseY = ridgeY(treeX);
  const haze = ctx.createRadialGradient(treeX, baseY - height * 0.32, 0, treeX, baseY - height * 0.32, height * 0.55);
  haze.addColorStop(0, 'rgba(255, 110, 160, 0.14)');
  haze.addColorStop(1, 'rgba(255, 110, 160, 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, width, height);

  // Hill body with a warm lit rim.
  ctx.beginPath();
  ctx.moveTo(ridge[0][0], ridge[0][1]);
  for (const [x, y] of ridge) ctx.lineTo(x, y);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  const body = ctx.createLinearGradient(0, height * 0.62, 0, height);
  body.addColorStop(0, '#3a130b');
  body.addColorStop(1, '#070302');
  ctx.fillStyle = body;
  ctx.fill();
  ctx.save();
  ctx.shadowColor = '#ff6a3d';
  ctx.shadowBlur = 22;
  ctx.strokeStyle = 'rgba(255, 138, 92, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ridge[0][0], ridge[0][1]);
  for (const [x, y] of ridge) ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();

  // Grass blades along the ridge.
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const x = random() * width, y = ridgeY(x) + between(0, height * 0.05);
    ctx.strokeStyle = `rgba(${Math.round(between(150, 220))}, ${Math.round(between(60, 95))}, 45, ${between(0.25, 0.6)})`;
    ctx.lineWidth = between(0.6, 1.4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + between(-4, 4), y - between(6, 14), x + between(-8, 8), y - between(10, 22));
    ctx.stroke();
  }
  ctx.restore();

  // Glowing flowers, denser toward the left slope and under the tree.
  ctx.save();
  ctx.shadowColor = '#ff8fc4';
  for (let i = 0; i < 260; i++) {
    const x = Math.pow(random(), 1.3) * width, y = ridgeY(x) + between(-2, height * 0.07);
    ctx.shadowBlur = between(4, 12);
    ctx.fillStyle = random() < 0.7 ? `rgba(255, 224, 238, ${between(0.55, 0.95)})` : `rgba(255, 170, 110, ${between(0.5, 0.9)})`;
    ctx.beginPath();
    ctx.arc(x, y, between(1, 3.2), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // The tree: recursive branches that glow pink toward the tips, with blossom
  // clusters on the outer branches.
  const clusters: [number, number, number][] = [];
  const branch = (x: number, y: number, length: number, angle: number, width: number, depth: number) => {
    const x2 = x + Math.cos(angle) * length, y2 = y + Math.sin(angle) * length;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = '#ff6f91';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = depth > 5 ? '#b24e52' : depth > 3 ? '#d86a78' : '#ff9bb0';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo((x + x2) / 2 + between(-length, length) * 0.12, (y + y2) / 2, x2, y2);
    ctx.stroke();
    ctx.restore();
    if (depth <= 0) { clusters.push([x2, y2, length]); return; }
    const children = depth > 5 ? 2 : random() < 0.6 ? 2 : 3;
    for (let i = 0; i < children; i++) {
      // Uneven lengths and a little random lean keep the canopy from looking symmetrical.
      const spread = between(0.2, 0.6) * (i % 2 === 0 ? -1 : 1) + between(-0.12, 0.12);
      branch(x2, y2, length * between(0.64, 0.86), angle + spread, Math.max(width * 0.7, 0.6), depth - 1);
    }
    if (depth <= 4) clusters.push([x2, y2, length]);
  };
  const trunk = Math.min(height * 0.12, width * 0.075);
  branch(treeX, baseY, trunk, -Math.PI / 2 - 0.1, Math.max(trunk * 0.08, 4), 7);

  ctx.save();
  ctx.shadowColor = '#ff7ab8';
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [cx, cy, length] of clusters) {
    const radius = Math.max(length * 0.7, height * 0.015);
    for (let i = 0; i < 16; i++) {
      const a = random() * Math.PI * 2, d = Math.sqrt(random()) * radius;
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d * 0.8;
      ctx.shadowBlur = between(3, 9);
      ctx.fillStyle = BLOSSOMS[Math.floor(random() * BLOSSOMS.length)];
      ctx.globalAlpha = between(0.45, 0.95);
      ctx.beginPath();
      ctx.arc(px, py, between(0.8, 2.6), 0, Math.PI * 2);
      ctx.fill();
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  ctx.restore();

  const canopy = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, r: Math.max((maxX - minX) / 2, height * 0.1) };
  return { scene, canopy };
}

// One glowing petal, drawn once and reused for every petal each frame.
function petalSprite(dpr: number) {
  const size = 24;
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = size * dpr;
  const ctx = sprite.getContext('2d');
  if (!ctx) return sprite;
  ctx.scale(dpr, dpr);
  ctx.shadowColor = '#ff7ab8';
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#ffb3d1';
  ctx.beginPath();
  ctx.ellipse(size / 2, size / 2, 4, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();
  return sprite;
}

export function HeroScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const random = seeded(7);
    let width = 0, height = 0, dpr = 1, frame = 0, last = 0, visible = true;
    let scene: HTMLCanvasElement | null = null, sprite: HTMLCanvasElement | null = null;
    let canopy = { x: 0, y: 0, r: 1 };
    let petals: Petal[] = [];

    const spawn = (anywhere: boolean): Petal => ({
      x: anywhere ? random() * width : canopy.x + (random() - 0.5) * canopy.r * 2,
      y: anywhere ? random() * height * 0.8 : canopy.y + (random() - 0.5) * canopy.r,
      vx: -(0.15 + random() * 0.45), vy: 0.08 + random() * 0.3,
      size: 0.6 + random() * 0.8, phase: random() * Math.PI * 2, spin: 0.01 + random() * 0.03, alpha: 0.5 + random() * 0.5,
    });

    const draw = () => {
      if (!scene || !sprite) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(scene, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const p of petals) {
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.phase);
        ctx.scale(p.size, p.size);
        ctx.drawImage(sprite, -12, -12, 24, 24);
        ctx.restore();
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width; height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const painted = paintScene(width, height, dpr);
      scene = painted.scene; canopy = painted.canopy;
      sprite = petalSprite(dpr);
      const count = Math.round(Math.min(90, Math.max(30, width / 18)));
      petals = Array.from({ length: count }, () => spawn(true));
      draw();
    };

    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      const step = Math.min((time - last) / 16.7, 3);
      last = time;
      if (!visible) return;
      for (let i = 0; i < petals.length; i++) {
        const p = petals[i];
        p.phase += p.spin * step;
        p.x += (p.vx + Math.sin(p.phase) * 0.25) * step;
        p.y += p.vy * step;
        if (p.x < -20 || p.y > height + 20) petals[i] = spawn(false);
      }
      draw();
    };

    resize();
    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
    // Stop animating while the hero is off screen or the tab is hidden.
    const onScreen = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting && !document.hidden; });
    onScreen.observe(canvas);
    const onVisibility = () => { visible = !document.hidden; };
    document.addEventListener('visibilitychange', onVisibility);
    if (!reduceMotion) frame = requestAnimationFrame(time => { last = time; tick(time); });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      onScreen.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="hero-scene" aria-hidden="true" />;
}
