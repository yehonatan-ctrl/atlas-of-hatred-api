// Contract-only types for the Verify Nearby API.
// Keep these aligned with the review artifact until schema approval lands.

export const VERIFY_NEARBY_SUBMISSION_CATEGORIES = [
  'personal_testimony',
  'eyewitness_with_evidence',
  'news_article_link',
] as const;

export type VerifyNearbySubmissionCategory =
  (typeof VERIFY_NEARBY_SUBMISSION_CATEGORIES)[number];

export const VERIFY_NEARBY_INCIDENT_TYPES = [
  'verbal_harassment',
  'physical_assault',
  'vandalism',
  'online_threat',
  'institutional_discrimination',
  'other',
] as const;

export type VerifyNearbyIncidentType =
  (typeof VERIFY_NEARBY_INCIDENT_TYPES)[number];

export const VERIFY_NEARBY_VERIFICATION_METHODS = [
  'cross_witness',
  'linked_source',
  'evidence',
  'unverified',
] as const;

export type VerifyNearbyVerificationMethod =
  (typeof VERIFY_NEARBY_VERIFICATION_METHODS)[number];

export const VERIFY_NEARBY_VERIFICATION_STATUSES = [
  'pending',
  'supporting_only',
  'cross_validated',
  'ignored',
  'needs_review',
] as const;

export type VerifyNearbyVerificationStatus =
  (typeof VERIFY_NEARBY_VERIFICATION_STATUSES)[number];

export const VERIFY_NEARBY_REPORT_ISSUE_STATUSES = [
  'none',
  'open',
  'triaged',
  'resolved',
  'rejected',
] as const;

export type VerifyNearbyReportIssueStatus =
  (typeof VERIFY_NEARBY_REPORT_ISSUE_STATUSES)[number];

export const VERIFY_NEARBY_VERIFIER_CHOICES = [
  'i_was_there',
  'not_sure',
  'skip',
] as const;

export type VerifyNearbyVerifierChoice =
  (typeof VERIFY_NEARBY_VERIFIER_CHOICES)[number];

export interface VerifyNearbyLocationSummary {
  city: string | null;
  area: string | null;
  country_code: string | null;
}

export interface VerifyNearbyTimeWindow {
  start: string | null;
  end: string | null;
  label: string;
}

export interface VerifyNearbyCandidateCard {
  id: string;
  testimony_id: string;
  submission_category: VerifyNearbySubmissionCategory;
  incident_type: VerifyNearbyIncidentType;
  status: string;
  location: VerifyNearbyLocationSummary;
  time_window: VerifyNearbyTimeWindow;
  short_excerpt: string;
  evidence_marker: string | null;
  source_url: string | null;
  linked_incident_id: string | null;
  verification_method: VerifyNearbyVerificationMethod;
  verification_status: VerifyNearbyVerificationStatus;
  report_issue_status: VerifyNearbyReportIssueStatus;
  created_at: string;
  updated_at: string;
}

export interface VerifyNearbyCandidatesQuery {
  user_id: string;
  radius_km?: number;
  city_or_place?: string;
  country_code?: string;
  time_filter?: 'today' | 'yesterday' | '7_days' | 'pick_a_date';
  date?: string;
  limit?: number;
}

export interface VerifyNearbyVerifyRequest {
  user_id: string;
  verifier_choice: VerifyNearbyVerifierChoice;
  what_did_you_see?: string;
  when_approx?: 'within_window' | 'earlier' | 'later' | 'not_sure';
  where_approx?: 'city_only' | 'area' | 'very_near';
  evidence_note?: string;
  evidence_url?: string;
}

export interface VerifyNearbyReportIssueRequest {
  user_id: string;
  issue_type: string;
  details: string;
}
