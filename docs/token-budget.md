# Fleet token budget

Measured at the Fleet protocol change on 2026-07-12. Byte counts are UTF-8
JSON wire sizes; provider-reported model tokens remain Fleet run artifacts.

| Path | Baseline | Fleet path | Result |
| --- | ---: | ---: | ---: |
| MCP `tools/list` | 29,724 B (`fc773cc`) | 5,393 B scoped/core | 18.1% of baseline |
| 200-line incremental semantic pull | 5,115 B repeated snapshot | 122 B lean frame | 2.4% |
| 1 new capture after 1,000 entries | 38,894 B full buffer | 83 B cursor result | 0.21% |
| Locator action | `find` + ref action | one `act` request returning `{ok:true,traceId}` | 1 request |

The expanded full MCP surface is 32,983 B because it also documents `act`,
capture cursors, and lean streams. Fleet does not use it: Fleet imports the
direct `DebuggerClient`. The scoped/core profile is 16.4% of that full surface,
comfortably below the 40% acceptance ceiling.

The semantic measurement uses a deterministic 200-line compact tree with one
changed line. Capture measurement uses a full 1,000-entry bounded buffer and a
single entry after cursor 999. Regression tests enforce the MCP ratio, cursor
semantics, and snapshot omission; these numbers are an auditable representative
measurement rather than a billing-token estimate.
