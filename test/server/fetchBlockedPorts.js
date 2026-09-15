// Ports the Fetch standard forbids a fetch() from connecting to
// (https://fetch.spec.whatwg.org/#port-blocking, "a bad port"). Node's built-in fetch (undici) enforces
// this exact list, so a listen(0) ephemeral port that happens to land on one of these makes fetch() throw
// TypeError: fetch failed / cause 'bad port' even though the server itself is up and listening fine.
// This is the WHATWG Fetch "bad port" list, cross-checked by the reviewer against the `badPorts` array
// bundled in the installed Node v22.23.2 / undici 6.28.0 (82 ports) — not derived by scanning. The data
// itself now lives in src/core/browserUnsafePorts.js (the same list the desktop shell's Rust settings
// parser reads), so this file just names it for the fixtures that used to define it locally. Re-derive the
// underlying list if Node's fetch implementation ever changes its port-blocking table.
export { BROWSER_UNSAFE_PORTS as FETCH_BLOCKED_PORTS, isBrowserUnsafePort as isFetchBlockedPort } from '../../src/core/browserUnsafePorts.js';
