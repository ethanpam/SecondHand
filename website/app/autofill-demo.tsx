'use client';

import { useEffect, useState } from 'react';
import { CheckIcon } from './icons';
import { MotionToggle, useVisibleMotion } from './site-motion';

const stages = [
  { name: 'approach', duration: 1100, filled: 0 },
  { name: 'click', duration: 280, filled: 0 },
  { name: 'name', duration: 380, filled: 1 },
  { name: 'email', duration: 380, filled: 2 },
  { name: 'city', duration: 500, filled: 3 },
  { name: 'complete', duration: 3600, filled: 3 },
] as const;

const fields = [
  { label: 'Full name', value: 'Avery Example', placeholder: 'Your name' },
  { label: 'Email', value: 'avery@example.com', placeholder: 'Your email' },
  { label: 'City', value: 'Ames', placeholder: 'Your city' },
];

export function AutofillDemo() {
  const { ref, active, enabled, reducedMotion } =
    useVisibleMotion<HTMLElement>();
  const [stageIndex, setStageIndex] = useState(0);
  const [replay, setReplay] = useState(0);
  const stage = stages[enabled ? stageIndex : stages.length - 1];

  useEffect(() => {
    if (!active) return;
    const timeout = setTimeout(
      () => setStageIndex((index) => (index + 1) % stages.length),
      stages[stageIndex].duration,
    );
    return () => clearTimeout(timeout);
  }, [active, stageIndex, replay]);

  function replayDemo() {
    setStageIndex(0);
    setReplay((count) => count + 1);
  }

  return (
    <figure
      ref={ref}
      className="autofill-demo"
      aria-labelledby="autofill-caption"
      data-phase={stage.name}
      data-running={active}
      data-motion={enabled}
    >
      <div key={replay} className="autofill-scene" aria-hidden="true">
        <div className="autofill-toolbar">
          <span>With your permission.</span>
          <div className="autofill-trigger">
            Approve fill <CheckIcon size={16} />
            <span className="autofill-click-ring" />
            <svg
              className="autofill-cursor"
              width="28"
              height="34"
              viewBox="0 0 28 34"
              fill="none"
            >
              <path
                d="M3 2v24l6-6 5 11 5-2-5-11h10L3 2Z"
                fill="#163a2c"
                stroke="#fff"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
        <div className="autofill-fields">
          {fields.map((field, index) => (
            <div
              className="autofill-field"
              key={field.label}
              data-filled={stage.filled > index}
            >
              <span className="autofill-label">{field.label}</span>
              <span className="autofill-value">
                {stage.filled > index ? field.value : field.placeholder}
                {stage.filled > index && <CheckIcon size={15} />}
              </span>
            </div>
          ))}
        </div>
        <p className="autofill-result">
          {stage.filled === fields.length
            ? 'Details filled. You review what comes next.'
            : 'Your saved details, without typing them again.'}
        </p>
      </div>
      <figcaption id="autofill-caption">
        Illustration with fictional details. Nothing is sent.
        <span className="screen-reader-only">
          After approval, the example fills Avery Example, avery@example.com,
          and Ames. You review the answers before continuing.
        </span>
      </figcaption>
      {!reducedMotion && (
        <div className="autofill-controls">
          <button
            className="replay-demo"
            type="button"
            onClick={replayDemo}
            disabled={!enabled}
          >
            Replay demo <span aria-hidden="true">↻</span>
          </button>
          <MotionToggle label="all animations" />
        </div>
      )}
    </figure>
  );
}
