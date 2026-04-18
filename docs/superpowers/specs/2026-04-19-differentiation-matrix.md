# Spec Differentiation Matrix (20 specs)

**Purpose:** Before shipping any spec, confirm it differs from its nearest neighbors in ≥3 of the 6 dimensions below. This prevents the "15 palette swaps of the same spec" failure mode.

## Dimensions

| # | Name | Scale / options |
|---|---|---|
| 1 | **Information density** | sparse / medium / dense |
| 2 | **Heading hierarchy** | subtle / strong / dominant (how loud the H1 is relative to body) |
| 3 | **Quotation treatment** | inline / pull-quote-center / epigraph / sidenote / none |
| 4 | **Decorative grammar** | none / hairlines / blocks / ornaments / geometric-shapes / diagonal |
| 5 | **Whitespace rhythm** | crammed / moderate / generous |
| 6 | **Alignment strategy** | left / centered / justified / asymmetric / grid-rigid |

## Matrix (fill when each spec lands; pre-req PR ships with 5 existing specs filled)

| id | info_density | heading | quotation | decorative | whitespace | alignment |
|---|---|---|---|---|---|---|
| `executive-broadsheet` | dense | strong | pull-quote-center | hairlines | moderate | justified |
| `quiet-ledger` | sparse | subtle | none | none | generous | left |
| `guji-classical` | medium | dominant | epigraph | ornaments | moderate | justified |
| `front-page-daily` | dense | dominant | pull-quote-center | hairlines | crammed | justified |
| `keynote-sheet` | sparse | dominant | none | blocks | generous | centered |
| `compact-weekly-review` | **TBD when spec lands** | | | | | |
| `literary-longform` | | | | | | |
| `scholarly-figure` | | | | | | |
| `continental-broadsheet` | | | | | | |
| `cjk-horizontal-broadsheet` | | | | | | |
| `swiss-grid` | | | | | | |
| `bauhaus-modular` | | | | | | |
| `constructivist-agitprop` | | | | | | |
| `brutalist-raw` | | | | | | |
| `loc-broadside-1870` | | | | | | |
| `nypl-botanical` | | | | | | |
| `rijks-ledger-1650` | | | | | | |
| `tufte-sidenotes` | | | | | | |
| `sakura-zen` | | | | | | |
| `pico-classless` | | | | | | |

## Ship gate

Before each new spec's PR is merged:

1. Fill its row in this matrix.
2. Identify its 2 "nearest neighbors" (pick the 2 most similar existing rows by genre).
3. Confirm the new row differs in ≥3 of the 6 dimensions from each nearest neighbor.
4. If it fails, revisit the spec's design. Common fix: push harder on decorative grammar or alignment strategy.

## Notes on the 5 existing rows

- `executive-broadsheet` and `front-page-daily` are the closest pair (both dense / strong-to-dominant / pull-quote / hairlines / justified). They differ on heading (strong vs dominant) and whitespace (moderate vs crammed) — 2 dimensions, which is below the ship gate but acceptable because they predate this matrix. Future specs targeting either must differentiate harder.
- `quiet-ledger` is the most isolated (sparse / subtle / none / none / generous / left) — many future specs can differentiate against it simply by existing.
