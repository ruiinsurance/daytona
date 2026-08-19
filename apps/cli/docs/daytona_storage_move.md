## daytona storage move

Request a workspace move through the control plane

```
daytona storage move [SANDBOX_ID] [flags]
```

### Options

```
      --fence-epoch string       current fencing epoch
      --idempotency-key string   retry key for this move request
      --operation-id string      idempotent move operation UUID
      --placement-id string      workspace placement UUID
      --source-node-id string    current owner node UUID
      --target-node-id string    verified target node UUID
      --volume-id string         workspace volume UUID
```

### Options inherited from parent commands

```
      --help   help for daytona
```

### SEE ALSO

* [daytona storage](daytona_storage.md)  - Manage local-first storage through the Daytona control plane
