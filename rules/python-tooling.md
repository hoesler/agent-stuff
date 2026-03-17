# Python Tooling Defaults

Use these tools unless the project is already configured otherwise.

- **Package management:** `uv` — not pip, not poetry. Use `uv run`, `uv add`, `uv sync`
- **Linting & formatting:** `ruff` — replaces flake8, isort, black. Use `ruff check` and `ruff format`
- **Type checking:** `ty` — not mypy, not pyright
