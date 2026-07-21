## Fixed

- Wire Content publication and upload confirmation to the durable Attachment storage boundary:
  both flows serialize on the live Content root, publication validates current body/cover bindings,
  Provider evidence remains outside database transactions, and publish-vs-confirm races converge
  without binding an Attachment back into a Content item that won the publish transition. The same
  final root reread also covers content tokens sent through the generic Attachment confirm route.

## Not included

- No schema, migration, endpoint, DTO, BizCode, permission, provider, cron, release, version, tag,
  deployment, repository-wide raw-key closure, or full published-Content immutability change.
