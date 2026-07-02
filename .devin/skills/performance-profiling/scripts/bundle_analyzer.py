#!/usr/bin/env python3
"""
Bundle Analyzer - AG Kit
=========================

Analyzes client-side bundle size and warns on bloat.

Usage:
    python .devin/skills/performance-profiling/scripts/bundle_analyzer.py <project_path>
"""

import sys
import subprocess
from pathlib import Path

def main():
    if len(sys.argv) < 2:
        print("Usage: bundle_analyzer.py <project_path>")
        sys.exit(1)

    project = Path(sys.argv[1]).resolve()
    if not project.exists():
        print(f"Project not found: {project}")
        sys.exit(1)

    # Check for Next.js build output
    next_build = project / ".next"
    if not next_build.exists():
        print("No .next build output found — run build first")
        sys.exit(0)

    print("Bundle analysis placeholder: check .next/static for oversized chunks")
    sys.exit(0)

if __name__ == "__main__":
    main()
