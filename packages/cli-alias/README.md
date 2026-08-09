# @lyrashield/cli (deprecated)

> This scoped alias package is **deprecated** and will be removed in the next major release. Please migrate to the primary [`lyrashield`](../cli) package. This package now ships a thin `lyrashield-cli` bin shim that forwards to the `lyrashield` implementation, so existing `npx @lyrashield/cli` and `lyrashield-cli` invocations continue to work.

```sh
# before (deprecated)
npx @lyrashield/cli <command> [args]

# after
npx lyrashield <command> [args]
```

## Usage

```sh
npx @lyrashield/cli <command> [args]
```

Or install it globally:

```sh
npm install -g @lyrashield/cli
lyrashield-cli login
```

For the canonical unscoped package:

```sh
npx lyrashield <command> [args]
```

## Documentation

The command catalog, exit codes, global flags, and environment variables are documented in [`packages/cli/README.md`](../cli/README.md).
