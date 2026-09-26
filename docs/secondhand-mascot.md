# SecondHand mascot

Created September 26, 2026 using the built-in image-generation tool and the requested [IP as Logo skill](https://github.com/s1dashu/ip-as-logo-skill/blob/acb834c717bcd0a487c49732d08397ba280d690b/SKILL.md).

## Direction

The product is a local-first Iowa SNAP helper, so the character should feel reassuring, approachable, and respectful rather than robotic or governmental. The considered directions were a bear for reassurance, a dog for helpfulness, and a turtle for privacy. The selected direction is a friendly rounded bear, with forest green, soft white, and sage taken from the website.

- Label: A1, reassuring bear.
- Composition: lower-left emergence.
- Asset: `website/public/brand/secondhand-mascot.png`.
- Native dimensions: 1254 × 1254. The original generated PNG is preserved without retouching or resampling.
- Delivery: one image, matching the user's request for one mascot rather than the skill's default six-candidate exploration.
- Provider: built-in `image_gen`; a specific model identifier is not exposed by the tool.
- Constraint delivery: main-prompt constraints, reproduced verbatim below.
- Use: shared header/footer mark and favicon. It does not introduce a new hero card or illustration panel.

## Exact generation prompt

```text
Create one complete full-bleed 1:1 square image, approximately 1536 × 1536.
Background: fill the entire square with solid gently muted pale sage green #d7e6cf. Keep this sage visible in every open area and in the corners not occupied by the character; the lower-left emergence corner must be occupied by the character.
Subject: one extremely simplified, cute, endearing bear character. Its calm friendly personality expresses a dependable helping hand that respects people's privacy. Reduce it to one soft rounded continuous forest-green silhouette and a single defining feature: two broad round bear ears, both clearly visible. Give it an oversized head, compact proportions, and soft cheeks.
Complexity: use only 4–7 large basic shapes and at most two broad internal color regions. A single broad soft-white face-and-muzzle region contains two small widely spaced forest-green eyes and one tiny rounded forest-green mouth. Remove every nonessential line, outline, anatomical detail, texture, and decoration. Keep the character readable at 32 × 32.
Color behavior: exactly three semantic colors: forest green #164c38 for the bear's main silhouette and facial marks, soft white #f8faf7 for one broad continuous face region, and pale sage #d7e6cf for the background. Keep the silhouette, facial marks, and background clearly separated.
Composition: keep the bear upright and emerging from the lower-left, filling about 85–95% of the square. Cropping the compact body at the bottom or left is welcome. Preserve both ears fully. Never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```
