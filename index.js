/**
 * Host half of the off-peak send bundle.
 *
 * Every decision (peak-window clock checks, queueing, sending) happens in the
 * Client half, so the Host only needs a live row for the bundle.
 */
export function apply() {}
