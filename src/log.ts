// Single stderr logger — stdout is the MCP transport, so diagnostics must
// never touch it.
export function log(msg: string): void {
  process.stderr.write(`zalo channel: ${msg}\n`)
}
