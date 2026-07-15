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

export const collections = { games };
