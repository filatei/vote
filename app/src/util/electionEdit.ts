import { Request } from 'express';
import { createElectionSchema, toArray } from './validate';
import { ElectionWithOptions } from '../services/types';

export interface EditOptionData {
  id: number | null;
  label: string;
}
export interface EditData {
  title: string;
  description: string;
  ballotType: 'single' | 'multiple';
  maxSelections: number;
  accessMode: 'code' | 'open' | 'hybrid';
  resultsVisibility: 'live' | 'after_close';
  options: EditOptionData[];
}

/** Prefill data for the edit form from the current election. */
export function editDataFromElection(election: ElectionWithOptions): EditData {
  return {
    title: election.title,
    description: election.description,
    ballotType: election.ballot_type,
    maxSelections: election.max_selections,
    accessMode: election.access_mode,
    resultsVisibility: election.results_visibility,
    options: election.options.map((o) => ({ id: o.id, label: o.label })),
  };
}

/**
 * Parse + validate the edit form. Options arrive as paired optionId[]/option[]
 * arrays; empty labels are dropped (an existing one becomes a deletion).
 */
export function parseEditForm(
  req: Request,
): { ok: true; data: EditData } | { ok: false; data: EditData; error: string } {
  const labels = toArray(req.body.option).map((s) => String(s).trim());
  const ids = toArray(req.body.optionId).map((s) => String(s));
  const options: EditOptionData[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const rawId = ids[i] || '';
    options.push({ id: /^\d+$/.test(rawId) ? Number(rawId) : null, label: labels[i] });
  }

  const data: EditData = {
    title: String(req.body.title || '').trim(),
    description: String(req.body.description || '').trim(),
    ballotType: req.body.ballotType,
    maxSelections: Number(req.body.maxSelections) || 1,
    accessMode: req.body.accessMode,
    resultsVisibility: req.body.resultsVisibility,
    options,
  };

  const parsed = createElectionSchema.safeParse({
    ...data,
    options: options.map((o) => o.label),
    opensAt: '',
    closesAt: '',
  });
  if (!parsed.success) {
    return { ok: false, data, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return {
    ok: true,
    data: {
      ...data,
      ballotType: parsed.data.ballotType,
      maxSelections: parsed.data.maxSelections,
      accessMode: parsed.data.accessMode,
      resultsVisibility: parsed.data.resultsVisibility,
    },
  };
}
