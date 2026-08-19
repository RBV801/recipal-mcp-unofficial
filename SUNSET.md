# Sunset plan

This repository is temporary by agreement. ReciPal is building an official MCP
server; when it ships, this one steps aside.

Writing the plan down now, while the context is fresh, so that executing it later
is mechanical.

## Why

ReciPal reviewed this project before publication and agreed to it on three
conditions:

1. Name it `recipal-mcp-unofficial`, so it cannot be mistaken for theirs.
2. No consumer-facing plugin distribution — no bundles, no marketplace listings.
3. Point at the official server and archive this one once theirs is live.

This document covers the third.

## What "archived" means

GitHub archiving makes a repository **read-only**: no new issues, pull requests,
commits, or edits. It does not delete anything, and it does not remove or affect
existing forks or clones.

Two consequences worth being clear about:

- **The README must be updated *before* archiving.** After archiving you cannot edit
  it, and you would be left with a frozen repository and no forwarding address. This
  is the easiest mistake to make here.
- **Anyone already running this keeps running it.** The code is local and does not
  phone home. Archiving stops distribution and maintenance; it does not switch
  anything off. That is why the migration note needs to be findable.

## Checklist, in order

1. **Confirm the official server is actually usable** — not just announced. Install
   it, check it covers the cases people use this for. If it does not yet handle
   something material, say so plainly in the migration note rather than pretending
   parity.
2. **Rewrite the README** as a pointer: a short notice at the top saying this project
   is retired and linking the official server, plus a brief migration note (how to
   swap the MCP client config, and anything the official server does differently).
   Keep the Known limitations section — the API quirks documented there stay true and
   may still save someone time.
3. **Add a final `CHANGELOG.md` entry** recording the retirement and the date.
4. **Close open issues and pull requests** with a comment pointing at the official
   server. Do not leave them to be silently frozen.
5. **Post a pinned issue or a final release** titled so it is obvious from the
   repository list, e.g. "Retired — use ReciPal's official MCP server". Watchers get
   notified; stargazers do not, so this is the only broadcast available.
6. **Update anything outside this repository that links here.** Your own notes and
   configs, and any comment where you mentioned it.
7. **Disable issues** in Settings, so nobody files into a void.
8. **Archive**: Settings → General → Danger Zone → Archive this repository.

Steps 2 through 6 are the ones that are impossible to do afterwards. Do not skip to 8.

## If the official server never ships

Archiving is conditional on theirs going live, so there is nothing to execute if it
does not. But do not let the interim notice quietly become false either — if a year
passes with no official server, check in with ReciPal rather than leaving a banner
promising an imminent replacement that isn't coming. Either the notice gets a date
and a status, or the arrangement gets revisited.
