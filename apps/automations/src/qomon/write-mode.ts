import type { Env } from '../env.js';
import type { Space } from '../generated/prisma/index.js';

/**
 * The write guard, from gpo/gpo-monolith's live-sending guard. A write
 * reaches Qomon only when all three hold:
 *
 *  1. the environment allows it (`QOMON_WRITES_ALLOWED=true`, set on the
 *     droplet only);
 *  2. the space allows it (`Space.writesEnabled`, change-logged);
 *  3. the run asked for it (`--apply`).
 *
 * Otherwise the run plans and reports but does not write. The env flag is
 * the hard stop: a database copied from the droplet brings its space switch
 * with it, but not the flag.
 */
export interface WriteMode {
  applying: boolean;
  /** why not, when not */
  blockedBy: string[];
}

export function resolveWriteMode(
  env: Env,
  space: Space,
  apply: boolean,
): WriteMode {
  const blockedBy = [
    ...(env.QOMON_WRITES_ALLOWED ? [] : ['QOMON_WRITES_ALLOWED is not true']),
    ...(space.writesEnabled
      ? []
      : [`space ${space.key} has writes turned off`]),
    ...(apply ? [] : ['--apply was not given']),
  ];
  return { applying: blockedBy.length === 0, blockedBy };
}
