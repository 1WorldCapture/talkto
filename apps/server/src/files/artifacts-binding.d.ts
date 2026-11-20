// No shipped configuration binds Artifacts: hosted TalkTo retired Git sharing on 2026-11-16 and
// the production preflight refuses the binding. The store stays for a deliberate re-binding and
// can go once the namespaces are deleted; the binding is optional here and probed at composition.
interface Env {
  readonly ARTIFACTS?: Artifacts;
}
