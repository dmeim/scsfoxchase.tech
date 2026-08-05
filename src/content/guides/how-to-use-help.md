---
title: How to use this Help site
description: Reference guide for Forms, Guides, and how we cite external sources
featured: true
sources:
  - id: "1"
    title: "Astro Content Collections"
    url: "https://docs.astro.build/en/guides/content-collections/"
    note: "How we store guide articles as Markdown with typed frontmatter."
  - id: "2"
    title: "MDN — Citing sources / footnotes pattern"
    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/sup"
    note: "Superscript markers link in-body claims to the Sources list."
---

This page is the **authoring reference** for future Help guides. Copy its structure when you add a new article under `src/content/guides/`.

## Forms vs Guides

- **Forms** are interactive requests (game suggestions, tech help, account help). Open one from Help or the Forms catalog, fill it in, and submit.
- **Guides** are short articles that explain how to do something. They may include material adapted from external docs or articles.

Use a form when you need staff to take action. Use a guide when you need instructions or background.

## How Guides are structured

Each guide is a Markdown file with frontmatter:

1. `title` and `description` — used for catalogs, the browser tab, and (when a diagram is present) a visually hidden page heading
2. `featured` — when `true`, the guide appears on the Help hub
3. `sources` — list of external citations (optional)

The article body uses normal headings and paragraphs. When a sentence draws on an outside source, mark it with a superscript that matches a `sources` entry.

## Optional title-card diagram

Guides currently mount a normal tldraw canvas in the title card (stock `<Tldraw />`). Loading a sibling `.tldraw` file will come back once that baseline is solid.

## Citing external sources

Claims adapted from elsewhere get a superscript number in the text, like this statement about content collections<sup class="guide-fn"><a href="#source-1">1</a></sup> and this note about superscript markup<sup class="guide-fn"><a href="#source-2">2</a></sup>.

Rules for authors:

- Only cite material that came from an external page or document
- Keep school-written instructions unmarked
- Every superscript `N` must have a matching `sources` entry with `id: "N"`
- Prefer a stable URL; add a short `note` when the title alone is unclear

The **Sources** section at the bottom of the page is generated from frontmatter — do not duplicate it in the Markdown body.

## Adding a new guide later

1. Create `src/content/guides/<slug>.md` using this file as the template
2. Optionally add `src/content/guides/<slug>.tldraw` (edit in tldraw Desktop)
3. Set `featured: true` only if it should appear on `/help`
4. Link footnotes in the body with `<sup class="guide-fn"><a href="#source-N">N</a></sup>`
5. Fill `sources` in frontmatter so the rendered Sources list stays accurate

The guide will show up automatically on `/guides` and at `/guide/<slug>`.
