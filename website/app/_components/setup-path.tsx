// The four pages a new user goes through, in order, shown at the top of each
// so nobody has to hunt for the next one.
const steps = [
  { href: '/downloads', label: 'Download the app' },
  { href: '/setup', label: 'Install it and make a password' },
  { href: '/chrome-extension', label: 'Add it to Chrome' },
  { href: '/how-it-works', label: 'Fill your application' },
];

export function SetupPath({ current }: { current: string }) {
  return (
    <nav className="setup-path" aria-label="Getting started">
      <ol>
        {steps.map(({ href, label }, index) => (
          <li key={href}>
            <a href={href} aria-current={href === current ? 'step' : undefined}>
              <span className="setup-path-number">{index + 1}</span>
              {label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
