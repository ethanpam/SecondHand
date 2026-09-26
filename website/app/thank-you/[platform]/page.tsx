import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ExternalIcon } from '../../icons';
import { downloads } from '../../release';
import { SiteFooter, SiteHeader } from '../../site-chrome';
import { StartDownload } from '../start-download';

const platforms = {
  windows: {
    name: 'Windows',
    file: downloads.windows,
    install:
      'Open the downloaded .exe file and follow the installer. If Windows shows “Windows protected your PC,” read the warning notes in the setup guide before continuing.',
  },
  'mac-apple-silicon': {
    name: 'Mac with Apple silicon',
    file: downloads.macArm,
    install:
      'Open the downloaded .dmg file, drag SecondHand into Applications, and open it from Applications. If your Mac blocks it, follow Apple’s guidance below.',
  },
  'mac-intel': {
    name: 'Intel Mac',
    file: downloads.macIntel,
    install:
      'Open the downloaded .dmg file, drag SecondHand into Applications, and open it from Applications. If your Mac blocks it, follow Apple’s guidance below.',
  },
} as const;
type PlatformId = keyof typeof platforms;
type Props = { params: Promise<{ platform: string }> };

export const dynamicParams = false;
export function generateStaticParams() {
  return Object.keys(platforms).map((platform) => ({ platform }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { platform } = await params;
  const name = Object.hasOwn(platforms, platform)
    ? platforms[platform as PlatformId].name
    : 'your computer';
  return {
    title: `Thanks for downloading for ${name}`,
    description: `Your SecondHand download for ${name} is starting. Here is how to install it, create your password, and connect Chrome.`,
    robots: { index: false, follow: true },
  };
}

export default async function ThankYou({ params }: Props) {
  const { platform } = await params;
  if (!Object.hasOwn(platforms, platform)) notFound();
  const { name, file, install } = platforms[platform as PlatformId];
  return (
    <>
      <StartDownload href={file} />
      <SiteHeader />
      <main id="main" className="wrap doc-page">
        <h1>Thanks for downloading SecondHand</h1>
        <p className="doc-lead">
          Your download for {name} should start in a moment. If it doesn’t,{' '}
          <a href={file}>download it directly</a>.
        </p>
        <h2>What to do next</h2>
        <ol className="next-steps">
          <li>
            <strong>Install the app.</strong> {install}
          </li>
          <li>
            <strong>Create a password.</strong> Open SecondHand and choose a
            password of at least 12 characters. Save the recovery key it shows
            you somewhere safe, away from your computer.
          </li>
          <li>
            <strong>Add the Chrome extension.</strong> In the app, choose Chrome
            extension, then Prepare Chrome extension, and load that folder at{' '}
            <code>chrome://extensions</code> with Developer mode on.
          </li>
        </ol>
        {platform !== 'windows' && (
          <p>
            <a
              href="https://support.apple.com/en-us/102445"
              target="_blank"
              rel="noreferrer"
            >
              Apple’s guidance on opening apps <ExternalIcon size={14} />
            </a>
          </p>
        )}
        <p>
          Need more detail? Read the <a href="/#setup">full setup guide</a>, the{' '}
          <a href="/#faq">common questions</a>, or our{' '}
          <a href="/privacy">privacy policy</a>.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
