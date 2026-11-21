// How tests read `skydeck doctor`'s report (design 8): groups, each a heading and its check lines,
// a blank line between them, then a blank line, the verdict and each problem line again.

/** The report's parts: each group's heading and lines, and the verdict with its lines. */
export interface DoctorReport {
  groups: { heading: string; lines: string[] }[];
  verdict: string;
  /** The problem lines repeated under the verdict. */
  repeated: string[];
}

/** Splits doctor's standard output into its groups and its verdict. */
export function doctorReport(stdout: string): DoctorReport {
  const blocks = stdout
    .replace(/\n$/, '')
    .split('\n\n')
    .map((block) => block.split('\n'));
  const last = blocks.pop() ?? [];
  return {
    groups: blocks.map(([heading = '', ...lines]) => ({ heading, lines })),
    verdict: last[0] ?? '',
    repeated: last.slice(1),
  };
}

/** Every check line of the report, in order: no heading, no blank line, nothing of the verdict. */
export function reportLines(stdout: string): string[] {
  return doctorReport(stdout).groups.flatMap((group) => group.lines);
}
