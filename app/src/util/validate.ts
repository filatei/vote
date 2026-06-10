import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

const watDateTime = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u, 'Use the date/time picker')
  .optional()
  .or(z.literal(''))
  .transform((v) => (v ? v : undefined));

export const createElectionSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().max(5000).optional().default(''),
  ballotType: z.enum(['single', 'multiple']),
  maxSelections: z.coerce.number().int().min(1).max(50).default(1),
  resultsVisibility: z.enum(['live', 'after_close']),
  // Options arrive as repeated form fields; normalise to a clean array.
  options: z
    .array(z.string().trim().min(1).max(200))
    .min(2, 'Provide at least two options')
    .max(100),
  // Optional scheduled window, entered as WAT wall-clock time.
  opensAt: watDateTime,
  closesAt: watDateTime,
});

export const scheduleSchema = z.object({
  opensAt: watDateTime,
  closesAt: watDateTime,
});

export const generateCodesSchema = z.object({
  count: z.coerce.number().int().min(1).max(50000),
});

/** Coerce a possibly-single form value into a string array. */
export function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}
