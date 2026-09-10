# Renamed: Corp SDD → Serpens SDD

This project was called **Corp SDD** and lived at `github.com/fresh-fx59/corp-sdd`
until 2026-09-09. Everything moved in one edition. Nothing was dropped.

## What changed

| Before | Now |
|---|---|
| repository `fresh-fx59/corp-sdd` | `fresh-fx59/serpens-sdd` |
| product name **Corp SDD** | **Serpens SDD** |
| commands `corp-spec`, `corp-plan`, … | `spns-spec`, `spns-plan`, … |
| skills `corp-tdd`, `corp-debugging`, … | `spns-tdd`, `spns-debugging`, … |
| environment variables `CORP_*` | `SERPENS_*` |
| git config `corp.agentDir`, `corp.baseBranch` | `serpens.agentDir`, `serpens.baseBranch` |
| no package | `@fresh-fx59/serpens-sdd` on npm |

## Links that still work, and one that does not

**Clones and API calls redirect.** GitHub keeps the old repository path working
indefinitely, so `git clone https://github.com/fresh-fx59/corp-sdd.git` still
lands here. Update your remote at your convenience:

```bash
git remote set-url origin https://github.com/fresh-fx59/serpens-sdd.git
```

**The GitHub Pages URL does NOT redirect.** `https://fresh-fx59.github.io/corp-sdd/`
returns 404. The page is now at <https://fresh-fx59.github.io/serpens-sdd/>.

**The old download links kept working, deliberately.** `corp-sdd-starter-en.zip` and
`corp-sdd-starter-ru.zip` are still in the repository root, frozen at their
`2026-08-26.8` content, because a release zip is a file and a rename would have made
those URLs 404 with no redirect. They are **not maintained** — they will be removed one
edition from now. Use `serpens-sdd-starter-en.zip` / `serpens-sdd-starter-ru.zip`, or
better, the npm package.

## Migrating an existing install

An install made under the old name keeps working until you upgrade it; the names are
cosmetic to the workflow, not to the tooling that reads them. When you do upgrade:

1. Install the package: `npm i -g @fresh-fx59/serpens-sdd`.
2. Re-run the mechanical stages against your existing store:
   `serpens-sdd init --only 3,5,6`. It never deletes, resets, rebases or
   force-checkouts anything it finds; the commands and skills are replaced with
   their `spns-` equivalents, and the old `corp-*` files are left for you to remove
   once you have confirmed the new ones work.
3. Rename your two git config keys, if you set them by hand:

   ```bash
   git config serpens.agentDir  "$(git config corp.agentDir)"  && git config --unset corp.agentDir
   git config serpens.baseBranch "$(git config corp.baseBranch)" && git config --unset corp.baseBranch
   ```

4. Any `CORP_*` environment variable you export becomes `SERPENS_*`. Nothing reads the
   old names any more — an unrenamed variable is silently ignored, so grep your shell
   profile and your CI configuration for `CORP_`.
5. `docs/UPGRADE.md` in `en/` (or `ru/`) covers the rest, including the per-repository
   files a newer edition requires.
