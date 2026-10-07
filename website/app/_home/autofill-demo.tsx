'use client';

import { useEffect, useState } from 'react';
import { CheckIcon } from '../_components/icons';
import { useVisibleMotion } from '../../lib/site-motion';

const stages = [
  { name: 'approach', duration: 1100, filled: 0 },
  { name: 'click', duration: 280, filled: 0 },
  { name: 'name', duration: 380, filled: 1 },
  { name: 'email', duration: 380, filled: 2 },
  { name: 'city', duration: 500, filled: 3 },
  { name: 'complete', duration: 3600, filled: 3 },
] as const;

const fields = [
  { label: 'Full name', value: 'Daniel Ceaser', placeholder: 'Your name' },
  {
    label: 'Email',
    value: 'Ceaser.Daniel@example.com',
    placeholder: 'Your email',
  },
  { label: 'City', value: 'Toronto', placeholder: 'Your city' },
];

export function AutofillDemo() {
  const { ref, active, enabled } = useVisibleMotion<HTMLElement>();
  const [stageIndex, setStageIndex] = useState(0);
  const stage = stages[enabled ? stageIndex : stages.length - 1];

  useEffect(() => {
    if (!active) return;
    const timeout = setTimeout(
      () => setStageIndex((index) => (index + 1) % stages.length),
      stages[stageIndex].duration,
    );
    return () => clearTimeout(timeout);
  }, [active, stageIndex]);

  return (
    <figure
      ref={ref}
      className="autofill-demo"
      aria-labelledby="autofill-caption"
      data-phase={stage.name}
      data-running={active}
      data-motion={enabled}
    >
      <div className="autofill-scene" aria-hidden="true">
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
          After approval, the example fills Daniel Ceaser,
          Ceaser.Daniel@example.com, and Toronto. You review the answers before
          continuing.
        </span>
      </figcaption>
    </figure>
  );
}
