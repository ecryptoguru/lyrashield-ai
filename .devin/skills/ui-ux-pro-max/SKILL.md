---
name: ui-ux-pro-max
description: AI-powered design intelligence with 50+ styles, 95+ color palettes, and automated design system generation. Use for comprehensive UI/UX design decisions and design system creation.
when_to_use: "When planning or implementing UI/UX, selecting color palettes, choosing fonts, designing components, or building design systems."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# UI/UX Pro Max

> Comprehensive design guide for web and mobile applications. Contains 50+ styles, 97 color palettes, 57 font pairings, 99 UX guidelines, and 25 chart types across 9 technology stacks.
> **Design with evidence, not taste alone.**

---

## 1. Core Principles

- Start from user goals and mental models, not visual trends
- Consistency is more important than novelty for most interfaces
- Every design decision should have a traceable reason
- Accessibility is not a feature; it is a baseline requirement
- Performance is part of UX: optimize load, render, and interaction time

---

## 2. Design System Foundations

### Colors
- Choose palettes from the curated data files in `.devin/skills/ui-ux-pro-max/data/colors.csv`
- Ensure contrast ratios meet WCAG AA minimums
- Limit primary palette to 3-5 colors; use neutrals for structure
- Reserve semantic colors (success, warning, error, info) consistently

### Typography
- Select font pairings from `.devin/skills/ui-ux-pro-max/data/typography.csv`
- Use a maximum of 2-3 typefaces per project
- Establish a clear type scale: hero, heading, body, caption, label
- Test readability on actual devices, not just design tools

### Spacing and Layout
- Use an 8px base grid for spacing and sizing
- Maintain consistent padding and margin scales
- Responsive breakpoints should be content-based, not device-based
- Maximum line length: 60-75 characters for body text

---

## 3. Component Design

- Design components in isolation, then validate in context
- Every component needs states: default, hover, active, disabled, loading, error
- Document props, behavior, and usage constraints
- Prefer composition over configuration for flexibility

---

## 4. UX Guidelines

### Navigation
- Keep primary navigation to 5-7 items
- Use progressive disclosure for secondary actions
- Provide clear wayfinding: breadcrumbs, page titles, active states

### Forms
- Label every input explicitly; placeholder is not a label
- Group related fields; break long forms into steps
- Validate inline where possible; reserve submit-time validation for server checks
- Show clear error messages that explain how to fix the problem

### Feedback
- Confirm destructive actions before execution
- Show progress for async operations
- Use toast notifications sparingly; prefer inline feedback
- Empty states should guide the user forward, not just say "nothing here"

---

## 5. Accessibility

- Keyboard navigation for all interactive elements
- Focus indicators must be visible
- Screen reader labels for icons, images, and non-text content
- Color is not the only way to convey information
- Test with keyboard only and screen reader at minimum

---

## 6. Responsive and Adaptive

- Mobile-first for most consumer applications
- Touch targets: minimum 44x44px on mobile
- Avoid hover-dependent interactions on touch devices
- Test on real devices, not just browser resizing

---

## 7. Data Resources

Searchable CSV databases in `.devin/skills/ui-ux-pro-max/data/`:

- `colors.csv` — 95+ palettes with accessibility scores
- `charts.csv` — 25 chart types
- `stacks/` — Per-technology recommendations (Next.js, Nuxt, Flutter, etc.)

*Additional data files (typography, styles, UX guidelines) are being migrated into the searchable index.*

Use these for evidence-based design decisions.

---

## 8. Decision Checklist

Before designing:
- [ ] Who is the user and what is their goal?
- [ ] What device and context will they use?
- [ ] Is the palette chosen and contrast-checked?
- [ ] Are component states designed?
- [ ] Is keyboard navigation planned?

Before shipping:
- [ ] Responsive behavior verified on real devices?
- [ ] Accessibility checked (keyboard, screen reader, contrast)?
- [ ] Empty and error states included?
- [ ] Performance impact measured?

---

## 9. Anti-Patterns

- Designing for the portfolio rather than the user
- Inconsistent spacing, color, or typography within the same interface
- Relying solely on color to communicate status or state
- Hover-only interactions on mobile
- Breaking accessibility for visual polish
- Copying trends without validating fit for the user base

---

> **Remember:** Great design is felt, not noticed. The user should focus on their goal, not your interface.
