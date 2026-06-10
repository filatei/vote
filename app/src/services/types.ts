export type BallotType = 'single' | 'multiple';
export type ElectionStatus = 'draft' | 'open' | 'closed';
export type ResultsVisibility = 'live' | 'after_close';
export type AccessMode = 'code' | 'open';

export interface Option {
  id: number;
  election_id: number;
  label: string;
  description: string;
  image_path: string | null;
  position: number;
}

export interface Election {
  id: number;
  public_id: string;
  title: string;
  description: string;
  ballot_type: BallotType;
  max_selections: number;
  access_mode: AccessMode;
  status: ElectionStatus;
  results_visibility: ResultsVisibility;
  opens_at: Date | null;
  closes_at: Date | null;
  owner_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface Customer {
  id: number;
  email: string;
}

export interface ElectionWithOptions extends Election {
  options: Option[];
}

export interface TallyRow {
  option_id: number;
  label: string;
  votes: number;
}

export interface Tally {
  totalBallots: number;
  rows: TallyRow[];
}
