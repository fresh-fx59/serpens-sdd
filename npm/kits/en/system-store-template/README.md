# Serpens SDD system store

This repository owns cross-repository contracts and the project repository map.
Bound repositories are registered as Git submodules under `submodules/`.

Do not edit submodule registrations by hand. Feed the normalized discovery
result to `tools/serpens-sdd sync-submodules --repos-from -` on stdin (or
`--inventory <path>`, for a JSON file); `.gitmodules` is the durable list, not a
separate `project-repositories.json`.
