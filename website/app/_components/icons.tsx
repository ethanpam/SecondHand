// The few marks the site needs, drawn with the same paths as the desktop app's
// icon set. They are decorative, so screen readers skip them.
const stroke = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: 'false' as const,
});

export function DownloadIcon({ size = 20 }: { size?: number }) {
  return (
    <svg {...stroke(size)}>
      <path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6" />
    </svg>
  );
}

export function ExternalIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...stroke(size)}>
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}

export function CheckIcon({ size = 17 }: { size?: number }) {
  return (
    <svg {...stroke(size)}>
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export function ArrowIcon({ size = 18 }: { size?: number }) {
  return (
    <svg {...stroke(size)}>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </svg>
  );
}

export function LockIcon({ size = 17 }: { size?: number }) {
  return (
    <svg {...stroke(size)}>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </svg>
  );
}
