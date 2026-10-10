'use client';

// Adapted from React Bits Tech Text, MIT with Commons Clause; see
// public/react-bits-license.txt and docs/react-bits-design-research.md. Ported to TypeScript and kept to
// what the How it works page uses: a frame glides from letter to letter,
// labelled with the letter and its size in pixels, the way a document reader
// looks at one letter shape at a time. It sweeps on its own, follows the
// pointer, holds still when the visitor asks for less motion, and stops
// drawing while offscreen.

import { useEffect, useRef, type CSSProperties } from 'react';

const LABEL_FONT =
  '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

type Settings = {
  text: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  letterSpacing: number;
  color: string;
  accentColor: string;
  dashLength: number;
  dashGap: number;
  strokeWidth: number;
  specks: number;
  labels: boolean;
  speed: number;
};

type Box = { x1: number; y1: number; x2: number; y2: number };
type Sprite = { image: HTMLCanvasElement; left: number; top: number };
type Glyph = {
  char: string;
  x: number;
  box: Box;
  outline: number;
  fill: Sprite;
  dashes: Sprite;
};
type Word = {
  size: number;
  baseline: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const approach = (
  current: number,
  target: number,
  dt: number,
  seconds: number,
) => current + (target - current) * (1 - Math.exp(-dt / seconds));

const hexToRgb = (hex: string) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n)
    ? [255, 255, 255]
    : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const noise = (...values: number[]) => {
  let h = 2166136261;
  for (const value of values) {
    h = Math.imul(h ^ (value | 0), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
};

export function TechText({
  text,
  fontFamily = '',
  fontWeight = 600,
  fontSize = 150,
  letterSpacing = -0.05,
  color = '#163a2c',
  accentColor = '#337d5b',
  dashLength = 4,
  dashGap = 2,
  strokeWidth = 1.5,
  specks = 15,
  labels = true,
  speed = 1,
  label,
  className = '',
  style,
}: Partial<Settings> & {
  text: string;
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef<Settings | null>(null);
  const wakeRef = useRef(() => {});

  useEffect(() => {
    settingsRef.current = {
      text,
      fontFamily,
      fontWeight,
      fontSize,
      letterSpacing,
      color,
      accentColor,
      dashLength,
      dashGap,
      strokeWidth,
      specks,
      labels,
      speed,
    };
    wakeRef.current();
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const scratch = document.createElement('canvas');
    const scratchCtx = scratch.getContext('2d');
    if (!container || !canvas || !ctx || !scratchCtx) return undefined;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 1;
    let height = 1;
    let dpr = 1;
    let raf = 0;
    let last = performance.now();
    let visible = true;
    let alive = true;
    let layoutKey = '';
    let requestedFont = '';
    let word: Word | null = null;
    let glyphs: Glyph[] = [];
    let clock = 0;
    let pulse = 0;
    let placed = false;
    const pointer = { x: 0, y: 0, inside: false };
    const lens = { x: 0, y: 0 };
    const frame = { x1: 0, y1: 0, x2: 0, y2: 0, alpha: 0, index: -1 };

    const refreshFonts = () => {
      layoutKey = '';
      wakeRef.current();
    };

    const family = (s: Settings) =>
      s.fontFamily || getComputedStyle(container).fontFamily || 'sans-serif';
    const fontFor = (s: Settings, size: number) =>
      `${s.fontWeight} ${size}px ${family(s)}`;

    const setFont = (
      target: CanvasRenderingContext2D,
      s: Settings,
      size: number,
    ) => {
      target.font = fontFor(s, size);
      if ('letterSpacing' in target)
        target.letterSpacing = `${s.letterSpacing * size}px`;
      target.textAlign = 'left';
      target.textBaseline = 'alphabetic';
    };

    const sprite = (
      s: Settings,
      view: Word,
      glyph: { char: string; x: number; box: Box },
      stroke: boolean,
    ): Sprite => {
      const pad = Math.ceil(s.strokeWidth * 2 + 4);
      const left = glyph.box.x1 - pad;
      const top = glyph.box.y1 - pad;
      const w = glyph.box.x2 - glyph.box.x1 + pad * 2;
      const h = glyph.box.y2 - glyph.box.y1 + pad * 2;
      const image = document.createElement('canvas');
      image.width = Math.max(1, Math.ceil(w * dpr));
      image.height = Math.max(1, Math.ceil(h * dpr));
      const c = image.getContext('2d');
      if (!c) return { image, left, top };
      c.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr);
      setFont(c, s, view.size);
      if (stroke) {
        c.lineJoin = 'round';
        c.lineWidth = s.strokeWidth * 2;
        c.strokeStyle = s.color;
        c.setLineDash([Math.max(1, s.dashLength), Math.max(1, s.dashGap)]);
        c.strokeText(glyph.char, glyph.x, view.baseline);
        c.setLineDash([]);
        c.globalCompositeOperation = 'destination-out';
        c.fillStyle = '#000000';
        c.fillText(glyph.char, glyph.x, view.baseline);
        c.globalCompositeOperation = 'source-over';
      } else {
        c.fillStyle = s.color;
        c.fillText(glyph.char, glyph.x, view.baseline);
      }
      return { image, left, top };
    };

    const ensureLayout = (s: Settings): Word => {
      const key = [
        s.text,
        family(s),
        s.fontWeight,
        s.fontSize,
        s.letterSpacing,
        s.color,
        s.dashLength,
        s.dashGap,
        s.strokeWidth,
        width,
        height,
        dpr,
      ].join('|');
      if (key === layoutKey && word) return word;
      layoutKey = key;
      const wanted = fontFor(s, 64);
      if (wanted !== requestedFont) {
        requestedFont = wanted;
        document.fonts.load(wanted, s.text).then(refreshFonts, refreshFonts);
      }

      const probe = scratchCtx;
      setFont(probe, s, s.fontSize);
      let m = probe.measureText(s.text);
      const fit = Math.min(
        1,
        (width * 0.9) /
          Math.max(m.actualBoundingBoxLeft + m.actualBoundingBoxRight, 1),
        (height * 0.66) /
          Math.max(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, 1),
      );
      const size = s.fontSize * fit;
      setFont(probe, s, size);
      m = probe.measureText(s.text);
      const inkWidth = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      const inkHeight = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      const x = (width - inkWidth) / 2 + m.actualBoundingBoxLeft;
      const baseline = (height - inkHeight) / 2 + m.actualBoundingBoxAscent;
      const next: Word = {
        size,
        baseline,
        left: x - m.actualBoundingBoxLeft,
        right: x + m.actualBoundingBoxRight,
        top: baseline - m.actualBoundingBoxAscent,
        bottom: baseline + m.actualBoundingBoxDescent,
      };
      word = next;

      glyphs = [];
      let prefix = '';
      for (const char of Array.from(s.text)) {
        prefix += char;
        const own = probe.measureText(char);
        const gx = x + probe.measureText(prefix).width - own.width;
        if (!char.trim()) continue;
        const base = {
          char,
          x: gx,
          box: {
            x1: gx - own.actualBoundingBoxLeft,
            y1: baseline - own.actualBoundingBoxAscent,
            x2: gx + own.actualBoundingBoxRight,
            y2: baseline + own.actualBoundingBoxDescent,
          },
        };
        glyphs.push({
          ...base,
          outline: 0,
          fill: sprite(s, next, base, false),
          dashes: sprite(s, next, base, true),
        });
      }
      frame.index = -1;
      return next;
    };

    const glyphAt = (x: number, y: number) => {
      if (!word || y < word.top - 24 || y > word.bottom + 24) return -1;
      let best = -1;
      let bestDistance = Infinity;
      glyphs.forEach((glyph, i) => {
        const d =
          x < glyph.box.x1
            ? glyph.box.x1 - x
            : x > glyph.box.x2
              ? x - glyph.box.x2
              : 0;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      });
      return bestDistance < 28 ? best : -1;
    };

    const blit = (art: Sprite) => {
      ctx.drawImage(
        art.image,
        Math.round(art.left * dpr),
        Math.round(art.top * dpr),
      );
    };

    const crisp = (value: number) => (Math.round(value * dpr) + 0.5) / dpr;

    const perimeterPoint = (distance: number, w: number, h: number) => {
      let d = ((distance % (2 * (w + h))) + 2 * (w + h)) % (2 * (w + h));
      if (d < w) return [frame.x1 + d, frame.y1, 0, -1];
      d -= w;
      if (d < h) return [frame.x2, frame.y1 + d, 1, 0];
      d -= h;
      if (d < w) return [frame.x2 - d, frame.y2, 0, 1];
      d -= w;
      return [frame.x1, frame.y2 - d, -1, 0];
    };

    const drawSpecks = (s: Settings, a: number) => {
      const w = frame.x2 - frame.x1;
      const h = frame.y2 - frame.y1;
      if (w < 2 || h < 2) return;
      const perimeter = 2 * (w + h);
      const seed = frame.index + 1;
      const grid = 3;

      for (let k = 0; k < s.specks; k++) {
        const period = 0.5 + noise(seed, k, 11) * 1.2;
        const t = pulse / period + noise(seed, k, 17);
        const cycle = Math.floor(t);
        const life = t - cycle;
        if (life > 0.7) continue;
        const [px, py, nx, ny] = perimeterPoint(
          noise(seed, k, cycle) * perimeter,
          w,
          h,
        );
        const pick = noise(seed, k, cycle, 2);
        const size =
          pick < 0.46
            ? 2
            : pick < 0.7
              ? 3
              : pick < 0.84
                ? 5
                : pick < 0.94
                  ? 8
                  : 11;
        const large = size >= 8;
        const out =
          (large ? 9 : 4) + Math.floor(noise(seed, k, cycle, 1) * 5) * grid;
        const x =
          frame.x1 + Math.round((px + nx * out - frame.x1) / grid) * grid;
        const y =
          frame.y1 + Math.round((py + ny * out - frame.y1) / grid) * grid;
        const tone = noise(seed, k, cycle, 3);
        const blink = life < 0.06 || (life > 0.32 && life < 0.36) ? 0.35 : 1;
        const alpha = a * (large ? 0.3 + 0.4 * tone : 0.3 + 0.6 * tone) * blink;
        const left = Math.round(x - size / 2);
        const top = Math.round(y - size / 2);
        if (tone < 0.26 || (large && tone < 0.78)) {
          ctx.strokeStyle = rgba(s.accentColor, alpha);
          ctx.strokeRect(left + 0.5, top + 0.5, size, size);
        } else {
          ctx.fillStyle = rgba(s.accentColor, alpha);
          ctx.fillRect(left, top, size, size);
        }
      }

      for (let j = 0; j < 2; j++) {
        const head = (pulse * 0.42 * s.speed + j * 0.5) * perimeter;
        for (let i = 0; i < 4; i++) {
          const [x, y] = perimeterPoint(head - i * 6, w, h);
          const size = i === 0 ? 3 : 2;
          ctx.fillStyle = rgba(s.accentColor, a * [0.95, 0.55, 0.32, 0.16][i]);
          ctx.fillRect(
            Math.round(x - size / 2),
            Math.round(y - size / 2),
            size,
            size,
          );
        }
      }
    };

    const drawFrame = (s: Settings) => {
      const glyph = glyphs[frame.index];
      if (!glyph || frame.alpha < 0.01) return;
      const a = frame.alpha;
      const x1 = crisp(frame.x1);
      const y1 = crisp(frame.y1);
      const x2 = crisp(frame.x2);
      const y2 = crisp(frame.y2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.beginPath();
      ctx.rect(x1, y1, x2 - x1, y2 - y1);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(s.accentColor, 0.6 * a);
      ctx.stroke();

      ctx.beginPath();
      for (const [cx, cy] of [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
      ]) {
        ctx.rect(Math.round(cx) - 2, Math.round(cy) - 2, 5, 5);
      }
      ctx.fillStyle = rgba(s.accentColor, 0.95 * a);
      ctx.fill();

      if (s.specks > 0) drawSpecks(s, a);

      if (!s.labels) return;
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = rgba(s.accentColor, 0.9 * a);
      const w = Math.round(glyph.box.x2 - glyph.box.x1);
      const h = Math.round(glyph.box.y2 - glyph.box.y1);
      ctx.fillText(
        `${glyph.char}  ${w} × ${h}`,
        Math.round(frame.x1),
        Math.round(frame.y1) - 7,
      );
    };

    const tick = (now: number) => {
      raf = 0;
      const s = settingsRef.current;
      if (!s) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const view = ensureLayout(s);

      const sweeping = !motion.matches && !pointer.inside;
      if (sweeping) clock += dt * s.speed;
      pulse += motion.matches ? 0 : dt;
      let targetX = pointer.x;
      let targetY = pointer.y;
      if (sweeping) {
        targetX =
          view.left +
          (view.right - view.left) * (0.5 - 0.5 * Math.cos(clock * 0.45));
        targetY =
          view.top +
          (view.bottom - view.top) * (0.45 + 0.1 * Math.sin(clock * 0.8));
      }
      const active = pointer.inside || sweeping;
      if (active && !placed) {
        lens.x = targetX;
        lens.y = targetY;
      }
      if (active) {
        const lag = pointer.inside ? 0.05 : 0.22;
        lens.x = approach(lens.x, targetX, dt, lag);
        lens.y = approach(lens.y, targetY, dt, lag);
      }
      placed = active;

      let moving = false;
      const focus = active ? glyphAt(lens.x, lens.y) : -1;
      if (focus >= 0) {
        const glyph = glyphs[focus];
        const bx1 = glyph.box.x1 - 6;
        const by1 = glyph.box.y1 - 6;
        const bx2 = glyph.box.x2 + 6;
        const by2 = glyph.box.y2 + 6;
        if (frame.index < 0 || frame.alpha < 0.02) {
          frame.x1 = bx1;
          frame.y1 = by1;
          frame.x2 = bx2;
          frame.y2 = by2;
        }
        frame.x1 = approach(frame.x1, bx1, dt, 0.08);
        frame.y1 = approach(frame.y1, by1, dt, 0.08);
        frame.x2 = approach(frame.x2, bx2, dt, 0.08);
        frame.y2 = approach(frame.y2, by2, dt, 0.08);
        frame.index = focus;
      }
      frame.alpha = approach(frame.alpha, focus >= 0 ? 1 : 0, dt, 0.1);

      glyphs.forEach((glyph, i) => {
        const target = i === focus ? 1 : 0;
        glyph.outline = approach(glyph.outline, target, dt, 0.09);
        if (Math.abs(glyph.outline - target) > 0.002) moving = true;
        else glyph.outline = target;
      });

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const glyph of glyphs) {
        if (glyph.outline < 0.999) {
          ctx.globalAlpha = 1 - glyph.outline;
          blit(glyph.fill);
        }
        if (glyph.outline > 0.001) {
          ctx.globalAlpha = glyph.outline;
          blit(glyph.dashes);
        }
        ctx.globalAlpha = 1;
      }
      drawFrame(s);

      const settling = moving || (frame.alpha > 0.01 && frame.alpha < 0.99);
      const animating = sweeping || (pointer.inside && !motion.matches);
      if ((animating || settling) && visible && alive && !document.hidden)
        raf = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (raf || !visible || !alive) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const resize = () => {
      width = Math.max(1, container.clientWidth);
      height = Math.max(1, container.clientHeight);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      layoutKey = '';
      wake();
    };

    const onMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.inside = true;
      wake();
    };
    const onLeave = () => {
      pointer.inside = false;
      wake();
    };

    container.addEventListener('pointermove', onMove, { passive: true });
    container.addEventListener('pointerenter', onMove, { passive: true });
    container.addEventListener('pointerleave', onLeave, { passive: true });
    container.addEventListener('pointercancel', onLeave, { passive: true });
    motion.addEventListener('change', wake);
    document.addEventListener('visibilitychange', wake);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      wake();
    });
    intersectionObserver.observe(container);
    document.fonts.ready.then(refreshFonts, refreshFonts);

    resize();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      wakeRef.current = () => {};
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerenter', onMove);
      container.removeEventListener('pointerleave', onLeave);
      container.removeEventListener('pointercancel', onLeave);
      motion.removeEventListener('change', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`tech-text ${className}`.trim()}
      style={style}
    >
      <canvas ref={canvasRef} className="tech-text-canvas" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}
