'use client';

import { ArrowIcon } from '../_components/icons';
import Link from 'next/link';
import { GradientBackground } from './gradient-background';
import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import { TextType } from './text-type';
import { AutofillDemo } from './autofill-demo';

export function Home() {
  return (
    <div className="home-page">
      <SiteHeader />
      <main id="main">
        <section className="hero" aria-labelledby="hero-heading">
          <GradientBackground />
          <div className="hero-content wrap">
            <div className="hero-copy">
              <h1 id="hero-heading">
                <span>A little help.</span>
                <span>A lot less typing.</span>
              </h1>
              <p className="hero-lead">
                Applying for Iowa SNAP? Keep your details on your computer. Let
                SecondHand fill the supported fields, with your permission.
              </p>
              <div className="hero-actions">
                <a className="primary-link" href="/downloads">
                  Get SecondHand <ArrowIcon size={20} />
                </a>
                <a className="secondary-link" href="/setup">
                  Setup guide
                </a>
              </div>
              <p className="hero-note">
                Free for Windows &amp; Mac. No account needed.
              </p>
            </div>
          </div>
        </section>

        <div className="wrap page-content">
          <section
            id="demo"
            className="demo-section"
            aria-labelledby="demo-heading"
          >
            <h2 id="demo-heading">
              <TextType text={'Ready for\nless typing?'} />
            </h2>
            <AutofillDemo />
          </section>

          <div className="scope-note">
            <span className="note-label">What it does today</span>
            <div>
              <p>
                A browser side panel tracks the applicant page with completion
                checkmarks and missing-field reminders. With your approval, it
                fills saved applicant details, address and mailing information,
                and your explicit program choices, then selects Save and
                Continue when required answers are complete. On the home-address
                page, when SecondHand recognizes it, it selects Iowa’s first
                suggested home address and continues, so review that address
                before you submit.
              </p>
              <p>
                It answers Iowa’s Tell Us More questions only from answers you
                saved in My information. If you turn on Laya, SecondHand’s AI on
                this computer, it fills more questions and marks them as guesses
                to check. It moves past information-only screens for you. It
                also selects Save and Continue on Tell Us More, Background
                Information, and Iowa’s questions about emergency SNAP, jobs,
                income, expenses and property. It does the same on pages for one
                person’s saved job, private pension, Social Security, rent,
                utilities or cash. It does this only when it knows every
                question on the page and every required answer is filled in. If
                a required answer is missing, or Iowa shows an error or pop-up,
                it stays on that page. Anywhere else, you move on yourself. You
                handle consent, signatures and submission.
              </p>
              <p>
                The side panel works in English, Spanish, Vietnamese, Chinese,
                French and Arabic. On Iowa’s information-only screens, it can
                list what the screen says and show its words in your language,
                using Chrome’s built-in summarizer and translator on this
                computer, when that Chrome has them.
              </p>
            </div>
          </div>

          <section
            className="faq-callout"
            aria-labelledby="faq-callout-heading"
          >
            <h2 id="faq-callout-heading">Still have questions?</h2>
            <Link className="text-link" href="/faq">
              Read the common questions
            </Link>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
