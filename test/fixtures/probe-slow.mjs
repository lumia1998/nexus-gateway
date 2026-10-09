// Exits successfully after a delay, standing in for an agent CLI whose
// availability probe is much slower than a plain shell command.
const delay = Number(process.argv[2] || 800)
setTimeout(() => process.exit(0), delay)
