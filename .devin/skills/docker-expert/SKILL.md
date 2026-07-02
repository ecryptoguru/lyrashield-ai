---
name: docker-expert
description: Docker and containerization principles. Image design, multi-stage builds, runtime separation, compose workflows, and operational safety.
when_to_use: "When working with Docker, containerization, multi-stage builds, or docker-compose configurations."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
effort: medium
---

# Docker Expert

> Principles for containerizing applications cleanly, predictably, and with production-aware tradeoffs.
> **Containers should reduce environmental drift, not hide architectural problems.**

---

## 1. Core Principles

- Build minimal images for the actual runtime needs
- Separate build dependencies from runtime dependencies
- Keep images reproducible and cache-friendly
- Use containers to standardize environments, not to excuse poor observability
- Prefer explicit configuration and health checks

---

## 2. Dockerfile Design

Prefer:

- multi-stage builds
- pinned base image families where operationally justified
- non-root runtime users when practical
- narrow copy steps for better caching
- clear entrypoints and environment expectations

Avoid:

- huge single-stage images
- baking secrets into images
- copying the whole repo blindly when not needed
- mixing dev tooling into production runtime images

---

## 3. Runtime and Compose Principles

- Define service boundaries explicitly
- Treat volumes, networks, and environment variables as first-class design choices
- Use health checks for services that others depend on
- Keep local compose ergonomics separate from production orchestration assumptions
- Document what state is ephemeral vs persistent

---

## 4. Security and Operations

- Never store secrets in Dockerfiles or committed compose files
- Keep attack surface small with lean runtimes
- Understand how image update cadence affects patch risk
- Use rollback-friendly tagging or deployment strategy
- Log and monitor containers as part of the system, not in isolation

---

## 5. Decision Checklist

Before containerizing:

- [ ] Why is Docker the right operational fit here?
- [ ] What belongs in build stage vs runtime stage?
- [ ] Are secrets handled outside the image?
- [ ] Are health checks and startup dependencies defined?
- [ ] Is the image optimized for the actual deployment target?

---

## 6. Anti-Patterns

- Treating Docker as a substitute for deployment design
- Shipping development-only dependencies in production images
- Using one giant compose file for every environment forever
- Running as root without reason
- Ignoring image size, startup time, and patch hygiene

---

> **Remember:** Good containerization makes deployment more predictable. Bad containerization only moves the mess into an image.
