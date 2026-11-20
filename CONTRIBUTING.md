# Contributing to Quillipi

Thank you for helping. Fixes, improvements and new features are all welcome; once one is merged,
everyone who runs Quillipi gets it with the next release.

## Before you start

- **A security problem?** Don't open an issue or a pull request. Report it privately, as
  [SECURITY.md](SECURITY.md) explains.
- **A bug** gets an issue: what you did, what you expected, what happened, and the version from
  your Quillipi's `/status`.
- **A larger change** (a new feature, a change to how notebooks are stored, a new dependency)
  starts with an issue, so we can agree on the shape before you spend time on it.
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how Quillipi is built and why.

## Making a change

1. Fork the repository and make a branch.
2. `npm ci`, then `npm run build` and `npm test`. Everything must pass before and after your change.
3. Keep the change to one purpose. Code is readable and simple, with no dead code; comments say
   why, not what. A change to the notebook format or to how edits merge comes with tests.
4. Open a pull request that says what changed and why. Its checks run once a maintainer approves
   them.

Releases, versions and the release pin (`deploy/quillipi-release.json`) are done by the
maintainer, so leave them as they are.

## The contributor agreement

The first time you open a pull request, a bot asks you to sign the
[Contributor License Agreement](CLA.md) with one click. You keep the copyright in your work; the
agreement lets Quillipi include it, under Quillipi's license and in paid versions for teams. A pull
request can be merged only once it is signed.

## License

By contributing, you agree that your contribution is licensed as the [CLA](CLA.md) says.
Quillipi itself is source-available under the [PolyForm Shield License 1.0.0](LICENSE).
