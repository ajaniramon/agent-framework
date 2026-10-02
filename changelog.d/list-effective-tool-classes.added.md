- Operators can see each tool's effective MCPL class (RFC-008 §6):
  `listMcplServers()` entries gain `toolClasses` (every tool of that server,
  with its class and whether it came from an operator override, the
  server's own `_meta["mcpl/class"]`, or nowhere — unclassed), and the new
  `listToolClasses()` lists every tool the framework offers, host built-ins
  included, with the same source and the MCPL server where there is one.
