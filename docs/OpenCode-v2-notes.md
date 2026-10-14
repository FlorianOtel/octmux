---
title: "OpenCode v2 notes"
created_at: 2026-10-14--13-13
created_by: Claude Code (Claude Opus 5.5)
context: >
  Notes on how the OpenCode v2 server (2.0.28) behaves when octmux uses it, beyond the wire shapes in
  docs/OpenCode-v2-protocol-capture.md. Started in session "OpenCode-v2-API--bug-fixes" after the
  operator ran octmux against the MBP v2 server (macOS, a different host). octmux sent its Linux path
  /mnt/nfs/Florian/Gin-AI/projects/octmux, and the OpenCode desktop app then showed "Session location
  unavailable". The operator asked how octmux should work when client and server directory trees
  differ (the normal case), who defines a project, and how dozens of clients with different users,
  trees and projects would work. That last answer is recorded here under "Known Limitations". The
  octmux fix (location check, server.directoryMap) is Stage 15.2.1 in docs/Stage15.md.
---

# OpenCode v2 notes

## Known Limitations

### 2026-10-14--13-13 — One OpenCode server is one tenant

OpenCode v2 has no notion of tenants. One server is one OS user's agent host, and every client
attached to it has that user's full authority. Isolating different users cannot happen inside one
OpenCode server. It has to happen between servers: one server per tenant. Within one tenant, the
directory question becomes "which project on the server?", not "where am I on the client?".

**Why one shared server cannot isolate tenants** (from the v2 API surface, 2.0.28):

- **Auth is one shared password.** HTTP Basic, user `opencode` (`src/auth-headers.ts`). The server has
  no user identity, so it has nothing to scope by.
- **The event stream is global.** `/api/event` is not filtered by location
  (`docs/OpenCode-v2-protocol-capture.md` §3 records frames from other sessions and directories on
  the same connection). Every client sees every other client's work.
- **Tools run as the server's OS user.** bash, edit and shell reach anything that user can reach,
  whatever `location` a session was given. `location` scopes context, not permissions.
- **Projects can be listed and updated, not deleted.** `project.list` and `project.update` exist; there
  is no delete. Records accumulate. A `session.create` at a directory the server does not have still
  records a project for it (seen on the MBP for `/mnt/nfs/...` paths).
- **Workspaces are not a tenancy mechanism.** `workspaceID` on `LocationRef` appears only in
  connection events (`workspace.ready`, `workspace.failed`); clients have no API to create one.
  `Project.sandboxes` appears to be a project's worktree list.

So "dozens of users on one OpenCode server" means everyone gets everyone's files, credentials,
provider API keys and event stream.

**How client files and server files can relate:**

| Model | How it works | Verdict |
|---|---|---|
| A. Shared storage (NFS or synced trees) | Client path → server path by mapping | Fine for one user on several machines (octmux `server.directoryMap`). Does not generalise. |
| B. The server owns the checkout | The project lives on the server; the client is a pure remote UI, as in VS Code Remote or Codespaces | The general case. The client's local tree does not matter. |
| C. The client owns the files, the server runs the agent | The server's tools would need the client's filesystem | Not possible: OpenCode tools run on the server. It would need a sync layer. |

Under model B, the server or its administrator defines projects. A client chooses one; it does not
create one. Project identity should be the repository (git root commit or remote URL), not a path
string: path strings differ on every machine, repository identity does not.

**Balancing growth against isolation**, two levels kept apart:

1. **Between tenants: one OpenCode server per tenant**, as an OS user or a container, behind a router
   keyed by tenant. Strong isolation of files, credentials, MCP servers and events. The cost is one
   server process per tenant; its MCP and LSP servers multiply with it, which is the practical limit
   on how far this scales.
2. **Within a tenant: one checkout per repository, plus short-lived worktrees.** The number of server
   directories grows with projects × concurrent tasks, not with clients or launches. Many clients
   (octmux, the desktop app, web, phone) share the tenant's server; that is OpenCode's intended
   multi-client model. Per-session worktrees (`worktree.create`) separate concurrent edits; they are
   not a security boundary.

Server directories should come from deliberate provisioning (clone, worktree), never as a side effect
of a client starting up. The placeholder projects octmux created on the MBP before Stage 15.2.1 are
the failure mode that does not scale.

**What this means for octmux.** octmux is a client of one tenant's server, and it switches servers
with separate config files (`octmux.json`, `octmux-nucbox.json`). It resolves the server location as:
`server.directory`, else `server.directoryMap` applied to the working directory, else the working
directory; then it checks the location with `location.get` and refuses to create anything at a path
the server does not have. Choosing a server project explicitly (`--project`) or by repository
identity, for setups with no shared storage, is not scheduled. Whether v2 still uses the git root
commit as the project id for git repositories is unverified. Provisioning a project on a server
(clone and register) belongs to the server's owner (oconona or an administrator), not to octmux.
