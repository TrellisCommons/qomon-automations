export interface PlannedCounts {
  plannedWrites?: number;
  planned?: number;
  remarks?: number;
  deceasedPlanned?: number;
}

/** The writes a run planned, as the write limit counts them, then by rule. */
export function describePlanned(s: PlannedCounts): string {
  return `${s.plannedWrites ?? '?'} writes (${s.planned ?? 0} household, ${s.remarks ?? 0} re-marks, ${s.deceasedPlanned ?? 0} do not contact)`;
}
