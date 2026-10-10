import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowIcon } from '../_components/icons';
import { LoopVideo } from '../_components/loop-video';
import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import { TechText } from './tech-text';

export const metadata: Metadata = {
  title: 'How SecondHand works',
  description:
    'See SecondHand fill a benefits application: save your details once, click Autofill, check every answer. Learn how Laya and document reading work on your own computer.',
  alternates: { canonical: '/how-it-works' },
};

export default function HowItWorks() {
  return (
    <>
      <SiteHeader current="/how-it-works" />
      <main id="main" className="wrap how-page">
        <header className="how-intro">
          <h1>How SecondHand works</h1>
          <p className="doc-lead">
            SecondHand has two parts that work together on your computer. The
            SecondHand app keeps your details. The Chrome extension fills them
            into Iowa’s application when you say yes.
          </p>
        </header>

        <section className="how-step" aria-labelledby="how-save">
          <div className="how-copy">
            <span className="how-number">1</span>
            <h2 id="how-save">Save your details once</h2>
            <p>
              Open the SecondHand app and make a password. Then type your name,
              address, household and income in <strong>My information</strong>.
              You only do this once.
            </p>
            <p>
              Your details are locked with your password and stay on this
              computer. There’s no account, and nothing is sent to us.
            </p>
          </div>
          <Image
            className="how-media"
            src="/demo/my-information.jpg"
            alt="The My information page of the SecondHand app, with the fictional applicant Avery Example’s name, date of birth, and student status."
            width={1600}
            height={1075}
            unoptimized
          />
        </section>

        <section className="how-step" aria-labelledby="how-fill">
          <div className="how-copy">
            <span className="how-number">2</span>
            <h2 id="how-fill">Click Autofill on the application</h2>
            <p>
              On Iowa’s application, a small SecondHand card sits in the corner.
              Click <strong>Autofill</strong>. The app asks you first, then the
              answers you saved fill in.
            </p>
            <p>
              If a question has no saved answer, the card says so. Click it to
              jump straight to that question and type it yourself.
            </p>
          </div>
          <LoopVideo
            className="how-media"
            src="/demo/autofill.mp4"
            poster="/demo/autofill-poster.jpg"
            width={880}
            height={560}
            label="The SecondHand card in the corner of Iowa’s application. A click on Autofill fills the saved answers, a 1 question left link appears, and clicking it jumps to the empty First Name field, where Avery is typed."
          />
        </section>

        <section className="how-step" aria-labelledby="how-check">
          <div className="how-copy">
            <span className="how-number">3</span>
            <h2 id="how-check">Check every answer, then send it yourself</h2>
            <p>
              Click the SecondHand logo to open a checklist beside the page. It
              marks what’s done and what still needs you.
            </p>
            <p>
              SecondHand never signs or sends your application. You read it over
              and submit it when you’re ready.
            </p>
          </div>
          <Image
            className="how-media"
            src="/demo/side-panel.jpg"
            alt="Iowa’s Enter Personal Information page next to the SecondHand side panel. The panel says Filled 20 answers, 1 left for you, with First name marked No saved answer and the other name fields marked Done."
            width={1800}
            height={956}
            unoptimized
          />
        </section>

        <section className="how-step" aria-labelledby="how-laya">
          <div className="how-copy">
            <h2 id="how-laya">Laya, for questions it hasn’t seen</h2>
            <p>
              Some forms ask things in their own words. Laya is SecondHand’s AI,
              and it runs on your computer, not online. It reads the question,
              compares it with what you saved, and fills it only when it’s sure.
            </p>
            <p>
              Anything Laya fills gets a dashed outline so you know to check it.
              If it isn’t sure, it leaves the question for you.
            </p>
          </div>
          <LoopVideo
            className="how-media"
            src="/demo/laya.mp4"
            poster="/demo/laya-poster.jpg"
            width={960}
            height={540}
            label="A food pantry form asks whether anyone in the household is 60 or older, and whether there is a pet. Laya scores each choice, fills No for the first question with a dashed outline, and leaves the pet question for the applicant, marked Needs you."
          />
        </section>

        <section className="how-ocr" aria-labelledby="how-ocr">
          <div className="how-copy">
            <h2 id="how-ocr">Reading your documents</h2>
            <p>
              The SecondHand app can read a tax form for you, like a W-2, an
              SSA-1099, a 1099-NEC or a Form 1040. This is called OCR, short for
              optical character recognition: turning a picture of words into
              text a computer can use.
            </p>
          </div>
          <div className="ocr-stage">
            <TechText
              text="W-2 Wages"
              label="The words W-2 Wages. A frame moves from letter to letter and labels each one with its size in pixels."
              fontFamily="'Bricolage Grotesque Variable', Arial, sans-serif"
              fontWeight={600}
              fontSize={150}
              color="#163a2c"
              accentColor="#337d5b"
              specks={12}
            />
            <p className="ocr-caption">
              Like this frame, OCR looks at one letter shape at a time. Move
              your pointer over the words to try it.
            </p>
          </div>
          <ol className="ocr-steps">
            <li>
              <h3>You choose the file</h3>
              <p>
                In the app, open <strong>Documents</strong> and choose a PDF or
                a photo. The original stays where it is.
              </p>
            </li>
            <li>
              <h3>It reads every letter</h3>
              <p>
                SecondHand turns each page into a picture and works out each
                letter and number from its shape.
              </p>
            </li>
            <li>
              <h3>It reads twice</h3>
              <p>
                It reads the page two different ways. A Social Security number
                or an amount is only suggested when both readings agree.
              </p>
            </li>
            <li>
              <h3>You decide what to keep</h3>
              <p>
                It finds labels like “Wages” and suggests your details. Nothing
                is added until you tick it and save.
              </p>
            </li>
          </ol>
          <p className="ocr-note">
            All of this happens on your computer. The document isn’t uploaded or
            kept. OCR can mix up letters and numbers, so compare each suggestion
            with your paper.
          </p>
        </section>

        <section className="how-next" aria-labelledby="how-next">
          <h2 id="how-next">Ready to try it?</h2>
          <div className="hero-actions">
            <Link className="primary-link" href="/downloads">
              Get SecondHand <ArrowIcon size={20} />
            </Link>
            <Link className="secondary-link" href="/setup">
              Setup guide
            </Link>
          </div>
          <p>
            Want the details? Read{' '}
            <Link href="/privacy">
              how SecondHand keeps your information private
            </Link>
            .
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
