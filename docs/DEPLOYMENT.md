# Deployment

## The server is a self-contained deployable unit

`apps/server/` requires nothing outside itself. It has no `"workspace:"`
or `"*"`-protocol dependencies, no `extends` reference to a parent
`tsconfig.json`, and no import of `@chameleon/*` packages. You can copy
this one directory anywhere - a separate repo, a Docker build context, a
PaaS deploy folder - and it works:

```bash
cp -r apps/server /somewhere/else
cd /somewhere/else
npm install
npm run build
npm start
```

This was verified for real during development: `apps/server` was copied
into a completely isolated directory (no monorepo, no `packages/`, no
shared `node_modules`), `npm install` was run fresh, and the compiled
output was executed with `node --no-experimental-strip-types` (i.e. on a
Node runtime with zero TypeScript support) - including a full
`/api/v1/reason` request through the actual demo scenario. It worked
correctly, proving the folder has no hidden dependency on the rest of the
repository.

## Why this required inlining two small packages

The server only ever used two of the monorepo's shared packages:

- `@chameleon/action-dsl` - the restricted action schema (`CLICK`,
  `SCROLL`, `TYPE`, ...)
- `@chameleon/protocol` - the sanitized wire-format schema and the
  server-side PII sanity re-scan

Both are pure Zod schema definitions with no dependency on the browser
extension's code (no DOM, no `chrome.*` APIs, nothing extension-specific).
They're now duplicated at `apps/server/src/shared/action-dsl.ts` and
`apps/server/src/shared/protocol.ts`, imported via plain relative paths
instead of the `@chameleon/*` workspace protocol.

**Everything else stays as it was.** The browser extension, the root test
suite, and the benchmark still use `packages/action-dsl` and
`packages/protocol` (and the other four shared packages -
`shared-types`, `privacy-policy`, `screen-state`, `evaluation` - which the
server never needed and which stayed in `packages/` unchanged) via the
normal npm-workspaces mechanism. Nothing about running the whole monorepo
together (`npm install` at the root, `npm test`, `npm run build`) changed.

## The tradeoff: two copies that can drift

This is a real tradeoff, not a free lunch. `apps/server/src/shared/action-dsl.ts`
and `packages/action-dsl/src/index.ts` are now two separate files with
identical content at the time of writing. If the Action DSL changes (a
new action type, a new field), **both copies must be updated**, or the
server and the extension will silently disagree about what a valid action
looks like.

Both inlined files carry a header comment saying exactly this. There is
no automated check in this repository that keeps them in sync - if you
maintain this project long-term and change the DSL or the protocol
schema, treat updating both locations as part of that change, the same
way you'd treat updating a shared API contract split across two
repositories.

**If you'd rather not carry this tradeoff:** the alternative is to
publish `@chameleon/action-dsl` and `@chameleon/protocol` to a real npm
registry (public or private) and have `apps/server` depend on the
published version instead of a workspace link or an inlined copy. That
removes the duplication at the cost of needing a real package registry
and a version-bump/publish step whenever the schema changes - reasonable
for a team, overkill for a hackathon prototype, which is why this
repository uses the simpler inlined-copy approach instead.

## What did NOT move into the server

The extension's own workspace (`apps/extension`) still depends on
`packages/shared-types`, `packages/privacy-policy`, `packages/screen-state`,
`packages/action-dsl`, and `packages/protocol` exactly as before - none of
that changed, and the extension is not independently deployable as a
single folder the way the server now is (it still needs the monorepo's
`packages/*` at build time via npm workspaces). If you also need the
extension to build as a fully standalone folder, apply the same inlining
approach to whichever of its five package dependencies it actually uses.
