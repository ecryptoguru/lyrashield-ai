---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
when_to_use: "When auditing web UI for best practices, checking accessibility, or reviewing design against Web Interface Guidelines."
allowed-tools: Read, Grep, Glob
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
effort: low
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Fetch the latest guidelines from the source URL below
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the fetched guidelines
4. Output findings in the terse `file:line` format

## Guidelines Source

Fetch fresh guidelines before each review:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Use WebFetch to retrieve the latest rules. The fetched content contains all the rules and output format instructions.

---

## Fallback Guidelines (Offline / Failover Checklist)

If live-fetching fails, apply these core Web Interface Guidelines:

### 1. Accessibility (A11y)

- **Contrast**: Text must have a minimum contrast ratio of 4.5:1 (3:1 for large text).
- **Alt Text**: All `<img>` elements must have an `alt` attribute or `role="presentation"`.
- **Interactivity**: All interactive elements (`<button>`, `<a>`) must be keyboard navigable and focusable.
- **Form Labels**: Every input must have an associated `<label>` or `aria-label`.

### 2. Performance & Images

- **Next.js Image**: Always use `next/image` (`Image` component) for optimal layout stability and compression.
- **Priority**: Add the `priority` attribute to above-the-fold/LCP images.
- **Web Vitals**: Ensure layout stability by specifying `width` and `height` or `fill` with parent `position: relative`.

### 3. Responsive Design & Touch

- **Breakpoints**: Use mobile-first design (`md:`, `lg:` in Tailwind).
- **Touch Targets**: Interactive targets must be at least 44x44px for mobile devices.
- **Scroll**: Horizontal scroll segments should use `.custom-scrollbar` and responsive swipe helpers on overflow tables.

### 4. Layout & Typography

- **Hierarchy**: Limit page font sizes to 3-4 distinct scales to prevent cognitive fatigue.
- **Loading States**: Skeletons or spinners must match the exact dimensions of the loaded content to prevent Layout Shift.

---

## Usage

When a user provides a file or pattern argument:

1. Fetch guidelines from the source URL above
2. Read the specified files
3. Apply all rules from the fetched guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.

---

## Related Skills

| Skill                                              | When to Use                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| **[frontend-design](../frontend-design/SKILL.md)** | Before coding - Learn design principles (color, typography, UX psychology) |
| **web-design-guidelines** (this)                   | After coding - Audit for accessibility, performance, and best practices    |

## Design Workflow

```
1. DESIGN   → Read frontend-design principles
2. CODE     → Implement the design
3. AUDIT    → Run web-design-guidelines review ← YOU ARE HERE
4. FIX      → Address findings from audit
```
