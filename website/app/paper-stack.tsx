'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from 'motion/react';
import { useSiteMotion } from './site-motion';
import { ArrowIcon, CheckIcon } from './icons';

const captions = [
  'Save the details you want to reuse.',
  'Approve the request in the desktop app.',
  'Review your answers in Iowa’s portal.',
];

function PaperCard({
  children,
  depth,
  enabled,
  next,
}: {
  children: ReactNode;
  depth: number;
  enabled: boolean;
  next: () => void;
}) {
  const horizontal = useMotionValue(0);
  const rotateY = useTransform(horizontal, [-160, 160], [-12, 12]);
  function onDragEnd(
    _event: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo,
  ) {
    if (Math.abs(info.offset.x) > 65) next();
    horizontal.set(0);
  }
  return (
    <motion.div
      className="stack-layer"
      aria-hidden={depth !== 0}
      data-front={depth === 0}
      style={{ zIndex: 3 - depth }}
      animate={{
        rotateZ: depth * -6,
        scale: 1 - depth * 0.045,
        y: depth * -18,
        x: depth * -8,
      }}
      initial={false}
      transition={
        enabled
          ? { type: 'spring', stiffness: 260, damping: 26 }
          : { duration: 0 }
      }
    >
      <motion.div
        className="paper-card"
        style={{ x: horizontal, rotateY: enabled ? rotateY : 0 }}
        drag={enabled && depth === 0 ? 'x' : false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.35}
        onDragEnd={onDragEnd}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function PaperStack() {
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const container = useRef<HTMLElement>(null);
  const { enabled } = useSiteMotion();
  const autoplay = enabled && visible && !hovered && !focused;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let intersects = false;
    const update = () => setVisible(intersects && !document.hidden);
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersects = entry.isIntersecting;
        update();
      },
      { threshold: 0.2 },
    );
    observer.observe(element);
    const enter = () => setHovered(true);
    const leave = () => setHovered(false);
    const focus = () => setFocused(true);
    const blur = (event: FocusEvent) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !element.contains(event.relatedTarget)
      )
        setFocused(false);
    };
    element.addEventListener('mouseenter', enter);
    element.addEventListener('mouseleave', leave);
    element.addEventListener('focusin', focus);
    element.addEventListener('focusout', blur);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      element.removeEventListener('mouseenter', enter);
      element.removeEventListener('mouseleave', leave);
      element.removeEventListener('focusin', focus);
      element.removeEventListener('focusout', blur);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useEffect(() => {
    if (!autoplay) return;
    const interval = setInterval(
      () => setActive((value) => (value + 1) % 3),
      5000,
    );
    return () => clearInterval(interval);
  }, [autoplay]);

  const next = () => setActive((value) => (value + 1) % 3);
  return (
    <section
      ref={container}
      className="workflow-preview"
      aria-roledescription="carousel"
      aria-label="How secondHand works"
      data-autoplay={autoplay}
    >
      <div className="stack-stage">
        <div className="paper-stack">
          {[0, 1, 2].map((index) => (
            <PaperCard
              key={index}
              depth={(index - active + 3) % 3}
              enabled={enabled}
              next={next}
            >
              <div className="paper-meta">
                <span>secondHand</span>
                <span>0{index + 1} / 03</span>
              </div>
              {index === 0 && (
                <>
                  <h2>
                    A place for
                    <br />
                    your details.
                  </h2>
                  <div className="sample-profile">
                    <div className="profile-initial" aria-hidden="true">
                      You
                    </div>
                    <div>
                      <strong>Your saved profile</strong>
                      <span>Ready when you need it</span>
                    </div>
                  </div>
                  <dl className="sample-fields">
                    <div>
                      <dt>Full name</dt>
                      <dd>Your name</dd>
                    </div>
                    <div>
                      <dt>Home address</dt>
                      <dd>Your address</dd>
                    </div>
                  </dl>
                  <div className="paper-foot">
                    <span className="tiny-dot" /> Stored on your computer
                  </div>
                </>
              )}
              {index === 1 && (
                <>
                  <h2>
                    Your say.
                    <br />
                    Every time.
                  </h2>
                  <div className="approval-symbol" aria-hidden="true">
                    <span>sh</span>
                    <ArrowIcon size={30} />
                    <span>IA</span>
                  </div>
                  <p className="paper-description">
                    Iowa’s portal needs your saved details. The desktop app asks
                    you first.
                  </p>
                  <div className="paper-foot">Your approval is required</div>
                </>
              )}
              {index === 2 && (
                <>
                  <h2>
                    Filled in.
                    <br />
                    Still your call.
                  </h2>
                  <ul className="sample-checklist">
                    <li>
                      Applicant details <CheckIcon />
                    </li>
                    <li>
                      Address information <CheckIcon />
                    </li>
                    <li>
                      Your program choices <CheckIcon />
                    </li>
                  </ul>
                  <div className="paper-foot">You review, sign, and submit</div>
                </>
              )}
            </PaperCard>
          ))}
        </div>
      </div>
      <div className="stack-controls">
        <div
          className="stack-caption"
          aria-live={autoplay ? 'off' : 'polite'}
          aria-atomic="true"
        >
          <span className="stack-count">0{active + 1} / 03</span>
          <p>{captions[active]}</p>
        </div>
        <div className="stack-buttons">
          <button
            type="button"
            aria-label="Previous preview step"
            onClick={() => setActive((value) => (value + 2) % 3)}
          >
            <ArrowIcon />
          </button>
          <button type="button" aria-label="Next preview step" onClick={next}>
            <ArrowIcon />
          </button>
        </div>
      </div>
      <p className="preview-disclaimer">
        Illustration of the workflow, not a live application.
      </p>
      <noscript>
        <style>{'.stack-buttons { display: none; }'}</style>
      </noscript>
    </section>
  );
}
