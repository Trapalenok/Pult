declare module 'ssh2/lib/protocol/constants.js' {
  // CommonJS module whose exports are built at runtime, so only a default import works under both Node ESM and the bundle.
  const constants: Record<string, string[]>
  export default constants
}
