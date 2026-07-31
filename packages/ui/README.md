# @lyrashield/ui

Shared React UI components and Tailwind utilities used by LyraShield apps.

## Purpose

- Provides a small, reusable component library: `Button`, `Card`, `Badge`, `Switch`, `EmptyState`, `Spinner`, `FormField`, `Input`, `Select`, `Textarea`, `LoadMore`.
- Exports `cn` for merging Tailwind classes, plus provider icons (`GithubIcon`, `GoogleIcon`, `MicrosoftIcon`).
- Used by `apps/web` and marketing surfaces where shared React components are rendered.

## Main exports

- `cn`, `GithubIcon`, `GoogleIcon`, `MicrosoftIcon`
- `Button`, `buttonVariants`, `Card`, `CardHeader`, `CardTitle`, `CardContent`, `CardFooter`
- `Badge`, `badgeVariants`, `Switch`
- `EmptyState`, `Spinner`, `FormField`, `Input`, `Select`, `Textarea`, `LoadMore`

## Peer dependencies

- `react` ^19.0.0
- `react-dom` ^19.0.0
- `tailwindcss` ^4.3.3

## See also

- `apps/web` for dashboard usage.
