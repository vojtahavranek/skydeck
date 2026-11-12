# skydeck

Desktop deck for Claude Code sessions: jump, resume, notes, PRs

## Development

Needs Node.js 24.12 or newer. TypeScript runs directly through Node's type stripping, so there is
no build step.

```sh
npm ci
npm run check   # format check, type check, then the tests
npm run format  # rewrite files with Prettier
```

Run the CLI from a checkout with `bin/skydeck --help`. If the `node` on your `PATH` is older than
24.12, point skydeck at a newer binary with `SKYDECK_NODE=/path/to/node`.

A command is one file, `src/cli/commands/<name>.ts`, that exports `command` (see
`src/cli/command.ts`); adding one does not edit any shared file. Tests mirror the source tree under
`test/`, and use the helpers in `test/helpers/`, which give every child process a temporary `HOME`
and `SKYDECK_HOME`.

The design is in [docs/design.md](docs/design.md).
