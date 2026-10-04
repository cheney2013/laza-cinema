"""The media files that go with a project when it is deleted.

A project's files are the ones its canvas, timelines and sequences mention (any
node, any take) plus the ones the origin ledger says it made. A file that any
other project also mentions stays: duplicating a project shares every file, and
deleting the copy must not break the original. A clip's latent follows the clip
unless another project holds the latent.
"""
from __future__ import annotations

from pathlib import Path

from artifact_pruner import collect_references, pair_names


def plan(workspaces: Path, project_id: str, origins: dict[str, dict],
         references: dict[str, set[str]] | None = None) -> dict:
    """Names to delete with `project_id`, and how many of its files are kept as shared.

    references: collect_references(workspaces) when the caller already has it.
    """
    if references is None:
        references = collect_references(workspaces)

    mine = {name for name, projects in references.items() if project_id in projects}
    made_here = {
        name for name, origin in origins.items()
        if origin.get("project_id") == project_id and name not in references
    }
    shared = {name for name in mine if references[name] - {project_id}}
    owned = (mine - shared) | made_here

    def held_elsewhere(name: str) -> bool:
        return bool(references.get(name, set()) - {project_id})

    companions = {c for name in owned for c in pair_names(name)} - owned
    return {
        "files": sorted(owned),
        "companions": sorted(c for c in companions if not held_elsewhere(c)),
        "shared": sorted(shared),
    }
