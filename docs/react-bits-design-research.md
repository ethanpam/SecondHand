# React Bits design research

Research and implementation: September 26, 2026. The design keeps secondHand’s forest green, soft white, and sage palette. The direction is tangible paperwork rather than a generic software dashboard: substantial type, a small interactive paper deck, open instructional rows, and a responsive wordmark.

## Primary sources

- [React Bits index](https://reactbits.dev/get-started/index): browsed the live component catalog and previews before choosing the interactions. The site offers source components, not a single runtime UI kit.
- [Stack](https://reactbits.dev/components/stack), [pinned TypeScript source](https://github.com/DavidHDev/react-bits/blob/5d0c00e7594c898e989b250d022806961f4c8478/src/ts-default/Components/Stack/Stack.tsx): combines Motion values, drag-driven rotation, spring transitions, and reordered cards. Adapted in `website/app/paper-stack.tsx` into a three-step illustration of saving details, approving a request, and reviewing filled fields. The preview is explicitly labeled as an illustration, not the running application.
- [Variable Proximity](https://reactbits.dev/text-animations/variable-proximity), [pinned TypeScript source](https://github.com/DavidHDev/react-bits/blob/5d0c00e7594c898e989b250d022806961f4c8478/src/ts-default/TextAnimations/VariableProximity/VariableProximity.tsx): interpolates font axes using each letter’s distance from the pointer. Adapted in `website/app/variable-wordmark.tsx` to a single weight axis, local pointer events, and a demand-driven animation frame. Unlike the reference, it does not keep a continuous frame loop running or listen to every pointer movement on the page.
- [Bricolage Grotesque / Fontsource](https://fontsource.org/fonts/bricolage-grotesque): provides a variable sans-serif with weight, width, and optical-size axes. This implementation self-hosts the weight-variable font (200–800), pairing it with the existing self-hosted Geist body text. It does not load the previous Instrument Serif.
- [React Bits license at the pinned revision](https://github.com/DavidHDev/react-bits/blob/5d0c00e7594c898e989b250d022806961f4c8478/LICENSE.md): MIT plus a Commons Clause restriction, not plain MIT. The full upstream license is preserved in `website/public/react-bits-license.txt` and ships at `/react-bits-license.txt`; these adaptations are embedded in the website, not distributed as a standalone component library.

## Deliberate adaptations

The deck uses deterministic card positions to avoid random server/client layouts. Native previous/next buttons provide keyboard and touch alternatives to dragging. Inactive cards are hidden from assistive technology. Automatic cycling stops on hover, keyboard focus, reduced motion, the shared pause control, offscreen visibility, and document hiding. Manual controls remain available when motion is disabled, with instantaneous transitions. The wordmark is decorative and resets on pointer exit or motion disable; it has no cursor-following beam or trail.

The original shader remains behind the header and fades into the page without a boxed boundary. One homepage control governs the shader, deck, and wordmark. Essential content remains visible without JavaScript; the decorative deck’s nonfunctional navigation controls are hidden in that mode.

## What was intentionally excluded

No purple/blue palette, gradient text, heading emojis or badges, Inter, colored-border or glass cards, low-contrast dark theme, three-column icon-card features, icon-library dependency, default shadcn UI, scroll reveals/fades, cursor beams, hover opacity fades, italic serif accents, or Space Grotesk/Instrument Serif pairing. Setup instructions remain substantive, in numbered rows rather than three feature cards. There is no scroll hijacking. Copy describes the actual Iowa SNAP workflow and retains unsigned-build warnings, manual submission boundaries, and privacy disclosures.

Review captures and motion previews live in `docs/screenshots/shader-gradient/`; the directory is retained so the existing PR’s visual history stays together.
