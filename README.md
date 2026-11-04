<p align="center">
  <img src="https://raw.githubusercontent.com/vitrine-org/vitrine/main/assets/icon/vitrine.svg" width="88" alt="">
</p>

<h1 align="center">Vitrine Store</h1>

<p align="center">The catalogue of widget packs for <a href="https://github.com/vitrine-org/vitrine">Vitrine</a>.</p>

The store is a list of GitHub repositories. Every few hours, a workflow reads the latest release of
each one and checks its `.vitrine` package. It then publishes the catalogue that the Vitrine control
panel and the website read:

- `https://vitrine-org.github.io/store/index.json`: packs, versions, download URLs, SHA-256, widgets
- `https://vitrine-org.github.io/store/previews/<pack>/<widget>.png`: widget previews

Packages are downloaded from the authors' own GitHub releases. Vitrine checks the SHA-256 from the
catalogue before installing.

## Add your pack

1. Build your pack with the [SDK](https://github.com/vitrine-org/sdk): `npm run pack` makes
   `<name>-<version>.vitrine`.
2. Publish a GitHub release in a **public** repository. Tag it `v<version>` and attach the
   `.vitrine` file as the only `.vitrine` asset.
3. Open a pull request here that adds `packs/<your pack id>.json`:

   ```json
   {
     "id": "dev.you.widgets",
     "repo": "you/my-widgets",
     "license": "MIT",
     "tags": ["clock", "minimal"]
   }
   ```

The checks on the pull request download your latest release and validate it:

- the package is a zip with safe paths and is 50 MB or smaller;
- `vitrine.json` has the same `id` as the entry and the same `version` as the release tag;
- every widget has a preview image.

New versions need no pull request: publish a new release and the store picks it up within a few hours.

| Field | Required | |
| --- | --- | --- |
| `id` | yes | Reverse-DNS id from your `vitrine.json`; the file name is `<id>.json`. |
| `repo` | yes | `owner/name` of the GitHub repository with the releases. |
| `license` | no | SPDX id; defaults to the repository's license. |
| `tags` | no | Up to 6 lowercase words, used for search. |

Name, author, description and widgets come from your package's `vitrine.json`, so they are always
in sync with what users install.

## Review

Pull requests are reviewed by hand before merging. We check that permissions are the minimum the
widgets need, that network hosts are explained, and that you can distribute everything in the pack,
including fonts and images. Packs can be removed if a later release breaks these rules.

## Run locally

```sh
node --test scripts/build-index.test.mjs
GITHUB_TOKEN=$(gh auth token) node scripts/build-index.mjs --out site
```
