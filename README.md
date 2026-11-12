# skydeck

Desktop deck for Claude Code sessions: jump, resume, notes, PRs

## Development

Needs Node.js 24.12 or newer. TypeScript runs directly through Node's type stripping, so there is
no build step.

```sh
npm ci
npm run check   # type check, then the tests
```

Run the CLI from a checkout with `bin/skydeck --help`. If the `node` on your `PATH` is older than
24.12, point skydeck at a newer binary with `SKYDECK_NODE=/path/to/node`.

The design is in [docs/design.md](docs/design.md).
