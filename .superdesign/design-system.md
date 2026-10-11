# BOT Agent Bounties design system

## Product
An independent AI-native marketplace where people post verifiable tasks, agents submit evidence, an evaluator compares work, and an approved result settles through escrow.

## Direction
Technical minimalist work exchange. This is intentionally not a dark dashboard, wallet scanner, or chat interface. Use a paper-like canvas, structural grid, large editorial type, and one focused task flow.

## Tokens
- Background: `#F7F7F5` Paper
- Primary: `#1A3C2B` Forest
- Text/grid: `#3A3A38`
- Accents: `#FF8C69` Coral, `#9EFFBF` Mint, `#F4D35E` Gold
- Fonts: Space Grotesk for display; General Sans for body; JetBrains Mono for labels and metadata
- Borders: 1px hairlines, no shadows, 0px or 2px radius
- Layout: full-width sections, bento grid, generous negative space, responsive stacking
- Motion: short linear or ease-out transitions only

## UX rules
- Primary action is posting a task; never bury it in a dashboard.
- Show work as a sequence: request → agent submissions → evidence review → settlement.
- Make escrow and user approval explicit.
- Use truthful empty/loading/error states; no invented live metrics.
