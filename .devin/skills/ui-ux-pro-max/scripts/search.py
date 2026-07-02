#!/usr/bin/env python3
"""
UI/UX Pro Max — Design System Search
Searches curated design databases for colors, typography, styles, and UX guidelines.
"""

import argparse
import csv
import os
import re
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"


def load_csv(filename):
    """Load CSV data file."""
    path = DATA_DIR / filename
    if not path.exists():
        return []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return list(reader)


def score_match(row, query_words):
    """Score how well a row matches query words."""
    text = ' '.join(str(v).lower() for v in row.values())
    score = sum(1 for w in query_words if w in text)
    # Boost exact matches in name/title fields
    for key in ('palette_name', 'pairing_name', 'style_name', 'name', 'title'):
        if key in row:
            for w in query_words:
                if w in str(row[key]).lower():
                    score += 2
    return score


def search_domain(domain, query, max_results=5):
    """Search a specific domain."""
    query_words = query.lower().split()
    results = []

    domain_files = {
        'color': 'colors.csv',
        'colors': 'colors.csv',
        'typography': 'typography.csv',
        'font': 'typography.csv',
        'fonts': 'typography.csv',
        'style': 'styles.csv',
        'styles': 'styles.csv',
        'ux': 'ux_guidelines.csv',
        'guideline': 'ux_guidelines.csv',
        'guidelines': 'ux_guidelines.csv',
        'chart': 'charts.csv',
        'charts': 'charts.csv',
    }

    filename = domain_files.get(domain.lower())
    if not filename:
        return []

    rows = load_csv(filename)
    scored = [(score_match(row, query_words), row) for row in rows]
    scored.sort(key=lambda x: x[0], reverse=True)
    return [row for score, row in scored if score > 0][:max_results]


def search_all(query, max_results=5):
    """Search across all domains."""
    query_words = query.lower().split()
    all_results = []
    for filename in ['colors.csv', 'typography.csv', 'styles.csv', 'ux_guidelines.csv', 'charts.csv']:
        rows = load_csv(filename)
        for row in rows:
            score = score_match(row, query_words)
            if score > 0:
                row['_score'] = score
                row['_domain'] = filename.replace('.csv', '')
                all_results.append(row)
    all_results.sort(key=lambda x: x['_score'], reverse=True)
    return all_results[:max_results]


def format_design_system(results, project_name="", fmt="ascii"):
    """Format results as design system output."""
    colors = [r for r in results if r.get('_domain') == 'colors']
    typography = [r for r in results if r.get('_domain') == 'typography']
    styles = [r for r in results if r.get('_domain') == 'styles']
    ux = [r for r in results if r.get('_domain') == 'ux_guidelines']

    if fmt == 'markdown':
        lines = [f"# Design System{' — ' + project_name if project_name else ''}", ""]
    else:
        lines = [f"╔{'═' * 76}╗", f"║{' Design System':76}║", f"╠{'═' * 76}╣"]
        if project_name:
            lines.insert(2, f"║ Project: {project_name:<67}║")

    def add_section(title, items, fmt):
        if not items:
            return
        if fmt == 'markdown':
            lines.append(f"## {title}")
            for item in items[:3]:
                lines.append(f"- **{item.get('palette_name') or item.get('pairing_name') or item.get('style_name') or item.get('name', 'N/A')}**: {item.get('notes', '')}")
            lines.append("")
        else:
            lines.append(f"║ {title:<74} ║")
            lines.append(f"║{'─' * 76}║")
            for item in items[:3]:
                name = item.get('palette_name') or item.get('pairing_name') or item.get('style_name') or item.get('name', 'N/A')
                notes = item.get('notes', '')[:50]
                lines.append(f"║ • {name:<30} | {notes:<40} ║")
            lines.append(f"║{' ' * 76}║")

    add_section("Color Palette", colors, fmt)
    add_section("Typography", typography, fmt)
    add_section("Component Style", styles, fmt)
    add_section("UX Guidelines", ux, fmt)

    if fmt != 'markdown':
        lines.append(f"╚{'═' * 76}╝")

    return '\n'.join(lines)


def persist_design_system(results, project_name, page=None):
    """Save design system to design-system/ directory."""
    ds_dir = Path("design-system")
    ds_dir.mkdir(exist_ok=True)
    (ds_dir / "pages").mkdir(exist_ok=True)

    master_path = ds_dir / "MASTER.md"
    with open(master_path, 'w', encoding='utf-8') as f:
        f.write(format_design_system(results, project_name, fmt='markdown'))
    print(f"Saved: {master_path}")

    if page:
        page_path = ds_dir / "pages" / f"{page}.md"
        with open(page_path, 'w', encoding='utf-8') as f:
            f.write(f"# {page.title()} — Design Overrides\n\n")
            f.write("Override rules for this page go here.\n")
        print(f"Saved: {page_path}")


def main():
    parser = argparse.ArgumentParser(description="UI/UX Pro Max Design System Search")
    parser.add_argument("query", help="Search query (e.g., 'beauty spa elegant')")
    parser.add_argument("--design-system", action="store_true", help="Generate complete design system")
    parser.add_argument("--domain", help="Search specific domain: color, typography, style, ux, chart")
    parser.add_argument("--stack", help="Get stack guidelines: html-tailwind, react, nextjs, vue, svelte")
    parser.add_argument("--persist", action="store_true", help="Save design system to design-system/")
    parser.add_argument("-p", "--project", default="", help="Project name")
    parser.add_argument("--page", help="Page name for override file")
    parser.add_argument("-n", type=int, default=5, help="Max results (default: 5)")
    parser.add_argument("-f", "--format", choices=["ascii", "markdown"], default="ascii", help="Output format")
    args = parser.parse_args()

    if args.stack:
        # Stack guidelines are generic recommendations
        stacks = {
            "html-tailwind": "Tailwind utilities, responsive, a11y. Use @apply sparingly.",
            "react": "Hooks, memo, lazy loading. Avoid prop drilling.",
            "nextjs": "SSR/SSG, Image optimization, API routes. Use App Router.",
            "vue": "Composition API, Pinia, Vue Router. Avoid Options API.",
            "svelte": "Runes, stores, SvelteKit. Minimal boilerplate.",
            "shadcn": "shadcn/ui components, theming, forms. Copy, don't install.",
        }
        info = stacks.get(args.stack.lower(), "General web best practices.")
        print(f"Stack: {args.stack}")
        print(f"Guidelines: {info}")
        return

    if args.domain:
        results = search_domain(args.domain, args.query, args.n)
        print(f"Results for '{args.query}' in domain '{args.domain}':")
        for r in results:
            name = r.get('palette_name') or r.get('pairing_name') or r.get('style_name') or r.get('name', 'N/A')
            print(f"  • {name}: {r.get('notes', '')}")
    else:
        results = search_all(args.query, args.n)

        if args.design_system:
            output = format_design_system(results, args.project, args.format)
            print(output)
            if args.persist:
                persist_design_system(results, args.project, args.page)
        else:
            print(f"Top matches for '{args.query}':")
            for r in results:
                name = r.get('palette_name') or r.get('pairing_name') or r.get('style_name') or r.get('name', 'N/A')
                domain = r.get('_domain', 'unknown')
                print(f"  [{domain}] {name}: {r.get('notes', '')}")


if __name__ == "__main__":
    main()
