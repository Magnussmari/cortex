/**
 * Shared presentation caps for dispatch.task terminal envelopes.
 *
 * The envelope constructors deliberately accept caller-provided strings:
 * each harness knows its substrate result shape. These helpers keep the
 * principal-facing lifecycle summaries consistent across harnesses.
 */

/**
 * Trim error messages so verbose stacks do not blow downstream worklog
 * limits. 500 chars matches the `system.inbound.failed` convention.
 */
export function truncateDispatchErrorSummary(msg: string): string {
  return msg.length > 500 ? msg.slice(0, 497) + "..." : msg;
}

/**
 * Trim result summaries to the first useful line. PAI-formatted chat replies
 * start with status chrome, so prefer the first content-bearing line.
 */
export function truncateDispatchResultSummary(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) =>
    !line.startsWith("══")
    && !/^[-= ]*PAI\b/i.test(line)
    && !line.startsWith("TASK:")
    && !line.startsWith("VERIFY:")
    && !line.startsWith("🗒️")
    && !line.startsWith("✅")
  ) ?? lines[0] ?? text;
  return first.length > 1000 ? first.slice(0, 997) + "..." : first;
}
