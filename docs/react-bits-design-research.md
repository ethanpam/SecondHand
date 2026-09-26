# React Bits design research

Research and implementation: September 26, 2026. The design keeps SecondHand’s forest green, soft white, and sage palette: substantial type, an open card-free hero, numbered instructional rows, and a responsive wordmark. The requested follow-up removes the three-card workflow illustration entirely and introduces a small green bear mascot in the shared branding and favicon.

## Primary sources

- [React Bits index](https://reactbits.dev/get-started/index): browsed the live component catalog and previews before choosing the interactions. The site offers source components, not a single runtime UI kit.
- [Stack](https://reactbits.dev/components/stack), [pinned TypeScript source](https://github.com/DavidHDev/react-bits/blob/5d0c00e7594c898e989b250d022806961f4c8478/src/ts-default/Components/Stack/Stack.tsx): originally informed a three-step workflow illustration. The user subsequently requested removing it. Its component, controls, styles, and unused Motion dependency have been removed; it is not part of the current website.
- [Variable Proximity](https://reactbits.dev/text-animations/variable-proximity), [pinned TypeScript source](https://github.com/DavidHDev/react-bits/blob/5d0c00e7594c898e989b250d022806961f4c8478/src/ts-default/TextAnimations/VariableProximity/VariableProximity.tsx): interpolates font axes using each letter’s distance from the pointer. Adapted in `website/app/variable-wordmark.tsx` to a single weight axis, local pointer events, and a demand-driven animation frame. Unlike the reference, it does not keep a continuous frame loop running or listen to every pointer movement on the page.
- [Bricolage Grotesque / Fontsource](https://fontsource.org/fonts/bricolage-grotesque): provides a variable sans-serif with weight, width, and optical-size axes. This implementation self-hosts the weight-variable font (200–800), pairing it with the existing self-hosted Geist body text. It does not load the previous Instrument Serif.
- [React Bits license at the pinned revision](https://github.com/DavidHDev/react-bits/blob/5d0c00e7594c898e989b250d022806961f4c8478/LICENSE.md): MIT plus a Commons Clause restriction, not plain MIT. The full upstream license is preserved in `website/public/react-bits-license.txt` and ships at `/react-bits-license.txt`; these adaptations are embedded in the website, not distributed as a standalone component library.

## Deliberate adaptations

The remaining wordmark interaction is decorative and resets on pointer exit or motion disable; it has no cursor-following beam or trail. Its displayed spelling is SecondHand, matching the navigation, visible copy, metadata, and structured data. Existing installer filenames retain their original casing to preserve working download URLs.

The original shader remains behind the header and fades into the page without a boxed boundary. One homepage control governs the shader and wordmark. Essential content remains visible without JavaScript. The [mascot generation note](secondhand-mascot.md) records the requested skill, palette, exact prompt, and original asset.

## What was intentionally excluded

No purple/blue palette, gradient text, heading emojis or badges, Inter, colored-border or glass cards, low-contrast dark theme, three-column icon-card features, icon-library dependency, default shadcn UI, scroll reveals/fades, cursor beams, hover opacity fades, italic serif accents, or Space Grotesk/Instrument Serif pairing. Setup instructions remain substantive, in numbered rows rather than three feature cards. There is no scroll hijacking. Copy describes the actual Iowa SNAP workflow and retains unsigned-build warnings, manual submission boundaries, and privacy disclosures.

Review captures and motion previews live in `docs/screenshots/shader-gradient/`; the directory is retained so the existing PR’s visual history stays together.
