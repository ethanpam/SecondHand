// Shared by the FAQ section and its structured data, so both always match.
export const faq = [
  {
    question: 'Does secondHand cost anything?',
    answer: 'No. The download is free, and there is no account or subscription.',
  },
  {
    question: 'Does secondHand submit my application or decide if I qualify?',
    answer: 'No. After you approve, it fills supported fields and can select Save and Continue on supported pages. You review every answer and handle consent, signatures, and final submission yourself. Only Iowa HHS decides eligibility.',
  },
  {
    question: 'What if I forget my password?',
    answer: 'When you create your password, the app shows a recovery key. Choose “Forgot password?” on the unlock screen and enter that key to set a new password. If you left “Let this computer reset my password” on, you can also reset it on the same computer without the key. There is no online account, so no one else can reset it for you.',
  },
  {
    question: 'Is secondHand part of Iowa HHS?',
    answer: 'No. secondHand is independent software and is not affiliated with Iowa HHS. You still apply through Iowa’s official Self-Service Portal.',
  },
  {
    question: 'Which computers and browsers does it work with?',
    answer: 'Windows 10 or later (64-bit) and macOS 13 or later on Apple silicon or Intel Macs, with Google Chrome 116 or newer. The desktop app does not run on phones or tablets.',
  },
] as const;
