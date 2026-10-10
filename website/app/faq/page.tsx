import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import { faq } from './questions';

export const metadata: Metadata = {
  title: 'Common questions',
  description:
    'Answers about SecondHand: what it costs, what it fills and never submits, what to do if you forget your password, and which computers it works on.',
  alternates: { canonical: '/faq' },
};

// The questions for search engines come from the same data the page shows,
// so the two cannot drift apart.
const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faq.map(({ question, answer }) => ({
    '@type': 'Question',
    name: question,
    acceptedAnswer: { '@type': 'Answer', text: answer },
  })),
};

export default function CommonQuestions() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, '\\u003c'),
        }}
      />
      <SiteHeader current="/faq" />
      <main id="main" className="wrap doc-page faq-page">
        <h1>Common questions</h1>
        <p className="doc-lead">
          What SecondHand costs, what it does and doesn’t do, and what to do if
          you forget your password.
        </p>
        <div className="faq-list">
          {faq.map(({ question, answer }) => (
            <details key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
        <p className="faq-more">
          Still stuck? Read the <Link href="/setup">setup guide</Link> or the{' '}
          <Link href="/privacy">privacy policy</Link>.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
