import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const games = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/games' }),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    image: z.string(),
    description: z.string(),
    minGrade: z.number(),
    maxGrade: z.number(),
    primaryCategories: z.array(z.string()),
    secondaryCategories: z.array(z.string()),
  }),
});

const guideSource = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url().optional(),
  note: z.string().optional(),
});

const guides = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** Show on /help Guides section */
    featured: z.boolean().default(false),
    /** External/scraped citations — rendered as Sources footnotes */
    sources: z.array(guideSource).default([]),
  }),
});

export const collections = { games, guides };
