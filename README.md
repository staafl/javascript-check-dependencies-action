# JavaScript Dependency Check

This action checks that no compromised packages are referenced in any package-lock.json files in your repository, using a list of bad versions that's fetched from a URL of your choice.

## Configuration options

- **`rules_url` (required):** URL pointing to a JSON file with the banned package versions:

```json
[
  ["@acme/bad", "1.0.*", "^1.1.2"],
  ["evil-package", "*"]
]
```

## Usage

```yaml
name: Check package-lock for compromised dependencies

on:
  push:
    branches: [ main, master ]
  pull_request:

jobs:
  check-lock:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run package-lock check
        uses: InteropIO/javascript-check-dependencies-action@v0.0.4
        with:
          rules_url: https://raw.githubusercontent.com/InteropIO/javascript-check-dependencies-action/refs/heads/master/bad-deps.json

```

There's also a reusable workflow version you can invoke:

```yaml
jobs:
  check-package-jsons:
    uses: InteropIO/javascript-check-dependencies-action/.github/workflows/check-deps-reusable.yaml@master
    permissions:
      contents: read
    ## optional
    # with:
    # runs-on: ubuntu-latest
    # rules_url: https://raw.githubusercontent.com/InteropIO/javascript-check-dependencies-action/refs/heads/master/bad-deps.json

```