# License scope and existing notices

The root [LICENSE](LICENSE) is the custom RECAST Non-Commercial License for
project-owned material offered under it. It does not replace separate licenses
or withdraw permissions already granted for previously licensed material.

## Historical extension metadata

Before this change, `apps/vscode-extension/package.json` declared `MIT`, also
recorded in the root lockfile. That declaration was introduced in commit
`e309dcaea` and remains visible in Git history, including the pre-change main
commit `d6b17b319b49d3b27fcf10f8c1ebee69763d3a75`.

Changing current package metadata does not revoke any valid historical MIT
grant or restrict uses already permitted by that grant. The new non-commercial
terms cannot be used to claim that all historical RECAST code is now prohibited
from commercial use. Existing third-party notices and separately licensed
material must continue to accompany copies where their licenses require it.

## Separately licensed material

- `fixtures/code-corpus/` and `fixtures/target-system/` contain independently
  licensed fixtures, including MIT and Apache-2.0 material. Their local LICENSE,
  NOTICE, UPSTREAM files and source headers remain authoritative for that material.
- `services/translation-verifier/e2e/fixtures/commons-fileupload-read-body-data/`
  contains Apache Commons FileUpload-derived fixtures. Their existing Apache
  licenses, NOTICE files and source headers remain unchanged.
- External dependencies retain their own licenses. Package metadata and lockfile
  entries for third-party dependencies are not replaced by the project license.

This notice is a scope guide, not a comprehensive dependency license audit or
proof of ownership. Maintain applicable notices when redistributing material.
